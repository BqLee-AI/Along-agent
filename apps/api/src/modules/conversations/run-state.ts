import type { PoolClient } from 'pg';
import { HistoricalHarnessSnapshotSchema } from '@along/contracts';
import type { HarnessApprovalDecision, HarnessSnapshot, RunView } from '@along/contracts';
import {
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  type ThreadEvent,
} from '@along/stream-protocol';
import { stateConflict } from '../../http/errors.js';
import {
  appendCheckpoint,
  finishAttempt,
  insertMessage,
  type LockedRun,
  type RunRow,
} from './repository.js';
import type { RunContext } from './contracts.js';
import { readApprovalDecision, readDocumentApprovalDecision } from '../approvals/decision.js';
import { readRunInvocationStates } from '../tools/invocations.js';
import { BUSINESS_TOOL_IDS } from '../tools/contracts.js';
import { validateWorkspaceGrant, WorkspaceDeniedError } from '../workspaces/service.js';

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

// Approval storage selection comes only from tools' immutable invocation
// projection, never from a native kind claim or an untrusted approval UUID.
export async function readRunApprovalDecision(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string },
  invocationId: string,
  approvalId: string,
): Promise<HarnessApprovalDecision> {
  const states = await readRunInvocationStates(client, binding);
  const row = states.find((state) => state.invocation_id === invocationId);
  if (
    row?.state !== 'completed' ||
    row.outcome_kind !== 'approval_pending' ||
    !row.approval_ref ||
    row.approval_ref.approval_id !== approvalId
  )
    throw stateConflict('invalid trusted approval invocation reference');
  if (row.approval_ref.kind === 'document') {
    if (row.tool_id !== 'workspace_propose_replace')
      throw stateConflict('document approval tool mismatch');
    const { run_id, ...decision } = await readDocumentApprovalDecision(
      client,
      binding.ownerId,
      approvalId,
    );
    if (run_id !== binding.runId) throw stateConflict('document approval Run mismatch');
    return decision;
  }
  if (row.tool_id !== 'propose_task' && row.tool_id !== 'request_cancel_task')
    throw stateConflict('task approval tool mismatch');
  return readApprovalDecision(client, binding.ownerId, approvalId);
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
    ? await readRunApprovalDecision(
        client,
        {
          ownerId: run.owner_id,
          conversationId: run.conversation_id,
          runId: run.id,
        },
        waiting.invocation_id,
        waiting.approval_id,
      )
    : null;
  // Historical summaries are receipt facts, not current workspace authority.
  // Pre-summary workspace Runs remain readable/cancellable without inventing
  // metadata from a current registration that may represent different access.
  const workspace = run.frozen_context?.workspaceGrant ? run.frozen_context.workspaceSummary : null;
  let canResume =
    run.execution === 'harness' &&
    run.status === 'suspended_approval' &&
    decision !== null &&
    decision.status !== 'pending';
  // Eligibility reflects current authority without making historical reads
  // depend on it. Resume itself still validates before allocating an attempt.
  if (canResume && run.frozen_context?.workspaceGrant) {
    try {
      validateWorkspaceGrant(run.owner_id, run.frozen_context.workspaceGrant);
    } catch (error) {
      if (!(error instanceof WorkspaceDeniedError)) throw error;
      canResume = false;
    }
  }
  return {
    run_id: run.id,
    conversation_id: run.conversation_id,
    execution: run.execution,
    status: run.status,
    attempt_id: attempt.id,
    attempt_no: attempt.attempt_no,
    waiting:
      waiting && decision?.kind === 'document'
        ? { ...waiting, approval_kind: 'document' }
        : waiting,
    ...(workspace ? { workspace } : {}),
    can_resume: canResume,
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
  const snapshot = HistoricalHarnessSnapshotSchema.parse(checkpoint.payload);
  if (snapshot.version === 1) {
    if (run.frozen_context?.workspaceGrant)
      throw stateConflict('historical snapshot cannot gain workspace authority');
    const states = await readRunInvocationStates(client, {
      ownerId: run.owner_id,
      conversationId: run.conversation_id,
      runId: run.id,
    });
    for (const invocationId of snapshot.tool_refs) {
      const row = states.find((state) => state.invocation_id === invocationId);
      if (
        !row ||
        row.state !== 'completed' ||
        !(BUSINESS_TOOL_IDS as readonly string[]).includes(row.tool_id) ||
        row.approval_ref?.kind === 'document'
      )
        throw stateConflict('historical snapshot contains non-task capability');
    }
  }
  return { ...snapshot, version: 2 };
}
