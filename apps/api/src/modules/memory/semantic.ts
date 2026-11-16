import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../http/errors.js';
import { requestEncoding, validateEncoderUrl } from '../conversations/routing/encoder.js';
import type { MemoryRecord, MemorySources } from './types.js';

/** Explicit deployment configuration; binding is the encoder's verified manifest SHA-256. */
export interface MemorySemanticConfig {
  encoderUrl: string;
  bindingSha256: string;
  deadlineMs: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export function loadMemorySemanticConfig(env: NodeJS.ProcessEnv): MemorySemanticConfig | undefined {
  const url = env.MEMORY_ENCODER_URL;
  const binding = env.MEMORY_ENCODER_BINDING_SHA256;
  const deadline = env.MEMORY_ENCODER_DEADLINE_MS;
  if (url === undefined && binding === undefined && deadline === undefined) return undefined;
  if (
    !url ||
    !binding ||
    !deadline ||
    !/^[a-f0-9]{64}$/.test(binding) ||
    !/^[1-9][0-9]*$/.test(deadline) ||
    !Number.isSafeInteger(Number(deadline))
  )
    throw new Error('invalid memory encoder configuration');
  validateEncoderUrl(url);
  return { encoderUrl: url, bindingSha256: binding, deadlineMs: Number(deadline) };
}
export interface MemoryIndexResult {
  indexed: number;
  failed: number;
  nextCursor: string | null;
}
export class MemorySourceFailure extends Error {}
interface AuthorizedRow {
  id: string;
  revision: number;
  conversation_id: string;
  message_ids: string[];
  summary_id: string | null;
}
interface CandidateRow extends AuthorizedRow {
  owner_id: string;
  content: string;
  source_kind: 'explicit' | 'compact';
  status: 'active';
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
function isInaccessible(error: unknown): boolean {
  return error instanceof HttpError && (error.httpStatus === 403 || error.httpStatus === 404);
}
function asRecord(row: CandidateRow): MemoryRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    messageIds: row.message_ids,
    content: row.content,
    sourceKind: row.source_kind,
    summaryId: row.summary_id,
    revision: row.revision,
    status: row.status,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function sourceInput(ownerId: string, row: AuthorizedRow) {
  return {
    ownerId,
    conversationId: row.conversation_id,
    messageIds: row.message_ids,
    purpose: 'read' as const,
    ...(row.summary_id ? { summaryId: row.summary_id } : {}),
  };
}
async function encode(
  config: MemorySemanticConfig,
  text: string,
  signal?: AbortSignal,
): Promise<number[]> {
  if (
    !/^[a-f0-9]{64}$/.test(config.bindingSha256) ||
    !Number.isFinite(config.deadlineMs) ||
    config.deadlineMs <= 0
  )
    throw new Error('invalid memory encoder configuration');
  const result = await requestEncoding({
    text,
    binding: config.bindingSha256,
    url: validateEncoderUrl(config.encoderUrl),
    signal: signal ?? new AbortController().signal,
    deadlineMs: config.deadlineMs,
    fetch: config.fetch ?? fetch,
  });
  return Array.from(result.vector);
}
async function vectorNamespace(client: PoolClient): Promise<string> {
  const result = await client.query<{
    namespace: string;
  }>(`SELECT n.nspname AS namespace FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`);
  if (!result.rows[0]) throw new Error('pgvector unavailable');
  return `"${result.rows[0].namespace.replaceAll('"', '""')}"`;
}

// Services can be recreated per request, so progress belongs to the pool, not the service.
// Weak pool keys and an LRU bound prevent unbounded state. A generation prevents
// overlapping recalls from rewinding another recall's progress.
const poolProgress = new WeakMap<
  Pool,
  Map<string, { cursor: string | null; degraded: boolean; generation: number }>
>();

export function createMemorySemantic(deps: {
  pool: Pool;
  sources: MemorySources;
  config: MemorySemanticConfig;
  list: (
    ownerId: string,
    input: { limit?: number; cursor?: string },
  ) => Promise<{ items: MemoryRecord[]; nextCursor: string | null }>;
}) {
  async function indexItem(
    ownerId: string,
    item: MemoryRecord,
    deadlineMs = deps.config.deadlineMs,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const embedding = await encode({ ...deps.config, deadlineMs }, item.content, signal);
    return withTransaction(deps.pool, async (client) => {
      const result = await client.query<AuthorizedRow>(
        `SELECT m.id, r.revision, r.conversation_id, r.message_ids, r.summary_id
        FROM r3_memories m JOIN r3_memory_revisions r ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=m.current_revision
        WHERE m.owner_id=$1 AND m.id=$2 AND m.current_revision=$3 AND m.status='active'
          AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp()) FOR UPDATE OF m`,
        [ownerId, item.id, item.revision],
      );
      const row = result.rows[0];
      if (!row) return false;
      await deps.sources.validate(client, sourceInput(ownerId, row));
      await client.query(
        `INSERT INTO r3_memory_vectors(owner_id,memory_id,revision,binding_sha256,embedding)
        VALUES ($1,$2,$3,$4,$5::real[]) ON CONFLICT (owner_id,memory_id,revision,binding_sha256)
        DO UPDATE SET embedding=EXCLUDED.embedding,indexed_at=clock_timestamp()`,
        [ownerId, item.id, item.revision, deps.config.bindingSha256, embedding],
      );
      return true;
    });
  }

  // Bound work per recall; later recalls advance through remaining revisions.
  async function indexMissing(ownerId: string, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + 1000;
    let progress = poolProgress.get(deps.pool);
    if (!progress) {
      progress = new Map();
      poolProgress.set(deps.pool, progress);
    }
    const progressKey = `${ownerId}:${deps.config.bindingSha256}`;
    let state = progress.get(progressKey);
    if (state) progress.delete(progressKey);
    else state = { cursor: null, degraded: false, generation: 0 };
    progress.set(progressKey, state);
    if (progress.size > 1024) progress.delete(progress.keys().next().value!);
    let generation = state.generation;
    const startCursor = state.cursor;
    const pending = await withTransaction(deps.pool, async (client) => {
      const authorized: MemoryRecord[] = [];
      let after: string | null = startCursor;
      let wrapped = false;
      while (authorized.length < 20) {
        const result: { rows: CandidateRow[] } = await client.query<CandidateRow>(
          `SELECT m.id,m.owner_id,m.status,m.created_at,m.updated_at,
            r.revision,r.conversation_id,r.message_ids,r.summary_id,r.content,r.source_kind,r.expires_at
          FROM r3_memories m JOIN r3_memory_revisions r
            ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=m.current_revision
          LEFT JOIN r3_memory_vectors v ON v.owner_id=m.owner_id AND v.memory_id=m.id
            AND v.revision=r.revision AND v.binding_sha256=$2
          WHERE m.owner_id=$1 AND m.status='active'
            AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp()) AND v.memory_id IS NULL
            AND ($3::uuid IS NULL OR m.id > $3::uuid)
          ORDER BY m.id LIMIT 100`,
          [ownerId, deps.config.bindingSha256, after],
        );
        for (const row of result.rows) {
          try {
            await deps.sources.validate(client, sourceInput(ownerId, row));
            authorized.push(asRecord(row));
            if (authorized.length === 20) break;
          } catch (error) {
            if (!isInaccessible(error))
              throw new MemorySourceFailure('memory source unavailable', { cause: error });
          }
        }
        if (result.rows.length < 100) {
          if (authorized.length === 0 && startCursor !== null && !wrapped) {
            after = null;
            wrapped = true;
            continue;
          }
          break;
        }
        after = result.rows[result.rows.length - 1]!.id;
      }
      return authorized;
    });
    signal?.throwIfAborted();
    if (pending.length === 0 && state.generation === generation) {
      state.cursor = null;
      state.degraded = false;
      state.generation++;
    }
    let complete = true;
    for (const item of pending) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        if (!(await indexItem(ownerId, item, Math.min(deps.config.deadlineMs, remaining), signal)))
          complete = false;
      } catch {
        signal?.throwIfAborted();
        complete = false;
      }
      if (!complete) state.degraded = true;
      if (state.generation === generation) {
        state.cursor = item.id;
        generation = ++state.generation;
      }
    }
    return complete && !state.degraded;
  }

