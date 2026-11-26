import { workspaceGrantSchema, type RunView } from '@along/contracts';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { PoolClient } from 'pg';
import {
  ApplicationError,
  forbidden,
  stateConflict,
  validationError,
} from '../../platform/errors.js';
import { getDocumentApproval } from '../../features/approvals/public.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import type { ConversationDeps, StartResult } from '../execution/contracts.js';
import {
  CancelRunBodySchema,
  ResumeRunBodySchema,
  insertAttempt,
  readRunEventCursor,
  listReleaseWaitingRuns,
  type RunRow,
  requirePool,
} from '../../features/conversations/public.js';
import { activeExecutions } from '../execution/driver/ownership.js';
import { commitTerminal } from '../execution/result/commit.js';
import { readSnapshot } from '../execution/attempt/restore-snapshot.js';
import { readRunApprovalDecision } from '../execution/load-approval-decision.js';
import { resumeRun } from './resume-run.js';
import { viewOf } from './run-view.js';
import {
  buildHarnessStart,
  contextOf,
  readSnapshotObservations,
  restoreSnapshotContext,
  unavailable,
  withLatest,
} from '../execution/attempt/context.js';
import { sessionAborts } from '../execution/attempt/session.js';

async function validateDocumentApprovalGrant(client: PoolClient, run: RunRow, approvalId: string) {
  const approval = await getDocumentApproval(client, run.owner_id, approvalId);
  const grant = workspaceGrantSchema.parse(approval.workspace_grant);
  if (
    approval.conversation_id !== run.conversation_id ||
    approval.run_id !== run.id ||
    !run.frozen_context?.workspaceGrants?.some(
      (member) => JSON.stringify(workspaceGrantSchema.parse(member)) === JSON.stringify(grant),
    )
  )
    throw forbidden('document approval workspace differs from frozen Run grants');
  validateWorkspaceGrant(run.owner_id, grant);
}

async function loadWaitingApproval(client: PoolClient, run: RunRow, checkpoint: string) {
  const snapshot = await readSnapshot(client, run, checkpoint);
  const waiting = snapshot.waiting;
  if (
    !waiting ||
    waiting.invocation_id !== run.waiting_invocation_id ||
    waiting.approval_id !== run.waiting_approval_id
  )
    throw stateConflict('waiting checkpoint reference conflict');
  const decision = await readRunApprovalDecision(
    client,
    { ownerId: run.owner_id, conversationId: run.conversation_id, runId: run.id },
    waiting.invocation_id,
    waiting.approval_id,
  );
  return { snapshot, decision };
}

async function assertUnusedWaitingPoint(client: PoolClient, checkpoint: string): Promise<void> {
  const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
    checkpoint,
  ]);
  if (used.rowCount) throw stateConflict('approval waiting point already resumed');
}

