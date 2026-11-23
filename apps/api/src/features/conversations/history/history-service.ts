import type { Pool } from 'pg';
import {
  ConversationListQuerySchema,
  ConversationMessagesQuerySchema,
  ConversationRunsQuerySchema,
  type ConversationListPage,
  type ConversationMessagePage,
  type ConversationRunPage,
} from '@along/contracts';
import {
  decodeCursor,
  encodeCursor,
  forbidden,
  notFound,
  notReady,
  validationError,
} from '../../../platform/errors.js';
import type { ConversationDeps } from '../contracts.js';
import { getConversation } from '../run/repository.js';
import { HistoryCursorSchema, type HistoryCursor } from '../schemas.js';
import {
  listConversationHistory,
  listMessageHistory,
  listRunHistory,
  type HistoryBoundary,
} from './history-repository.js';
import { isActiveOwner } from '../../identity/public.js';
import { withClient } from '../../../db/transaction.js';
import { getRunSelections } from '../../model-providers/public.js';
import { createOfficeStorage } from '../../native-office/public.js';
import { readOfficeReminderStatuses } from '../../tasks/public.js';

async function requireEligibleHistoryOwner(pool: Pool, ownerId: string): Promise<void> {
  const client = await pool.connect();
  try {
    if (!(await isActiveOwner(client, ownerId))) throw forbidden('owner authorization revoked');
  } finally {
    client.release();
  }
}

export type HistoryQuery = Record<string, string | string[] | undefined>;

function poolOf(deps: Pick<ConversationDeps, 'pool'>): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}

export async function requireHistoryConversation(
  pool: Pool,
  ownerId: string,
  conversationId: string,
): Promise<void> {
  await requireEligibleHistoryOwner(pool, ownerId);
  const parent = await getConversation(pool, conversationId);
  if (!parent) throw notFound('conversation not found');
  if (parent.owner_id !== ownerId) throw forbidden('conversation not found');
}

function cursorOf(
  raw: string | undefined,
  kind: HistoryCursor['kind'],
  owner: string,
  parent = '',
): HistoryCursor | null {
  if (raw === undefined) return null;
  // Buffer's base64 decoder is permissive. Require canonical base64url before
  // decoding so malformed encodings cannot silently acquire a valid meaning.
  if (!/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.from(raw, 'base64url').toString('base64url') !== raw)
    throw validationError('invalid history cursor');
  const parsed = HistoryCursorSchema.safeParse(decodeCursor(raw));
  if (
    !parsed.success ||
    parsed.data.kind !== kind ||
    parsed.data.owner.toLowerCase() !== owner.toLowerCase() ||
    parsed.data.parent.toLowerCase() !== parent.toLowerCase()
  )
    throw validationError('invalid history cursor');
  return parsed.data;
}

function nextCursor(
  kind: HistoryCursor['kind'],
  owner: string,
  parent: string,
  boundary: HistoryBoundary | undefined,
  lastAt: string | undefined,
  lastId: string | undefined,
  hasMore: boolean,
): string | null {
  if (!hasMore || !boundary || !lastAt || !lastId) return null;
  return encodeCursor({
    v: '1',
    kind,
    owner,
    parent,
    upper_at: boundary.upper_at,
    upper_id: boundary.upper_id,
    last_at: lastAt,
    last_id: lastId,
  });
}

function titleOf(content: string | null, conversationId: string): string {
  const line = content
    ?.split(/\r\n|\r|\n/)
    .find((part) => part.trim().length > 0)
    ?.trim();
  if (!line) return `会话 ${conversationId.slice(0, 8)}`;
  let title = '';
  let length = 0;
  for (const point of line) {
    if (length === 40) return `${title}…`;
    title += point;
    length += 1;
  }
  return title;
}

export async function getConversationList(
  deps: Pick<ConversationDeps, 'pool'>,
  ownerId: string,
  query: HistoryQuery,
): Promise<ConversationListPage> {
  const parsed = ConversationListQuerySchema.safeParse(query);
  if (!parsed.success) throw validationError('invalid conversations query');
  const { limit, cursor: raw } = parsed.data;
  const cursor = cursorOf(raw, 'conversations', ownerId);
  await requireEligibleHistoryOwner(poolOf(deps), ownerId);
  const rows = await listConversationHistory(poolOf(deps), { ownerId, cursor, limit });
  const items = rows.slice(0, limit).map((row) => ({
    conversation_id: row.conversation_id,
    status: row.status,
    title: titleOf(row.title_content, row.conversation_id),
    title_message_id: row.title_message_id,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
  }));
  const last = items.at(-1);
  return {
    items,
    next_cursor: nextCursor(
      'conversations',
      ownerId,
      '',
      rows[0],
      last?.created_at,
      last?.conversation_id,
      rows.length > limit,
    ),
  };
}

