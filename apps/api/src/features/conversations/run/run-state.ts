import type { PoolClient } from 'pg';
import type { GoalResult } from '@along/contracts';
import {
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  type ThreadEvent,
} from '@along/stream-protocol';
import { stateConflict } from '../../../platform/errors.js';
import { appendCheckpoint, finishAttempt, insertMessage } from './repository.js';
import type { RunContext } from '../contracts.js';

export async function appendEvent(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'requestId'>,
  type: ThreadEvent['type'],
  payload: unknown,
): Promise<ThreadEvent> {
  const authority = (
    await client.query<{
      revision: string | null;
      lifecycle: 'request-bound' | 'server-owned' | null;
    }>(
      `SELECT frozen_context->>'authorization_revision' AS revision,
       frozen_context->>'execution_lifecycle' AS lifecycle FROM agent_runs WHERE id=$1 AND owner_id=$2`,
      [context.runId, context.ownerId],
    )
  ).rows[0];
  const delegation = authority?.revision === 'delegation/1';
  if (delegation && type === 'thread.started')
    payload = {
      ...(payload as Record<string, unknown>),
      stream_protocol_version: 'v2',
      authorization_revision: 'delegation/1',
      execution_lifecycle: authority?.lifecycle ?? 'request-bound',
    };
  const event = ThreadEventSchema.parse({
    protocol_version: delegation ? 'v2' : THREAD_PROTOCOL_VERSION,
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
    streamProtocolVersion: event.protocol_version,
  });
  return event;
}

export interface TerminalFactOptions {
  preserveAttemptStatus?: boolean;
  /** Combines other owners' evidence with this transaction's one delta aggregation. */
  prepareGoal?: (client: PoolClient, answer: string) => Promise<GoalResult>;
}

export async function commitTerminalFacts(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'requestId'>,
  status: 'done' | 'failed' | 'cancelled',
  payload: unknown,
  goal: GoalResult | null,
  options?: TerminalFactOptions,
): Promise<ThreadEvent> {
  // The caller holds current attempt -> Run; the message and visible terminal
  // checkpoint are part of that same transaction, including persistence faults.
  const deltas = await client.query<{ delta: string }>(
    `SELECT c.payload->'payload'->>'delta' AS delta FROM run_checkpoints c
      JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind='message.delta'
      ORDER BY c.event_seq`,
    [context.runId],
  );
  const answer = deltas.rows.map((row) => row.delta).join('');
  if (options?.prepareGoal) {
    goal = await options.prepareGoal(client, answer);
    payload = { ...(payload as Record<string, unknown>), goal_result: goal };
  }
  // Only accepted assistant deltas become a message. A structured failure
  // without assistant output is a terminal event, not a synthesized turn.
  const text = goal?.answer ?? answer;
  if (text) {
    // Admission and compact publication freeze visible history under this same
    // owner-scoped row lock. Hold it until the assistant message commits.
    const conversation = await client.query(
      'SELECT 1 FROM conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [context.conversationId, context.ownerId],
    );
    if (!conversation.rowCount) throw stateConflict('conversation unavailable');
    await insertMessage(client, {
      ownerId: context.ownerId,
      conversationId: context.conversationId,
      role: 'assistant',
      content: text,
      requestId: null,
    });
  }
  const type =
    status === 'done'
      ? 'thread.completed'
      : status === 'failed'
        ? 'thread.failed'
        : 'thread.cancelled';
  await client.query(
    `UPDATE harness_pauses SET state='invalidated' WHERE owner_id=$1 AND run_id=$2 AND state IN ('pending','paused')`,
    [context.ownerId, context.runId],
  );
  const event = await appendEvent(client, context, type, payload);
  if (!options?.preserveAttemptStatus)
    await finishAttempt(client, context.attemptId, status === 'done' ? 'done' : 'failed');
  await client.query(
    `UPDATE agent_runs SET status=$2,ended_at=now(),waiting_checkpoint_id=NULL,
      waiting_invocation_id=NULL,waiting_approval_id=NULL,goal_result=$3::jsonb WHERE id=$1`,
    [context.runId, status, goal ? JSON.stringify(goal) : null],
  );
  return event;
}
