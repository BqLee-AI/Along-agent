import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import {
  HistoricalHarnessSnapshotSchema,
  GoalResultSchema,
  workspaceGrantSchema,
} from '@along/contracts';
import type { HarnessApprovalDecision, HarnessSnapshot, RunView } from '@along/contracts';
import {
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  type ThreadEvent,
} from '@along/stream-protocol';
import { HttpError, stateConflict } from '../../http/errors.js';
import {
  appendCheckpoint,
  finishAttempt,
  insertMessage,
  type LockedRun,
  type RunRow,
} from './repository.js';
import type { RunContext } from './contracts.js';
import { readApprovalDecision, readDocumentApprovalDecision } from '../approvals/decision.js';
import { getDocumentApproval } from '../approvals/document-query.js';
import { readRunInvocationStates } from '../tools/invocations.js';
import {
  BUSINESS_TOOL_IDS,
  DELEGATION_TOOL_IDS,
  DELEGATION_WORKSPACE_READ_TOOL_IDS,
  DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
  DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
  HARNESS_BASE_TOOL_IDS,
  TOOL_IDS,
} from '../tools/contracts.js';
import { validateWorkspaceGrant, WorkspaceDeniedError } from '../workspaces/service.js';
import { interruptedGoalResult } from './goal-result.js';
import {
  readRunCreatedReminders,
  readRunGoalDocumentEvidence,
  readRunReminderTimeErrors,
} from '../tools/query.js';
import { getRunSelections, isRunSelectionUsable } from '../model-providers/service.js';

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

