import type { Pool } from 'pg';
import {
  ConversationListQuerySchema,
  ConversationMessagesQuerySchema,
  ConversationRunsQuerySchema,
} from '@along/contracts';
import type {
  ConversationListPage,
  ConversationMessagePage,
  ConversationRunPage,
} from '@along/contracts';
import {
  decodeCursor,
  encodeCursor,
  forbidden,
  notFound,
  notReady,
  validationError,
} from '../../http/errors.js';
import type { ConversationDeps } from './contracts.js';
import { getConversation } from './repository.js';
import { HistoryCursorSchema } from './schemas.js';
import type { HistoryCursor } from './schemas.js';
import {
  listConversationHistory,
  listMessageHistory,
  listRunHistory,
} from './history-repository.js';
import type { HistoryBoundary } from './history-repository.js';

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
  const items = rows.slice(0, limit).map((row) => ({
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    execution: row.execution,
    status: row.status,
    created_at: row.created_at,
    ended_at: row.ended_at,
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
