import { httpStatusForError } from '@along/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import {
  ApplicationError,
  isUuid,
  notFound,
  notReady,
  stateConflict,
  validationError,
} from '../../platform/errors.js';
import {
  createMemorySemantic,
  MemorySourceFailure,
  type MemoryIndexResult,
  type MemorySemanticConfig,
} from './recall/semantic.js';
import { validateMemoryRevisions } from './recall/authorization.js';
import type { MemoryRecord, MemorySources } from './types.js';
export type { MemorySemanticConfig } from './recall/semantic.js';

export interface RememberInput {
  conversationId: string;
  messageIds: string[];
  content: string;
  idempotencyKey: string;
  expiresAt?: string | null;
}
export interface CompactInput extends RememberInput {
  summaryId: string;
}
export interface CorrectionInput {
  conversationId: string;
  messageIds: string[];
  content: string;
  expiresAt?: string | null;
  expectedRevision: number;
}
export interface MemoryRecallResult {
  items: (MemoryRecord & { match: 'literal' | 'semantic' | 'unfiltered' })[];
  completeness: 'degraded' | 'incomplete';
  candidateOnly: true;
}
export interface MemoryService {
  remember(ownerId: string, input: RememberInput): Promise<MemoryRecord>;
  rememberCompact(ownerId: string, input: CompactInput): Promise<MemoryRecord>;
  /** The caller owns BEGIN/COMMIT and must not confirm a save before COMMIT succeeds. */
  rememberInTransaction(
    client: PoolClient,
    ownerId: string,
    input: RememberInput,
  ): Promise<MemoryRecord>;
  rememberCompactInTransaction(
    client: PoolClient,
    ownerId: string,
    input: CompactInput,
  ): Promise<MemoryRecord>;
  list(
    ownerId: string,
    input: { limit?: number; cursor?: string },
  ): Promise<{ items: MemoryRecord[]; nextCursor: string | null }>;
  recall(
    ownerId: string,
    input: { query: string; limit?: number },
    signal?: AbortSignal,
    allowUnfiltered?: boolean,
  ): Promise<MemoryRecallResult>;
  validateRecallInTransaction(
    client: PoolClient,
    ownerId: string,
    items: { id: string; revision: number }[],
  ): Promise<void>;
  rebuildIndex(
    ownerId: string,
    input: { limit: number; cursor?: string },
  ): Promise<MemoryIndexResult>;
  get(ownerId: string, memoryId: string): Promise<MemoryRecord | null>;
  correct(ownerId: string, memoryId: string, input: CorrectionInput): Promise<MemoryRecord>;
  stopRecall(ownerId: string, memoryId: string, expectedRevision: number): Promise<void>;
}
type Row = {
  id: string;
  owner_id: string;
  conversation_id: string;
  message_ids: string[];
  content: string;
  source_kind: 'explicit' | 'compact';
  summary_id: string | null;
  revision: number;
  status: 'active' | 'stopped';
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
const projection = `m.id, m.owner_id, r.conversation_id, r.message_ids, r.content,
  r.source_kind, r.summary_id, r.revision, m.status, r.expires_at, m.created_at, m.updated_at`;
const join = `FROM r3_memories m JOIN r3_memory_revisions r
  ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=m.current_revision`;
function record(row: Row): MemoryRecord {
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
function validateOwner(ownerId: string): void {
  if (!isUuid(ownerId)) throw validationError('invalid owner');
}
function validateInput(input: {
  conversationId: string;
  messageIds: string[];
  content: string;
  expiresAt?: string | null;
}): void {
  if (
    !isUuid(input.conversationId) ||
    !Array.isArray(input.messageIds) ||
    input.messageIds.length < 1 ||
    input.messageIds.length > 128 ||
    input.messageIds.some((id) => !isUuid(id)) ||
    new Set(input.messageIds.map((id) => id.toLowerCase())).size !== input.messageIds.length ||
    typeof input.content !== 'string' ||
    !input.content.trim() ||
    input.content.length > 12000 ||
    (input.expiresAt != null &&
      (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))))
  ) {
    throw validationError('invalid memory input');
  }
}
function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw validationError('invalid revision');
}
function inaccessible(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    (httpStatusForError(error.code) === 403 || httpStatusForError(error.code) === 404)
  );
}