export async function getConversationMessages(
  deps: Pick<ConversationDeps, 'pool'>,
  ownerId: string,
  conversationId: string,
  query: HistoryQuery,
): Promise<ConversationMessagePage> {
  const parsed = ConversationMessagesQuerySchema.safeParse(query);
  if (!parsed.success) throw validationError('invalid messages query');
  const pool = poolOf(deps);
  await requireHistoryConversation(pool, ownerId, conversationId);
  const { limit, cursor: raw } = parsed.data;
  const cursor = cursorOf(raw, 'messages', ownerId, conversationId);
  const rows = await listMessageHistory(pool, { ownerId, conversationId, cursor, limit });
  const items = rows.slice(0, limit).map((row) => ({
    message_id: row.message_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    ...(row.source_run_id ? { source_run_id: row.source_run_id } : {}),
  }));
  const last = items.at(-1);
  return {
    items,
    next_cursor: nextCursor(
      'messages',
      ownerId,
      conversationId,
      rows[0],
      last?.created_at,
      last?.message_id,
      rows.length > limit,
    ),
  };
}

export async function getConversationRuns(
  deps: Pick<ConversationDeps, 'pool'>,
  ownerId: string,
  conversationId: string,
  query: HistoryQuery,
): Promise<ConversationRunPage> {
  const parsed = ConversationRunsQuerySchema.safeParse(query);
  if (!parsed.success) throw validationError('invalid runs query');
  const pool = poolOf(deps);
  await requireHistoryConversation(pool, ownerId, conversationId);
  const { limit, cursor: raw, run_id: runId } = parsed.data;
  const cursor = cursorOf(raw, 'runs', ownerId, conversationId);
  const rows = await listRunHistory(pool, { ownerId, conversationId, cursor, limit, runId });
  if (runId && rows.length === 0) throw notFound('Run not found');
  const selections = await withClient(pool, (client) =>
    getRunSelections(
      client,
      ownerId,
      rows.slice(0, limit).map((row) => row.run_id),
    ),
  );
  const materials = await createOfficeStorage(pool).listRunMaterials(
    ownerId,
    rows.slice(0, limit).map((row) => row.run_id),
  );
  const reminders = await readOfficeReminderStatuses(pool, ownerId, [
    ...new Set([...materials.values()].map((material) => material.scopeRunId)),
  ]);
  const items = rows.slice(0, limit).map((row) => ({
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    execution: row.execution,
    status: row.status,
    model_selection:
      selections.get(row.run_id) ??
      (row.execution === 'business'
        ? { state: 'not_applicable' as const }
        : { state: 'legacy_unavailable' as const }),
    created_at: row.created_at,
    ended_at: row.ended_at,
    ...(materials.has(row.run_id)
      ? {
          office_materials: {
            inputs: materials.get(row.run_id)!.inputs.map((input) => ({
              role: input.role,
              attachment_id: input.attachmentId,
              filename: input.filename,
              format: input.format,
              byte_length: input.sizeBytes,
              expires_at: input.expiresAt,
              status: input.status,
            })),
            artifacts: materials.get(row.run_id)!.artifacts.map((artifact) => ({
              artifact_id: artifact.artifactId,
              run_id: artifact.runId,
              filename: artifact.filename,
              format: artifact.format,
              byte_length: artifact.sizeBytes,
              expires_at: artifact.expiresAt,
              status: artifact.status,
              download_url:
                artifact.status === 'available'
                  ? `/api/v1/conversations/${conversationId}/runs/${artifact.runId}/artifacts/${artifact.artifactId}/content`
                  : null,
            })),
            reminder: reminders.has(materials.get(row.run_id)!.scopeRunId)
              ? {
                  state: 'created' as const,
                  task_id: reminders.get(materials.get(row.run_id)!.scopeRunId)!.taskId,
                  current_status: reminders.get(materials.get(row.run_id)!.scopeRunId)!.state,
                }
              : { state: 'unconfirmed' as const },
          },
        }
      : {}),
    original: row.original,
  }));
  const last = items.at(-1);
  return {
    items,
    next_cursor: nextCursor(
      'runs',
      ownerId,
      conversationId,
      rows[0],
      last?.created_at,
      last?.run_id,
      rows.length > limit,
    ),
  };
}
