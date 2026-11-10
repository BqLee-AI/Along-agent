// Conversation/runs repository (issue #9). Owns conversations, messages,
// agent_runs, run_attempts, run_checkpoints and the idempotency ledger.
// No tasks/outbox/approval writes here.
import type { Pool, PoolClient } from 'pg';
import type {
  ExecutionKind,
  HarnessStart,
  RunView,
  WorkspaceGrant,
  WorkspaceSummary,
} from '@along/contracts';
import type { GoalResult, TrustedExecutionContext } from '@along/contracts';
import { forbidden, notFound, stateConflict } from '../../http/errors.js';
import { isActiveOwner } from '../identity/preferences.js';
import type { RunContext } from './contracts.js';
import {
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  type ThreadEvent,
} from '@along/stream-protocol';
import type { ReminderDateSource } from './reminder-date.js';

export interface RunRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  execution: ExecutionKind;
  status: RunView['status'];
  budget_max_iterations: number;
  budget_max_tokens: number;
  tools_allowlist: string[];
  frozen_context: FrozenContext | null;
  input_message_id: string | null;
  waiting_checkpoint_id: string | null;
  waiting_invocation_id: string | null;
  waiting_approval_id: string | null;
  goal_result: GoalResult | null;
}
export interface FrozenContext {
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  rulesetId: string;
  tzdbVersion: string;
  aliasVersion: string | null;
  reminderDateSource?: ReminderDateSource;
  messageRefs?: string[];
  workspaceGrant?: WorkspaceGrant | null;
  workspaceSummary?: WorkspaceSummary | null;
  workspaceGrants?: WorkspaceGrant[];
  createdArtifactReadRevision?: 'owner-created/1';
  createResolutionRevision?: 'create-resolution/1' | 'create-resolution/2';
  authorization_revision?: 'delegation/1';
  execution_lifecycle?: 'request-bound' | 'server-owned';
  trustedExecutionContext?: TrustedExecutionContext;
}
export interface LockedRun {
  run: RunRow;
  attempt: { id: string; attempt_no: number; status: string };
}

