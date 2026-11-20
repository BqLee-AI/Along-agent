// Read-only history projections. Every page and its first upper tuple come
// from one SQL statement/snapshot; no Date conversion, ledger cleanup or writes.
import type { Pool } from 'pg';
import type {
  ConversationListItem,
  MessageHistoryItem,
  ConversationRunHistoryItem,
} from '@along/contracts';
import type { HistoryCursor } from '../schemas.js';

export interface HistoryPageArgs {
  ownerId: string;
  conversationId?: string;
  cursor: HistoryCursor | null;
  limit: number;
  runId?: string;
}
export interface HistoryBoundary {
  upper_at: string;
  upper_id: string;
}
export interface ConversationHistoryRow extends HistoryBoundary {
  conversation_id: string;
  status: ConversationListItem['status'];
  created_at: string;
  last_activity_at: string | null;
  title_message_id: string | null;
  title_content: string | null;
}
export interface MessageHistoryRow extends MessageHistoryItem, HistoryBoundary {}
export interface RunHistoryRow
  extends Omit<ConversationRunHistoryItem, 'model_selection'>, HistoryBoundary {}

function utc(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

// Only these three fixed projections may choose a table/order. Bind all
// client values. The parent EXISTS remains in SQL even after service auth.
function pageSql(kind: HistoryCursor['kind']): string {
  const table =
    kind === 'conversations' ? 'conversations' : kind === 'messages' ? 'messages' : 'agent_runs';
  const scope = `x.owner_id=$1 ${
    kind === 'conversations'
      ? ''
      : `AND x.conversation_id=$2 AND EXISTS (
    SELECT 1 FROM conversations parent WHERE parent.id=x.conversation_id AND parent.owner_id=$1)`
  }
    ${
      kind === 'messages'
        ? `AND x.role IN ('user','assistant') AND NOT EXISTS (
            SELECT 1 FROM feishu_pending_disclosures p WHERE p.run_id=x.source_run_id AND p.is_terminal
          )`
        : ''
    }
    ${kind === 'runs' ? 'AND ($8::uuid IS NULL OR x.id=$8::uuid)' : ''}`;
  const order = kind === 'conversations' ? 'DESC' : 'ASC';
  const comparison = kind === 'conversations' ? '<' : '>';
  return `WITH upper_bound AS (
    SELECT x.created_at,x.id FROM ${table} x WHERE ${scope}
    ORDER BY x.created_at DESC,x.id DESC LIMIT 1
  ), boundary AS (
    SELECT COALESCE($3::timestamptz,(SELECT created_at FROM upper_bound)) AS at,
      COALESCE($4::uuid,(SELECT id FROM upper_bound)) AS id
  ), page AS (
    SELECT x.* FROM ${table} x CROSS JOIN boundary b WHERE ${scope}
      AND (x.created_at,x.id)<=(b.at,b.id)
      AND ($5::timestamptz IS NULL OR (x.created_at,x.id)${comparison}($5::timestamptz,$6::uuid))
    ORDER BY x.created_at ${order},x.id ${order} LIMIT $7
  )`;
}
function values(args: HistoryPageArgs): unknown[] {
  return [
    args.ownerId,
    args.conversationId ?? null,
    args.cursor?.upper_at ?? null,
    args.cursor?.upper_id ?? null,
    args.cursor?.last_at ?? null,
    args.cursor?.last_id ?? null,
    args.limit + 1,
  ];
}
const boundaryColumns = `${utc('b.at')} AS upper_at,b.id AS upper_id`;

export async function listConversationHistory(
  db: Pool,
  args: HistoryPageArgs,
): Promise<ConversationHistoryRow[]> {
  // $2 is reserved for the parent in child pages; explicitly type it in this
  // projection so PostgreSQL can infer every bind slot consistently.
  const result = await db.query<ConversationHistoryRow>(
    `${pageSql('conversations')}
    SELECT p.id AS conversation_id,p.status,${utc('p.created_at')} AS created_at,
      first_message.id AS title_message_id,first_message.content AS title_content,
      ${utc('activity.at')} AS last_activity_at,${boundaryColumns}
    FROM page p CROSS JOIN boundary b
    LEFT JOIN LATERAL (
      SELECT m.id,m.content FROM messages m WHERE m.owner_id=$1 AND m.conversation_id=p.id AND m.role='user'
      ORDER BY m.created_at ASC,m.id ASC LIMIT 1
    ) first_message ON true
    LEFT JOIN LATERAL (
      SELECT max(fact.at) AS at FROM (
        SELECT max(m.created_at) AS at FROM messages m
          WHERE m.owner_id=$1 AND m.conversation_id=p.id AND m.role IN ('user','assistant')
        UNION ALL SELECT max(GREATEST(r.created_at,r.ended_at)) AS at FROM agent_runs r
          WHERE r.owner_id=$1 AND r.conversation_id=p.id
      ) fact
    ) activity ON true
    WHERE $2::uuid IS NULL
    ORDER BY p.created_at DESC,p.id DESC`,
    values(args),
  );
  return result.rows;
}

export async function listMessageHistory(
  db: Pool,
  args: HistoryPageArgs,
): Promise<MessageHistoryRow[]> {
  const result = await db.query<MessageHistoryRow>(
    `${pageSql('messages')}
    SELECT p.id AS message_id,p.role,p.content,${utc('p.created_at')} AS created_at,${boundaryColumns}
    FROM page p CROSS JOIN boundary b ORDER BY p.created_at ASC,p.id ASC`,
    values(args),
  );
  return result.rows;
}

export async function listRunHistory(db: Pool, args: HistoryPageArgs): Promise<RunHistoryRow[]> {
  const result = await db.query<RunHistoryRow>(
    `${pageSql('runs')}
    SELECT p.id AS run_id,p.conversation_id,p.execution,p.status,
      ${utc('p.created_at')} AS created_at,${utc('p.ended_at')} AS ended_at,${boundaryColumns},
      CASE
        WHEN original_message.id IS NOT NULL THEN jsonb_build_object(
          'state','available','source',CASE WHEN p.input_message_id IS NOT NULL THEN 'input_message' ELSE 'idempotency_reference' END,
          'message',jsonb_build_object('message_id',original_message.id,'content',original_message.content,'created_at',${utc('original_message.created_at')}))
        WHEN p.input_message_id IS NULL AND (ledger.reference_count=0 OR (ledger.valid_scope AND ledger.message_count=0))
          THEN jsonb_build_object('state','legacy_unavailable')
        ELSE jsonb_build_object('state','invalid_reference')
      END AS original
    FROM page p CROSS JOIN boundary b
    LEFT JOIN LATERAL (
      SELECT count(*) AS reference_count,
        bool_and(i.owner_id=$1 AND i.conversation_id=p.conversation_id) AS valid_scope,
        count(DISTINCT i.user_message_id) AS message_count,min(i.user_message_id::text)::uuid AS message_id
      FROM conversation_idempotency i WHERE i.run_id=p.id AND p.input_message_id IS NULL
    ) ledger ON true
    LEFT JOIN messages original_message ON original_message.id=CASE
      WHEN p.input_message_id IS NOT NULL THEN p.input_message_id
      WHEN ledger.valid_scope AND ledger.message_count=1 THEN ledger.message_id ELSE NULL END
      AND original_message.owner_id=$1 AND original_message.conversation_id=p.conversation_id AND original_message.role='user'
    ORDER BY p.created_at ASC,p.id ASC`,
    [...values(args), args.runId ?? null],
  );
  return result.rows;
}

export async function requireHistoryRun(
  db: Pool,
  ownerId: string,
  conversationId: string,
  runId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT r.id FROM agent_runs r
    WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=r.conversation_id AND c.owner_id=$2)`,
    [runId, ownerId, conversationId],
  );
  return result.rows.length === 1;
}
