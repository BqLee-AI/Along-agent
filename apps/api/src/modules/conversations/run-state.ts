import type { PoolClient } from 'pg';
import { HarnessSnapshotSchema } from '@along/contracts';
import type { ExecutionKind, HarnessSnapshot, RunView } from '@along/contracts';
import {
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  type ThreadEvent,
} from '@along/stream-protocol';
import { forbidden, notFound, stateConflict } from '../../http/errors.js';
import { appendCheckpoint, finishAttempt, insertMessage } from './repository.js';
import type { RunContext } from './contracts.js';
import { readApprovalDecision } from '../approvals/decision.js';
import { isActiveOwner } from '../identity/preferences.js';

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
}
export interface FrozenContext {
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  rulesetId: string;
  tzdbVersion: string;
  aliasVersion: string | null;
}
export interface LockedRun {
  run: RunRow;
  attempt: { id: string; attempt_no: number; status: string };
}

// Never lock a Run before its attempt. Callers retry latest-attempt discovery
// outside the transaction when a concurrent resume has relocated execution.
export async function lockRun(
  client: PoolClient,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId'>,
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
  if (executable && (run.status !== 'running' || attempt.status !== 'running')) {
    throw stateConflict('Run attempt cannot execute', { status: run.status });
  }
  if (authorize && run.execution === 'harness' && !(await isActiveOwner(client, run.owner_id))) {
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

export async function appendEvent(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'requestId'>,
  type: ThreadEvent['type'],
  payload: unknown,
): Promise<ThreadEvent> {
  const event = ThreadEventSchema.parse({
    protocol_version: THREAD_PROTOCOL_VERSION,
    seq: 1,
    type,
    payload,
    request_id: context.requestId,
  });
  const seq = (
    await client.query<{ seq: number }>(
      'SELECT COALESCE(max(seq),0)::int+1 AS seq FROM run_checkpoints WHERE attempt_id=$1',
      [context.attemptId],
    )
  ).rows[0]?.seq;
  if (!seq) throw new Error('checkpoint sequence unavailable');
  event.seq = await appendCheckpoint(client, {
    ownerId: context.ownerId,
    attemptId: context.attemptId,
    seq,
    type,
    payload,
    requestId: context.requestId,
  });
  return event;
}

export async function commitTerminal(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'requestId'>,
  status: 'done' | 'failed' | 'cancelled',
  payload: unknown,
): Promise<ThreadEvent> {
  // The caller holds current attempt -> Run; the message and visible terminal
  // checkpoint are part of that same transaction, including persistence faults.
  const deltas = await client.query<{ delta: string }>(
    `SELECT c.payload->'payload'->>'delta' AS delta FROM run_checkpoints c
      JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind='message.delta'
      ORDER BY c.event_seq`,
    [context.runId],
  );
  // Only accepted assistant deltas become a message. A structured failure
  // without assistant output is a terminal event, not a synthesized turn.
  const text = deltas.rows.map((row) => row.delta).join('');
  if (text)
    await insertMessage(client, {
      ownerId: context.ownerId,
      conversationId: context.conversationId,
      role: 'assistant',
      content: text,
      requestId: null,
    });
  const type =
    status === 'done'
      ? 'thread.completed'
      : status === 'failed'
        ? 'thread.failed'
        : 'thread.cancelled';
  const event = await appendEvent(client, context, type, payload);
  await finishAttempt(client, context.attemptId, status === 'done' ? 'done' : 'failed');
  await client.query(
    `UPDATE agent_runs SET status=$2,ended_at=now(),waiting_checkpoint_id=NULL,
      waiting_invocation_id=NULL,waiting_approval_id=NULL WHERE id=$1`,
    [context.runId, status],
  );
  return event;
}

export async function viewOf(client: PoolClient, locked: LockedRun): Promise<RunView> {
  const { run, attempt } = locked;
  const waiting =
    run.waiting_checkpoint_id && run.waiting_invocation_id && run.waiting_approval_id
      ? {
          checkpoint_id: run.waiting_checkpoint_id,
          invocation_id: run.waiting_invocation_id,
          approval_id: run.waiting_approval_id,
        }
      : null;
  const decision = waiting
    ? await readApprovalDecision(client, run.owner_id, waiting.approval_id)
    : null;
  return {
    run_id: run.id,
    conversation_id: run.conversation_id,
    execution: run.execution,
    status: run.status,
    attempt_id: attempt.id,
    attempt_no: attempt.attempt_no,
    waiting,
    can_resume:
      run.execution === 'harness' &&
      run.status === 'suspended_approval' &&
      decision !== null &&
      decision.status !== 'pending',
  };
}

export async function readSnapshot(
  client: PoolClient,
  run: RunRow,
  checkpointId: string,
): Promise<HarnessSnapshot> {
  const checkpoint = (
    await client.query<{ payload: unknown }>(
      `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
      WHERE c.id=$1 AND c.owner_id=$2 AND a.run_id=$3 AND c.kind='harness_snapshot'`,
      [checkpointId, run.owner_id, run.id],
    )
  ).rows[0];
  if (!checkpoint) throw stateConflict('invalid harness checkpoint');
  return HarnessSnapshotSchema.parse(checkpoint.payload);
}