export function createMemoryService({
  pool,
  sources,
  semantic: semanticConfig,
}: {
  pool: Pool;
  sources: MemorySources;
  semantic?: MemorySemanticConfig;
}): MemoryService {
  async function checkSource(client: PoolClient, ownerId: string, row: Row): Promise<void> {
    await sources.validate(client, {
      ownerId,
      conversationId: row.conversation_id,
      messageIds: row.message_ids,
      purpose: 'read',
      ...(row.summary_id ? { summaryId: row.summary_id } : {}),
    });
  }
  async function load(
    client: PoolClient,
    ownerId: string,
    memoryId: string,
    lock = false,
  ): Promise<Row | null> {
    const { rows } = await client.query<Row>(
      `SELECT ${projection} ${join}
      WHERE m.owner_id=$1 AND m.id=$2 AND m.status='active'
      AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp()) ${lock ? 'FOR UPDATE OF m' : ''}`,
      [ownerId, memoryId],
    );
    return rows[0] ?? null;
  }
  async function save(
    client: PoolClient,
    ownerId: string,
    input: RememberInput | CompactInput,
    kind: 'explicit' | 'compact',
  ): Promise<MemoryRecord> {
    validateOwner(ownerId);
    validateInput(input);
    if (
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 200 ||
      (kind === 'compact' && (!('summaryId' in input) || !isUuid(input.summaryId)))
    )
      throw validationError('invalid memory request');
    const summaryId = kind === 'compact' ? (input as CompactInput).summaryId : null;
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          kind,
          input.conversationId,
          input.messageIds,
          input.content,
          input.expiresAt ?? null,
          summaryId,
        ]),
      )
      .digest('hex');
    // Serialize even when the key does not exist yet; hash collisions only serialize unrelated requests.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      ownerId.toLowerCase(),
      input.idempotencyKey,
    ]);
    const existing = await client.query<{ request_hash: string; memory_id: string }>(
      'SELECT request_hash, memory_id FROM r3_memory_requests WHERE owner_id=$1 AND idempotency_key=$2',
      [ownerId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash)
        throw stateConflict('memory idempotency key reused');
      const row = await load(client, ownerId, existing.rows[0].memory_id, true);
      if (!row) throw stateConflict('memory is no longer recallable');
      if (row.revision !== 1) throw stateConflict('memory has since been corrected');
      await checkSource(client, ownerId, row);
      return record(row);
    }
    await sources.validate(client, {
      ownerId,
      conversationId: input.conversationId,
      messageIds: input.messageIds,
      purpose: kind,
      ...(summaryId ? { summaryId } : {}),
    });
    const id = randomUUID();
    await client.query(
      `INSERT INTO r3_memories(id,owner_id,current_revision,status) VALUES ($1,$2,1,'active')`,
      [id, ownerId],
    );
    await client.query(
      `INSERT INTO r3_memory_revisions(owner_id,memory_id,revision,conversation_id,message_ids,content,source_kind,summary_id,expires_at)
      VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
      [
        ownerId,
        id,
        input.conversationId,
        input.messageIds,
        input.content,
        kind,
        summaryId,
        input.expiresAt ?? null,
      ],
    );
    await client.query(
      'INSERT INTO r3_memory_requests(owner_id,idempotency_key,request_hash,memory_id) VALUES ($1,$2,$3,$4)',
      [ownerId, input.idempotencyKey, hash, id],
    );
    // Return the actual inserted row, even if an explicitly supplied expiry is already past.
    const { rows } = await client.query<Row>(
      `SELECT ${projection} ${join} WHERE m.owner_id=$1 AND m.id=$2`,
      [ownerId, id],
    );
    return record(rows[0]!);
  }
  async function rememberInTransaction(
    client: PoolClient,
    ownerId: string,
    input: RememberInput,
  ): Promise<MemoryRecord> {
    return save(client, ownerId, input, 'explicit');
  }
  async function rememberCompactInTransaction(
    client: PoolClient,
    ownerId: string,
    input: CompactInput,
  ): Promise<MemoryRecord> {
    return save(client, ownerId, input, 'compact');
  }
  async function get(ownerId: string, memoryId: string): Promise<MemoryRecord | null> {
    validateOwner(ownerId);
    if (!isUuid(memoryId)) throw validationError('invalid memory id');
    return withTransaction(pool, async (client) => {
      const row = await load(client, ownerId, memoryId, true);
      if (!row) return null;
      try {
        await checkSource(client, ownerId, row);
      } catch (error) {
        if (inaccessible(error)) return null;
        throw error;
      }
      return record(row);
    });
  }
  async function list(
    ownerId: string,
    input: { limit?: number; cursor?: string },
  ): Promise<{ items: MemoryRecord[]; nextCursor: string | null }> {
    validateOwner(ownerId);
    const limit = input.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.cursor !== undefined && !isUuid(input.cursor))
    ) {
      throw validationError('invalid memory pagination');
    }
    return withTransaction(pool, async (client) => {
      const items: MemoryRecord[] = [];
      let after = input.cursor ?? null;
      for (;;) {
        const result: { rows: Row[] } = await client.query<Row>(
          `SELECT ${projection} ${join}
          WHERE m.owner_id=$1 AND m.status='active' AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
          AND ($2::uuid IS NULL OR m.id > $2::uuid) ORDER BY m.id LIMIT 100 FOR UPDATE OF m`,
          [ownerId, after],
        );
        for (const row of result.rows) {
          try {
            await checkSource(client, ownerId, row);
          } catch (error) {
            if (inaccessible(error)) continue;
            throw error;
          }
          if (items.length === limit) return { items, nextCursor: items[items.length - 1]!.id };
          items.push(record(row));
        }
        if (result.rows.length < 100) return { items, nextCursor: null };
        after = result.rows[result.rows.length - 1]!.id;
      }
    });
  }
  async function recall(
    ownerId: string,
    input: { query: string; limit?: number },
    signal?: AbortSignal,
    allowUnfiltered = true,
  ): Promise<MemoryRecallResult> {
    validateOwner(ownerId);
    const limit = input.limit ?? 20;
    if (
      typeof input.query !== 'string' ||
      !input.query.trim() ||
      input.query.length > 500 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw validationError('invalid memory query');
    const identifier = input.query.match(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+/)?.[0] ?? null;
    const pattern = identifier ? `(^|[^A-Za-z0-9_-])${identifier}([^A-Za-z0-9_-]|$)` : null;
    const literal = await withTransaction(pool, async (client) => {
      const items: MemoryRecord[] = [];
      // Exact identifiers take precedence even when embedded in a longer natural-language query.
      for (const phase of pattern ? [0, 1] : [1]) {
        if (
          phase === 1 &&
          identifier &&
          input.query.trim().toLowerCase() === identifier.toLowerCase()
        )
          continue;
        let after: string | null = null;
        for (;;) {
          const result: { rows: Row[] } = await client.query<Row>(
            `SELECT ${projection} ${join}
            WHERE m.owner_id=$1 AND m.status='active' AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
            AND (($4::int=0 AND r.content ~* $5) OR
              ($4::int=1 AND strpos(lower(r.content), lower($2)) > 0 AND ($5::text IS NULL OR r.content !~* $5)))
            AND ($3::uuid IS NULL OR m.id > $3::uuid) ORDER BY m.id LIMIT 100`,
            [ownerId, input.query, after, phase, pattern],
          );
          for (const row of result.rows) {
            try {
              await checkSource(client, ownerId, row);
            } catch (error) {
              if (inaccessible(error)) continue;
              throw error;
            }
            items.push(record(row));
            if (items.length === limit) return items;
          }
          if (result.rows.length < 100) break;
          after = result.rows[result.rows.length - 1]!.id;
        }
      }
      return items;
    });
    const items: MemoryRecallResult['items'] = literal.map((item) => ({
      ...item,
      match: 'literal',
    }));
    let completeness: MemoryRecallResult['completeness'] = 'degraded';
    if (semanticConfig) {
      try {
        const semantic = createMemorySemantic({ pool, sources, config: semanticConfig, list });
        const indexed = await semantic.indexMissing(ownerId, signal);
        const found = await semantic.search(ownerId, input.query, limit, signal);
        const seen = new Set(items.map((item) => item.id));
        for (const item of found.items) {
          if (items.length >= limit) break;
          if (!seen.has(item.id)) {
            items.push({ ...item, match: 'semantic' });
            seen.add(item.id);
          }
        }
        // Index coverage alone is not a calibrated relevance/rejection policy.
        completeness = indexed ? 'incomplete' : 'degraded';
      } catch (error) {
        signal?.throwIfAborted();
        completeness = error instanceof MemorySourceFailure ? 'incomplete' : 'degraded';
      }
    }
    signal?.throwIfAborted();
    if (allowUnfiltered && items.length === 0 && completeness === 'degraded') {
      const recent = await withTransaction(pool, async (client) => {
        const result: MemoryRecord[] = [];
        let offset = 0;
        while (result.length < Math.min(limit, 5)) {
          const page = await client.query<Row>(
            `SELECT ${projection} ${join}
            WHERE m.owner_id=$1 AND m.status='active'
              AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
            ORDER BY m.updated_at DESC, m.id LIMIT 100 OFFSET $2`,
            [ownerId, offset],
          );
          for (const row of page.rows) {
            try {
              await checkSource(client, ownerId, row);
              result.push(record(row));
              if (result.length === Math.min(limit, 5)) break;
            } catch (error) {
              if (!inaccessible(error)) throw error;
            }
          }
          if (page.rows.length < 100) break;
          offset += page.rows.length;
        }
        return result;
      });
      items.push(...recent.map((item) => ({ ...item, match: 'unfiltered' as const })));
    }
    await withTransaction(pool, (client) => validateRecallInTransaction(client, ownerId, items));
    return { items, completeness, candidateOnly: true };
  }
  /** Caller holds its delivery/accept transaction until commit; no network I/O. */
  async function validateRecallInTransaction(
    client: PoolClient,
    ownerId: string,
    items: { id: string; revision: number }[],
  ): Promise<void> {
    await validateMemoryRevisions(client, sources, ownerId, items);
  }
  async function rebuildIndex(
    ownerId: string,
    input: { limit: number; cursor?: string },
  ): Promise<MemoryIndexResult> {
    if (!semanticConfig) throw notReady('memory semantic indexing is not configured');
    return createMemorySemantic({ pool, sources, config: semanticConfig, list }).rebuild(
      ownerId,
      input,
    );
  }
  async function correct(
    ownerId: string,
    memoryId: string,
    input: CorrectionInput,
  ): Promise<MemoryRecord> {
    validateOwner(ownerId);
    validateInput(input);
    validateRevision(input.expectedRevision);
    if (!isUuid(memoryId)) throw validationError('invalid memory id');
    return withTransaction(pool, async (client) => {
      const old = await load(client, ownerId, memoryId, true);
      if (!old) throw notFound('memory not found');
      await checkSource(client, ownerId, old);
      if (old.revision !== input.expectedRevision) throw stateConflict('memory revision changed');
      await sources.validate(client, {
        ownerId,
        conversationId: input.conversationId,
        messageIds: input.messageIds,
        purpose: 'correction',
      });
      await client.query(
        `INSERT INTO r3_memory_revisions(owner_id,memory_id,revision,conversation_id,message_ids,content,source_kind,summary_id,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'explicit',NULL,$7)`,
        [
          ownerId,
          memoryId,
          old.revision + 1,
          input.conversationId,
          input.messageIds,
          input.content,
          input.expiresAt === undefined ? old.expires_at : input.expiresAt,
        ],
      );
      await client.query(
        'UPDATE r3_memories SET current_revision=$3, updated_at=now() WHERE owner_id=$1 AND id=$2',
        [ownerId, memoryId, old.revision + 1],
      );
      const { rows } = await client.query<Row>(
        `SELECT ${projection} ${join} WHERE m.owner_id=$1 AND m.id=$2`,
        [ownerId, memoryId],
      );
      return record(rows[0]!);
    });
  }
  async function stopRecall(
    ownerId: string,
    memoryId: string,
    expectedRevision: number,
  ): Promise<void> {
    validateOwner(ownerId);
    validateRevision(expectedRevision);
    if (!isUuid(memoryId)) throw validationError('invalid memory id');
    await withTransaction(pool, async (client) => {
      const row = await load(client, ownerId, memoryId, true);
      if (!row) throw notFound('memory not found');
      if (row.revision !== expectedRevision) throw stateConflict('memory revision changed');
      await client.query(
        `UPDATE r3_memories SET status='stopped', updated_at=now() WHERE owner_id=$1 AND id=$2`,
        [ownerId, memoryId],
      );
    });
  }
  return {
    remember: (ownerId: string, input: RememberInput) =>
      withTransaction(pool, (client) => rememberInTransaction(client, ownerId, input)),
    rememberCompact: (ownerId: string, input: CompactInput) =>
      withTransaction(pool, (client) => rememberCompactInTransaction(client, ownerId, input)),
    rememberInTransaction,
    rememberCompactInTransaction,
    list,
    recall,
    validateRecallInTransaction,
    rebuildIndex,
    get,
    correct,
    stopRecall,
  };
}