// Read-only release inspection is not an authorization to resume. The caller
// must run it again after stopping writers and resume revalidates under locks.
export async function inspectReleaseWaiting(
  deps: ConversationDeps,
): Promise<Array<{ runId: string; status: 'compatible' | 'blocked'; reason?: string }>> {
  const client = await requirePool(deps).connect();
  let temporaryAdmissions = false;
  try {
    const identity = await client.query<{ admissions: boolean; administrator: boolean }>(
      `SELECT to_regclass('identity_account_admissions') IS NOT NULL AS admissions,
              to_regclass('installation_admin') IS NOT NULL AS administrator`,
    );
    if (!identity.rows[0]!.admissions) {
      // Migration 0024 admits precisely the existing administrator. This
      // session-local view forecasts eligibility without changing stored facts.
      await client.query(
        identity.rows[0]!.administrator
          ? 'CREATE TEMP VIEW identity_account_admissions AS SELECT user_id FROM installation_admin'
          : 'CREATE TEMP VIEW identity_account_admissions AS SELECT NULL::uuid AS user_id WHERE false',
      );
      temporaryAdmissions = true;
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const table = await client.query<{ present: boolean; modelBindingsExist: boolean }>(
      `SELECT to_regclass('run_context_policies') IS NOT NULL AS present,
              to_regclass('model_provider_run_bindings') IS NOT NULL AS "modelBindingsExist"`,
    );
    const runs = await listReleaseWaitingRuns(client);
    const results: Array<{ runId: string; status: 'compatible' | 'blocked'; reason?: string }> = [];
    for (const run of runs) {
      try {
        if (!run.waiting_checkpoint_id || !run.waiting_invocation_id || !run.waiting_approval_id)
          throw stateConflict('incomplete waiting point');
        const attempt = await client.query(
          'SELECT 1 FROM run_attempts WHERE run_id=$1 AND owner_id=$2',
          [run.id, run.owner_id],
        );
        if (!attempt.rowCount) throw stateConflict('Run attempt missing');
        const { snapshot, decision } = await loadWaitingApproval(
          client,
          run,
          run.waiting_checkpoint_id,
        );
        if (
          snapshot.usage.iterations >= run.budget_max_iterations ||
          (snapshot.usage.tokens !== null && snapshot.usage.tokens >= run.budget_max_tokens)
        )
          throw stateConflict('waiting point budget exhausted');
        if (
          run.frozen_context?.authorization_revision === 'delegation/1' &&
          decision.kind === 'document'
        ) {
          if (decision.status === 'rejected') throw stateConflict('document approval rejected');
          await validateDocumentApprovalGrant(client, run, decision.approval_id);
        }
        await assertUnusedWaitingPoint(client, run.waiting_checkpoint_id);
        const context = await contextOf(
          client,
          deps,
          run,
          randomUUID(),
          randomUUID(),
          run.waiting_checkpoint_id,
          {
            tableExists: table.rows[0]!.present,
            modelBindingsExist: table.rows[0]!.modelBindingsExist,
          },
        );
        await restoreSnapshotContext(client, context, snapshot);
        const observations = await readSnapshotObservations(client, context, snapshot, {
          inspectOnly: true,
        });
        buildHarnessStart(context, snapshot, observations, decision);
        results.push({ runId: run.id, status: 'compatible' });
      } catch (error) {
        if (!(error instanceof ApplicationError) && !(error instanceof ZodError)) throw error;
        results.push({
          runId: run.id,
          status: 'blocked',
          reason: error instanceof ApplicationError ? error.errorCode : 'INVALID_HISTORICAL_SCHEMA',
        });
      }
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release(temporaryAdmissions);
  }
}

export async function getRunView(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
): Promise<RunView> {
  return withLatest(deps, ownerId, conversationId, runId, (client, locked) =>
    viewOf(client, locked, !!deps.modelTransport),
  );
}

export async function cancelConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
  expectedWaiting?: {
    checkpoint: string | null;
    invocation: string | null;
    approval: string | null;
  },
): Promise<RunView> {
  const parsed = CancelRunBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid cancel body');
  const input = parsed.data;
  const reason = input.reason ?? 'user_cancelled';
  const result = await withLatest(
    deps,
    ownerId,
    conversationId,
    runId,
    async (client, locked) => {
      if (
        expectedWaiting &&
        (locked.run.status !== 'suspended_approval' ||
          locked.run.waiting_checkpoint_id !== expectedWaiting.checkpoint ||
          locked.run.waiting_invocation_id !== expectedWaiting.invocation ||
          locked.run.waiting_approval_id !== expectedWaiting.approval)
      )
        throw stateConflict('selected waiting point changed');
      const previous = (
        await client.query<{ run_id: string; reason: string }>(
          'SELECT run_id,reason FROM harness_cancellations WHERE owner_id=$1 AND idempotency_key=$2',
          [ownerId, input.idempotency_key],
        )
      ).rows[0];
      if (previous && (previous.run_id !== runId || previous.reason !== reason))
        throw stateConflict('cancel idempotency key conflict');
      if (!previous)
        await client.query(
          'INSERT INTO harness_cancellations(owner_id,idempotency_key,run_id,reason) VALUES($1,$2,$3,$4)',
          [ownerId, input.idempotency_key, runId, reason],
        );
      await client.query(
        `UPDATE harness_pauses SET state='invalidated' WHERE run_id=$1 AND owner_id=$2 AND state IN ('pending','paused')`,
        [runId, ownerId],
      );
      await client.query(
        `UPDATE compact_operations
         SET status=CASE WHEN status IN ('pending','running') THEN 'cancelled' ELSE status END,
             candidate_status=CASE WHEN candidate_status='pending' THEN 'cancelled' ELSE candidate_status END,
             updated_at=now()
         WHERE run_id=$1 AND owner_id=$2 AND (status IN ('pending','running') OR
               (status='published' AND candidate_status='pending'))`,
        [runId, ownerId],
      );
      if (
        locked.run.status === 'running' ||
        locked.run.status === 'suspended_approval' ||
        locked.run.status === 'paused'
      ) {
        const terminal = await commitTerminal(
          client,
          { ownerId, conversationId, runId, attemptId: locked.attempt.id, requestId },
          'cancelled',
          {
            conversation_id: conversationId,
            run_id: runId,
            reason,
          },
        );
        if (terminal.protocol_version === 'v2' && terminal.type === 'thread.cancelled')
          locked.run.goal_result = terminal.payload.goal_result;
        locked.run.status = 'cancelled';
        locked.run.waiting_checkpoint_id = null;
        locked.run.waiting_invocation_id = null;
        locked.run.waiting_approval_id = null;
        locked.attempt.status = 'failed';
      }
      return viewOf(client, locked, !!deps.modelTransport);
    },
    false,
  );
  // Qualification has already been revoked durably before model/pipe abort.
  if (result.status === 'cancelled') {
    activeExecutions.get(runId)?.abort();
    for (const controller of sessionAborts.get(runId) ?? []) controller.abort();
  }
  return result;
}

export async function resumeConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
): Promise<StartResult> {
  const parsed = ResumeRunBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid resume body');
  const input = parsed.data;
  return resumeRun(
    deps,
    ownerId,
    conversationId,
    runId,
    input.idempotency_key,
    { kind: 'approval', id: input.checkpoint_id },
    async (client, locked, ownership) => {
      const run = locked.run;
      if (
        run.execution !== 'harness' ||
        run.status !== 'suspended_approval' ||
        run.waiting_checkpoint_id !== input.checkpoint_id ||
        !run.waiting_approval_id
      )
        throw stateConflict('Run has no matching approval waiting point', { status: run.status });
      await assertUnusedWaitingPoint(client, input.checkpoint_id);
      const { snapshot, decision } = await loadWaitingApproval(client, run, input.checkpoint_id);
      if (decision.status === 'pending')
        throw stateConflict('approval still pending', { status: 'pending' });
      if (
        run.frozen_context?.authorization_revision === 'delegation/1' &&
        decision.kind === 'document'
      ) {
        if (decision.status !== 'approved')
          throw stateConflict('rejected document approval cannot resume');
        await validateDocumentApprovalGrant(client, run, decision.approval_id);
      }
      if (!deps.harness) throw unavailable();
      if (
        snapshot.usage.iterations >= run.budget_max_iterations ||
        (snapshot.usage.tokens !== null && snapshot.usage.tokens >= run.budget_max_tokens)
      )
        throw new ApplicationError(429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
      const attemptId = randomUUID();
      const context = await contextOf(client, deps, run, attemptId, requestId, input.checkpoint_id);
      if (ownership) context.ownership = ownership;
      await restoreSnapshotContext(client, context, snapshot);
      const afterSeq = ownership ? await readRunEventCursor(client, runId) : null;
      const observations = await readSnapshotObservations(client, context, snapshot);
      buildHarnessStart(context, snapshot, observations, decision);
      await insertAttempt(client, {
        attemptId,
        ownerId,
        runId,
        attemptNo: locked.attempt.attempt_no + 1,
        ...(ownership ? { leaseToken: ownership.token } : {}),
      });
      await client.query(
        'INSERT INTO harness_resumes(owner_id,idempotency_key,run_id,checkpoint_id,attempt_id) VALUES($1,$2,$3,$4,$5)',
        [ownerId, input.idempotency_key, runId, input.checkpoint_id, attemptId],
      );
      await client.query(
        `UPDATE agent_runs SET status='running',waiting_checkpoint_id=NULL,
      waiting_invocation_id=NULL,waiting_approval_id=NULL WHERE id=$1`,
        [runId],
      );
      return { conversationId, runId, context, replay: null, ...(ownership ? { afterSeq } : {}) };
    },
  );
}