// Never lock a Run before its attempt. Callers retry latest-attempt discovery
// outside the transaction when a concurrent resume has relocated execution.
export async function lockRun(
  client: PoolClient,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'ownership'>,
  executable = true,
  authorize = true,
): Promise<LockedRun> {
  const attempt = (
    await client.query<{ id: string; attempt_no: number; status: string }>(
      'SELECT id,attempt_no,status FROM run_attempts WHERE id=$1 AND run_id=$2 AND owner_id=$3 FOR UPDATE',
      [binding.attemptId, binding.runId, binding.ownerId],
    )
  ).rows[0];
  if (!attempt) throw notFound('Run attempt not found');
  const run = (
    await client.query<RunRow>(
      `SELECT r.* FROM agent_runs r WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=r.conversation_id AND c.owner_id=$2)
      FOR UPDATE OF r`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!run) throw notFound('Run not found');
  const latest = (
    await client.query<{ attempt_no: number }>(
      'SELECT max(attempt_no)::int AS attempt_no FROM run_attempts WHERE run_id=$1',
      [run.id],
    )
  ).rows[0]?.attempt_no;
  if (latest !== attempt.attempt_no)
    throw stateConflict('stale Run attempt', { reason: 'STALE_ATTEMPT' });
  if (executable && run.frozen_context?.execution_lifecycle === 'server-owned') {
    if (!binding.ownership) throw stateConflict('Run ownership required');
    await binding.ownership.assert(client, binding.runId, binding.attemptId);
  }
  if (executable && (run.status !== 'running' || attempt.status !== 'running')) {
    throw stateConflict('Run attempt cannot execute', { status: run.status });
  }
  if (authorize && !(await isActiveOwner(client, run.owner_id))) {
    throw forbidden('Run authorization revoked');
  }
  return { run, attempt };
}

export async function latestAttemptId(
  client: Pick<PoolClient, 'query'>,
  ownerId: string,
  runId: string,
): Promise<string> {
  const id = (
    await client.query<{ id: string }>(
      'SELECT id FROM run_attempts WHERE run_id=$1 AND owner_id=$2 ORDER BY attempt_no DESC LIMIT 1',
      [runId, ownerId],
    )
  ).rows[0]?.id;
  if (!id) throw notFound('Run not found');
  return id;
}

export interface ConversationRow {
  id: string;
  owner_id: string;
  status: string;
  confirmed_timezone_id: string | null;
  anchor_received_at_utc: Date | null;
}

export async function getConversation(
  client: Pick<Pool | PoolClient, 'query'>,
  conversationId: string,
): Promise<ConversationRow | null> {
  const { rows } = await client.query<ConversationRow>(
    `SELECT id, owner_id, status, confirmed_timezone_id, anchor_received_at_utc
     FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

export async function createConversation(
  client: Pick<Pool | PoolClient, 'query'>,
  args: { ownerId: string; anchorIso: string; title: string },
): Promise<ConversationRow> {
  const { rows } = await client.query<ConversationRow>(
    `INSERT INTO conversations (id, owner_id, title, anchor_received_at_utc)
     VALUES (gen_random_uuid(), $1, $2, $3)
     RETURNING id, owner_id, status, confirmed_timezone_id, anchor_received_at_utc`,
    [args.ownerId, args.title, args.anchorIso],
  );
  const row = rows[0];
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

// First confirmed timezone wins and freezes for the conversation; later
// messages cannot move the anchor's clock.
export async function freezeConversationTimezone(
  client: Pick<Pool | PoolClient, 'query'>,
  conversationId: string,
  timezoneId: string,
): Promise<void> {
  await client.query(
    `UPDATE conversations SET confirmed_timezone_id = $2, updated_at = now()
     WHERE id = $1 AND confirmed_timezone_id IS NULL`,
    [conversationId, timezoneId],
  );
}

export async function insertMessage(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    requestId: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, clock_timestamp()) RETURNING id`,
    [args.ownerId, args.conversationId, args.role, args.content, args.requestId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('message insert returned no row');
  return id;
}

// Freeze the newest 63 visible predecessors plus the complete accepted input.
// PostgreSQL preserves microsecond ordering; current input is always last.
export async function listHarnessMessageRefs(
  client: Pick<Pool | PoolClient, 'query'>,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'userMessageId'>,
): Promise<string[]> {
  const { ownerId, conversationId, userMessageId } = binding;
  const { rows } = await client.query<{ id: string }>(
    `WITH accepted AS (
       SELECT m.id,m.created_at FROM messages m
       WHERE m.id=$3 AND m.owner_id=$1 AND m.conversation_id=$2 AND m.role='user'
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=$2 AND c.owner_id=$1)
     ), history AS (
       SELECT m.id,m.created_at FROM messages m CROSS JOIN accepted a
       WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.role IN ('user','assistant')
         AND m.id<>a.id
       ORDER BY m.created_at DESC,m.id DESC LIMIT 63
     )
     SELECT id FROM (
       SELECT *,false AS current_input FROM history
       UNION ALL SELECT *,true AS current_input FROM accepted
     ) visible ORDER BY current_input,created_at,id`,
    [ownerId, conversationId, userMessageId],
  );
  if (rows.at(-1)?.id !== userMessageId) throw stateConflict('Run accepted message missing');
  return rows.map((row) => row.id);
}

// Execution and resume resolve only frozen, ordered references, never reselect
// later history. Every message is owner/conversation/visible-role scoped.
export async function readHarnessMessages(
  client: Pick<Pool | PoolClient, 'query'>,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'userMessageId'>,
  messageRefs: readonly string[],
): Promise<HarnessStart['messages']> {
  const { ownerId, conversationId, userMessageId } = binding;
  if (
    messageRefs.length === 0 ||
    messageRefs.length > 64 ||
    messageRefs.at(-1) !== userMessageId ||
    new Set(messageRefs).size !== messageRefs.length
  )
    throw stateConflict('snapshot message reference conflict');
  const { rows } = await client.query<HarnessStart['messages'][number]>(
    `SELECT m.id AS message_id,m.role,m.content
     FROM unnest($3::uuid[]) WITH ORDINALITY AS refs(id,position)
     JOIN messages m ON m.id=refs.id AND m.owner_id=$1 AND m.conversation_id=$2
       AND m.role IN ('user','assistant')
     WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id=$2 AND c.owner_id=$1)
     ORDER BY refs.position`,
    [ownerId, conversationId, messageRefs],
  );
  if (rows.length !== messageRefs.length || rows.at(-1)?.role !== 'user')
    throw stateConflict('snapshot message reference conflict');
  return rows;
}

export async function insertRun(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    runId: string;
    ownerId: string;
    conversationId: string;
    agentRevision: string;
    mode: 'chat' | 'task';
    maxIterations: number;
    maxTokens: number;
    execution: 'business' | 'harness';
    allowlist: readonly string[];
    frozenContext: unknown;
    inputMessageId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision,
       mode, status, budget_max_iterations, budget_max_tokens, execution,
       tools_allowlist, frozen_context, input_message_id)
     VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [
      args.runId,
      args.ownerId,
      args.conversationId,
      args.agentRevision,
      args.mode,
      args.maxIterations,
      args.maxTokens,
      args.execution,
      JSON.stringify(args.allowlist),
      JSON.stringify(args.frozenContext),
      args.inputMessageId,
    ],
  );
}

export async function insertAttempt(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    attemptId: string;
    ownerId: string;
    runId: string;
    attemptNo: number;
    leaseToken?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO run_attempts (id, owner_id, run_id, attempt_no, status, lease_token)
     VALUES ($1,$2,$3,$4,'running',$5)`,
    [args.attemptId, args.ownerId, args.runId, args.attemptNo, args.leaseToken ?? null],
  );
}

// Appends one thread event and returns its global stream id (event_seq).
// The checkpoint is append-only; replay and GET after_seq both read it.
export async function appendCheckpoint(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    attemptId: string;
    seq: number;
    type: string;
    payload: unknown;
    requestId: string;
    streamProtocolVersion?: 'v1' | 'v2';
  },
): Promise<number> {
  const { rows } = await client.query<{ event_seq: string }>(
    `INSERT INTO run_checkpoints (id, owner_id, attempt_id, seq, kind,
       payload, stream_protocol_version)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
     RETURNING event_seq`,
    [
      args.ownerId,
      args.attemptId,
      args.seq,
      args.type,
      JSON.stringify({ type: args.type, payload: args.payload, request_id: args.requestId }),
      args.streamProtocolVersion ?? THREAD_PROTOCOL_VERSION,
    ],
  );
  const seq = rows[0]?.event_seq;
  if (seq === undefined) throw new Error('checkpoint insert returned no row');
  return Number(seq);
}

export interface IdempotencyRow {
  request_hash: string;
  conversation_id: string;
  run_id: string;
}

export async function findIdempotency(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  const { rows } = await client.query<IdempotencyRow>(
    `SELECT request_hash, conversation_id, run_id
     FROM conversation_idempotency
     WHERE owner_id = $1 AND idempotency_key = $2 AND expires_at > now()`,
    [ownerId, idempotencyKey],
  );
  return rows[0] ?? null;
}

// Expired keys are deleted before re-insert so a 24h-later retry with the
// same key starts a fresh run instead of colliding with the stale PK.
export async function deleteExpiredIdempotency(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  idempotencyKey: string,
): Promise<void> {
  await client.query(
    `DELETE FROM conversation_idempotency
     WHERE owner_id = $1 AND idempotency_key = $2 AND expires_at <= now()`,
    [ownerId, idempotencyKey],
  );
}

// Plain insert: a concurrent duplicate raises 23505, which the caller turns
// into a replay of the winning run (first writer wins, no overwrite).
export async function insertIdempotency(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    idempotencyKey: string;
    requestHash: string;
    conversationId: string;
    runId: string;
    userMessageId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_idempotency (owner_id, idempotency_key,
       request_hash, conversation_id, run_id, user_message_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '24 hours')`,
    [
      args.ownerId,
      args.idempotencyKey,
      args.requestHash,
      args.conversationId,
      args.runId,
      args.userMessageId,
    ],
  );
}