  async function rebuild(
    ownerId: string,
    input: { limit: number; cursor?: string },
  ): Promise<MemoryIndexResult> {
    // list validates owner and bounded batch before any external request.
    const page = await deps.list(ownerId, input);
    let indexed = 0;
    let failed = 0;
    for (const item of page.items) {
      try {
        const saved = await indexItem(ownerId, item);
        if (saved) indexed++;
        else failed++;
      } catch {
        failed++;
      }
    }
    return { indexed, failed, nextCursor: page.nextCursor };
  }
  async function search(
    ownerId: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ items: MemoryRecord[] }> {
    // Never hold DB locks or a transaction while waiting for the encoder.
    const embedding = await encode(deps.config, query, signal);
    const identifier = query.match(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+/)?.[0] ?? '';
    return withTransaction(deps.pool, async (client) => {
      const ns = await vectorNamespace(client);
      await client.query(
        'CREATE TEMP TABLE memory_authorized (id uuid NOT NULL, revision integer NOT NULL, PRIMARY KEY(id,revision)) ON COMMIT DROP',
      );
      let after: string | null = null;
      for (;;) {
        const page: { rows: AuthorizedRow[] } = await client.query<AuthorizedRow>(
          `SELECT m.id,r.revision,r.conversation_id,r.message_ids,r.summary_id
          FROM r3_memories m JOIN r3_memory_revisions r ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=m.current_revision
          WHERE m.owner_id=$1 AND m.status='active' AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
            AND ($2::uuid IS NULL OR m.id > $2::uuid) ORDER BY m.id LIMIT 100`,
          [ownerId, after],
        );
        for (const row of page.rows) {
          try {
            await deps.sources.validate(client, sourceInput(ownerId, row));
          } catch (error) {
            if (isInaccessible(error)) continue;
            throw new MemorySourceFailure('memory source unavailable', { cause: error });
          }
          await client.query('INSERT INTO memory_authorized(id,revision) VALUES($1,$2)', [
            row.id,
            row.revision,
          ]);
        }
        if (page.rows.length < 100) break;
        after = page.rows[page.rows.length - 1]!.id;
      }
      // Whole identifier boundaries keep XQ-4792 distinct from XQ-47920 and XQ-4793.
      const pattern = identifier ? `(^|[^A-Za-z0-9_-])${identifier}([^A-Za-z0-9_-]|$)` : null;
      const rows = await client.query<CandidateRow>(
        `SELECT m.id,m.owner_id,m.status,m.created_at,m.updated_at,
          r.revision,r.conversation_id,r.message_ids,r.summary_id,r.content,r.source_kind,r.expires_at
        FROM memory_authorized a JOIN r3_memories m ON m.id=a.id AND m.owner_id=$1 AND m.current_revision=a.revision
        JOIN r3_memory_revisions r ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=a.revision
        LEFT JOIN r3_memory_vectors v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.revision=a.revision AND v.binding_sha256=$2
        WHERE m.status='active' AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
          AND (v.memory_id IS NOT NULL OR ($3::text IS NOT NULL AND r.content ~* $3))
        ORDER BY CASE WHEN $3::text IS NOT NULL AND r.content ~* $3 THEN 0 ELSE 1 END,
          (v.embedding::${ns}.vector OPERATOR(${ns}.<=>) $4::real[]::${ns}.vector) ASC NULLS LAST, m.id
        LIMIT $5`,
        [ownerId, deps.config.bindingSha256, pattern, embedding, limit],
      );
      return { items: rows.rows.map(asRecord) };
    });
  }
  return { rebuild, search, indexMissing };
}