export async function commitTerminal(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'requestId'>,
  status: 'done' | 'failed' | 'cancelled',
  payload: unknown,
  options?: { preserveAttemptStatus: boolean },
): Promise<ThreadEvent> {
  // The caller holds current attempt -> Run; the message and visible terminal
  // checkpoint are part of that same transaction, including persistence faults.
  const run = (
    await client.query<{ revision: string | null }>(
      `SELECT frozen_context->>'authorization_revision' AS revision FROM agent_runs WHERE id=$1 AND owner_id=$2`,
      [context.runId, context.ownerId],
    )
  ).rows[0];
  let goal = null;
  if (run?.revision === 'delegation/1') {
    const supplied =
      payload && typeof payload === 'object' && 'goal_result' in payload
        ? payload.goal_result
        : undefined;
    if (supplied === undefined && status === 'done')
      throw stateConflict('delegated terminal result is required');
    goal =
      supplied === undefined
        ? await interruptedGoalResult(client, context, status as 'failed' | 'cancelled')
        : GoalResultSchema.parse(supplied);
    payload = { ...(payload as Record<string, unknown>), goal_result: goal };
  }
  const deltas = await client.query<{ delta: string }>(
    `SELECT c.payload->'payload'->>'delta' AS delta FROM run_checkpoints c
      JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind='message.delta'
      ORDER BY c.event_seq`,
    [context.runId],
  );
  // Only accepted assistant deltas become a message. A structured failure
  // without assistant output is a terminal event, not a synthesized turn.
  const text = goal?.answer ?? deltas.rows.map((row) => row.delta).join('');
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
  if (!options?.preserveAttemptStatus)
    await finishAttempt(client, context.attemptId, status === 'done' ? 'done' : 'failed');
  await client.query(
    `UPDATE agent_runs SET status=$2,ended_at=now(),waiting_checkpoint_id=NULL,
      waiting_invocation_id=NULL,waiting_approval_id=NULL,goal_result=$3::jsonb WHERE id=$1`,
    [context.runId, status, goal ? JSON.stringify(goal) : null],
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

const delegationTools: readonly string[] = [
  ...DELEGATION_TOOL_IDS,
  ...DELEGATION_WORKSPACE_READ_TOOL_IDS,
  ...DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
  ...DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
];

export function supportsFrozenTools(run: RunRow): boolean {
  const frozen = run.frozen_context;
  if (!frozen) return false;
  const supported: readonly string[] = frozen.authorization_revision
    ? delegationTools
    : frozen.workspaceGrant
      ? TOOL_IDS
      : HARNESS_BASE_TOOL_IDS;
  return run.tools_allowlist.every((name) => supported.includes(name));
}

export async function viewOf(
  client: PoolClient,
  locked: LockedRun,
  modelTransportAvailable: boolean,
): Promise<RunView> {
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
  const modelSelection =
    (await getRunSelections(client, run.owner_id, [run.id])).get(run.id) ??
    (run.execution === 'business'
      ? { state: 'not_applicable' as const }
      : { state: 'legacy_unavailable' as const });
  let canResume =
    run.execution === 'harness' &&
    modelTransportAvailable &&
    modelSelection.state === 'available' &&
    run.status === 'suspended_approval' &&
    decision !== null &&
    decision.status !== 'pending' &&
    supportsFrozenTools(run);
  if (canResume) {
    canResume = await isRunSelectionUsable(client, run.owner_id, run.id);
  }
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
  // Delegated document approval is tied to one frozen member, not the
  // registration currently associated with the same name or another member.
  if (
    canResume &&
    run.frozen_context?.authorization_revision === 'delegation/1' &&
    decision?.kind === 'document'
  ) {
    canResume = decision.status === 'approved';
    if (canResume) {
      const approval = await getDocumentApproval(client, run.owner_id, decision.approval_id);
      const grant = workspaceGrantSchema.parse(approval.workspace_grant);
      const members = run.frozen_context.workspaceGrants ?? [];
      canResume =
        approval.conversation_id === run.conversation_id &&
        approval.run_id === run.id &&
        members.some(
          (member) => JSON.stringify(workspaceGrantSchema.parse(member)) === JSON.stringify(grant),
        );
      if (canResume) {
        try {
          validateWorkspaceGrant(run.owner_id, grant);
        } catch (error) {
          if (!(error instanceof WorkspaceDeniedError)) throw error;
          canResume = false;
        }
      }
    }
  }
  if (canResume && waiting) {
    try {
      const snapshot = await readSnapshot(client, run, waiting.checkpoint_id);
      const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
        waiting.checkpoint_id,
      ]);
      canResume =
        snapshot.waiting?.invocation_id === waiting.invocation_id &&
        snapshot.waiting?.approval_id === waiting.approval_id &&
        snapshot.usage.iterations < run.budget_max_iterations &&
        (snapshot.usage.tokens === null || snapshot.usage.tokens < run.budget_max_tokens) &&
        !used.rowCount;
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof ZodError)) throw error;
      canResume = false;
    }
  }
  const documentEffects =
    run.frozen_context?.authorization_revision === 'delegation/1' &&
    run.frozen_context.workspaceGrants !== undefined &&
    run.tools_allowlist.includes('workspace_read')
      ? (
          await readRunGoalDocumentEvidence(client, {
            ownerId: run.owner_id,
            conversationId: run.conversation_id,
            runId: run.id,
          })
        ).effects.map(
          ({
            status,
            workspace_id,
            path,
            invocation_id,
            read_invocation_id,
            version,
            operation,
          }) => ({
            status,
            workspace_id,
            path,
            invocation_id,
            read_invocation_id,
            version,
            ...(operation ? { operation } : {}),
          }),
        )
      : undefined;
  return {
    run_id: run.id,
    conversation_id: run.conversation_id,
    execution: run.execution,
    model_selection: modelSelection,
    status: run.status,
    attempt_id: attempt.id,
    attempt_no: attempt.attempt_no,
    waiting:
      waiting && decision?.kind === 'document'
        ? { ...waiting, approval_kind: 'document' }
        : waiting,
    ...(documentEffects ? { document_effects: documentEffects } : {}),
    ...(workspace ? { workspace } : {}),
    ...(run.frozen_context?.workspaceGrants !== undefined &&
    run.frozen_context.trustedExecutionContext
      ? { workspaces: run.frozen_context.trustedExecutionContext.workspaces }
      : {}),
    ...(run.frozen_context?.authorization_revision
      ? {
          authorization_revision: run.frozen_context.authorization_revision,
          execution_lifecycle: run.frozen_context.execution_lifecycle,
          goal_result: run.goal_result,
          created_reminders: await readRunCreatedReminders(client, {
            ownerId: run.owner_id,
            conversationId: run.conversation_id,
            runId: run.id,
          }),
          reminder_time_errors: await readRunReminderTimeErrors(client, {
            ownerId: run.owner_id,
            conversationId: run.conversation_id,
            runId: run.id,
          }),
        }
      : {}),
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