interface CheckpointRow {
  event_seq: string;
  payload: { type: string; payload: unknown; request_id: string };
  stream_protocol_version: string;
}

function envelopeOf(row: CheckpointRow): ThreadEvent {
  return ThreadEventSchema.parse({
    protocol_version: row.stream_protocol_version,
    seq: Number(row.event_seq),
    type: row.payload.type,
    payload: row.payload.payload,
    request_id: row.payload.request_id,
  });
}

export async function listRunEvents(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  runId: string,
): Promise<ThreadEvent[]> {
  const { rows } = await client.query<CheckpointRow>(
    `SELECT c.event_seq, c.payload, c.stream_protocol_version
     FROM run_checkpoints c
     JOIN run_attempts a ON a.id = c.attempt_id
     JOIN agent_runs r ON r.id = a.run_id
     WHERE r.owner_id = $1 AND r.id = $2
       AND c.kind IN ('thread.started','message.delta','card.proposed','approval_required',
         'thread.completed','thread.failed','thread.cancelled')
     ORDER BY c.event_seq ASC`,
    [ownerId, runId],
  );
  return rows.map(envelopeOf);
}

export async function listConversationEvents(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    conversationId: string;
    afterSeq: number | null;
    limit: number;
    runId?: string;
  },
): Promise<ThreadEvent[]> {
  const { rows } = await client.query<CheckpointRow>(
    `SELECT c.event_seq, c.payload, c.stream_protocol_version
     FROM run_checkpoints c
     JOIN run_attempts a ON a.id = c.attempt_id
     JOIN agent_runs r ON r.id = a.run_id
     WHERE r.owner_id = $1 AND r.conversation_id = $2
       AND c.owner_id=$1 AND a.owner_id=$1
       AND EXISTS (SELECT 1 FROM conversations parent WHERE parent.id=r.conversation_id AND parent.owner_id=$1)
       AND ($5::uuid IS NULL OR r.id=$5::uuid)
       AND c.kind IN ('thread.started','message.delta','card.proposed','approval_required',
         'thread.completed','thread.failed','thread.cancelled')
       AND ($3::bigint IS NULL OR c.event_seq > $3::bigint)
     ORDER BY c.event_seq ASC
     LIMIT $4`,
    [args.ownerId, args.conversationId, args.afterSeq, args.limit, args.runId ?? null],
  );
  return rows.map(envelopeOf);
}

export async function getRunStatus(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  runId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM agent_runs WHERE owner_id = $1 AND id = $2',
    [ownerId, runId],
  );
  return rows[0]?.status ?? null;
}

export async function finishAttempt(
  client: Pick<Pool | PoolClient, 'query'>,
  attemptId: string,
  status: 'done' | 'failed' | 'fenced_out',
): Promise<void> {
  await client.query('UPDATE run_attempts SET status = $2, ended_at = now() WHERE id = $1', [
    attemptId,
    status,
  ]);
}
