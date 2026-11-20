import { httpStatusForError, workspaceGrantSchema, type RunView } from '@along/contracts';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { THREAD_PROTOCOL_VERSION } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import {
  ApplicationError,
  forbidden,
  stateConflict,
  validationError,
} from '../../platform/errors.js';
import { getDocumentApproval } from '../../features/approvals/public.js';
import { readRunContextObservations } from '../tools/invocations/context-query.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import { runNativeHarness } from '../harness/harness-process.js';
import type {
  ConversationDeps,
  EventWriter,
  RunContext,
  StartResult,
} from '../runtime/contracts.js';
import {
  CancelRunBodySchema,
  ResumeRunBodySchema,
  insertAttempt,
  listRunEvents,
  lockRun,
  type RunRow,
  appendEvent,
} from '../../features/conversations/public.js';
import { withRunTransaction, type RunOwnership } from '../runtime/run-ownership.js';
import { commitTerminal } from './finish.js';
import { readSnapshot } from '../runtime/run-snapshot.js';
import { readRunApprovalDecision } from './run-approval-decision.js';
import { viewOf } from './run-view.js';
import { validateR3SnapshotContext } from '../runtime/compact-continuation.js';
import {
  buildHarnessStart,
  contextOf,
  poolOf,
  toolContext,
  unavailable,
  withLatest,
} from '../runtime/context.js';
import { createHarnessSession, sessionAborts } from '../runtime/attempt-session.js';

export const active = new Map<string, AbortController>();
function eventPayload(context: RunContext) {
  return { conversation_id: context.conversationId, run_id: context.runId };
}

// Read-only release inspection is not an authorization to resume. The caller
// must run it again after stopping writers and resume revalidates under locks.
export async function inspectReleaseWaiting(
  deps: ConversationDeps,
): Promise<Array<{ runId: string; status: 'compatible' | 'blocked'; reason?: string }>> {
  const client = await poolOf(deps).connect();
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
    const runs = await client.query<RunRow>(
      "SELECT * FROM agent_runs WHERE execution='harness' AND status='suspended_approval' ORDER BY id",
    );
    const results: Array<{ runId: string; status: 'compatible' | 'blocked'; reason?: string }> = [];
    for (const run of runs.rows) {
      try {
        if (!run.waiting_checkpoint_id || !run.waiting_invocation_id || !run.waiting_approval_id)
          throw stateConflict('incomplete waiting point');
        const attempt = await client.query(
          'SELECT 1 FROM run_attempts WHERE run_id=$1 AND owner_id=$2',
          [run.id, run.owner_id],
        );
        if (!attempt.rowCount) throw stateConflict('Run attempt missing');
        const snapshot = await readSnapshot(client, run, run.waiting_checkpoint_id);
        if (
          snapshot.waiting?.invocation_id !== run.waiting_invocation_id ||
          snapshot.waiting?.approval_id !== run.waiting_approval_id
        )
          throw stateConflict('waiting checkpoint reference conflict');
        const decision = await readRunApprovalDecision(
          client,
          { ownerId: run.owner_id, conversationId: run.conversation_id, runId: run.id },
          run.waiting_invocation_id,
          run.waiting_approval_id,
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
          const approval = await getDocumentApproval(client, run.owner_id, decision.approval_id);
          const grant = workspaceGrantSchema.parse(approval.workspace_grant);
          if (
            approval.conversation_id !== run.conversation_id ||
            approval.run_id !== run.id ||
            !run.frozen_context.workspaceGrants?.some(
              (member) =>
                JSON.stringify(workspaceGrantSchema.parse(member)) === JSON.stringify(grant),
            )
          )
            throw forbidden('document approval workspace differs from frozen Run grants');
          validateWorkspaceGrant(run.owner_id, grant);
        }
        const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
          run.waiting_checkpoint_id,
        ]);
        if (used.rowCount) throw stateConflict('approval waiting point already resumed');
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
        if (snapshot.version === 4) {
          await validateR3SnapshotContext(client, context, snapshot);
          context.r3Context = snapshot.context;
        }
        const observations = await readRunContextObservations(
          client,
          toolContext(context),
          snapshot.tool_refs,
          { project: context.allowlist.includes('read_run_observation') },
        );
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
  if (result.status === 'cancelled') active.get(runId)?.abort();
  if (result.status === 'cancelled')
    for (const controller of sessionAborts.get(runId) ?? []) controller.abort();
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
  const pool = poolOf(deps);
  const current = (
    await pool.query<{ lifecycle: string | null; prior: boolean }>(
      `SELECT frozen_context->>'execution_lifecycle' AS lifecycle,
       EXISTS (SELECT 1 FROM harness_resumes WHERE owner_id=$1 AND idempotency_key=$4) AS prior
     FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND id=$3`,
      [ownerId, conversationId, runId, input.idempotency_key],
    )
  ).rows[0];
  let ownership: RunOwnership | undefined;
  if (current?.lifecycle === 'server-owned' && !current.prior) {
    if (!deps.runDriver) throw unavailable();
    ownership = await deps.runDriver.acquire(runId, true);
  }
  let result: StartResult;
  try {
    result = await withLatest(
      deps,
      ownerId,
      conversationId,
      runId,
      async (client, locked) => {
        const prior = (
          await client.query<{ run_id: string; checkpoint_id: string; attempt_id: string }>(
            'SELECT run_id,checkpoint_id,attempt_id FROM harness_resumes WHERE owner_id=$1 AND idempotency_key=$2',
            [ownerId, input.idempotency_key],
          )
        ).rows[0];
        if (prior) {
          if (prior.run_id !== runId || prior.checkpoint_id !== input.checkpoint_id)
            throw stateConflict('resume idempotency key conflict');
          const attempt = (
            await client.query<{ status: string }>('SELECT status FROM run_attempts WHERE id=$1', [
              prior.attempt_id,
            ])
          ).rows[0];
          if (attempt?.status === 'running')
            throw stateConflict('resumed Run still running', {
              status: 'running',
              run_id: runId,
              attempt_id: prior.attempt_id,
            });
          const events = await listRunEvents(client, ownerId, runId);
          const seqs = (
            await client.query<{ event_seq: string }>(
              'SELECT event_seq FROM run_checkpoints WHERE attempt_id=$1',
              [prior.attempt_id],
            )
          ).rows.map((row) => Number(row.event_seq));
          const selected = new Set(seqs);
          return {
            conversationId,
            runId,
            context: null,
            replay: events.filter((event) => selected.has(event.seq)),
          };
        }
        const run = locked.run;
        if (run.frozen_context?.execution_lifecycle === 'server-owned' && !ownership)
          throw stateConflict('Run ownership required');
        if (
          run.execution !== 'harness' ||
          run.status !== 'suspended_approval' ||
          run.waiting_checkpoint_id !== input.checkpoint_id ||
          !run.waiting_approval_id
        )
          throw stateConflict('Run has no matching approval waiting point', { status: run.status });
        const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
          input.checkpoint_id,
        ]);
        if (used.rowCount) throw stateConflict('approval waiting point already resumed');
        const snapshot = await readSnapshot(client, run, input.checkpoint_id);
        if (
          !snapshot.waiting ||
          snapshot.waiting.invocation_id !== run.waiting_invocation_id ||
          snapshot.waiting.approval_id !== run.waiting_approval_id
        )
          throw stateConflict('waiting checkpoint reference conflict');
        const decision = await readRunApprovalDecision(
          client,
          { ownerId, conversationId, runId },
          snapshot.waiting.invocation_id,
          run.waiting_approval_id,
        );
        if (decision.status === 'pending')
          throw stateConflict('approval still pending', { status: 'pending' });
        if (
          run.frozen_context?.authorization_revision === 'delegation/1' &&
          decision.kind === 'document' &&
          decision.status !== 'approved'
        )
          throw stateConflict('rejected document approval cannot resume');
        if (
          run.frozen_context?.authorization_revision === 'delegation/1' &&
          decision.kind === 'document'
        ) {
          const approval = await getDocumentApproval(client, ownerId, decision.approval_id);
          const grant = workspaceGrantSchema.parse(approval.workspace_grant);
          if (
            approval.conversation_id !== conversationId ||
            approval.run_id !== runId ||
            !run.frozen_context.workspaceGrants?.some(
              (member) =>
                JSON.stringify(workspaceGrantSchema.parse(member)) === JSON.stringify(grant),
            )
          )
            throw forbidden('document approval workspace differs from frozen Run grants');
          validateWorkspaceGrant(ownerId, grant);
        }
        if (!deps.harness) throw unavailable();
        if (
          snapshot.usage.iterations >= run.budget_max_iterations ||
          (snapshot.usage.tokens !== null && snapshot.usage.tokens >= run.budget_max_tokens)
        )
          throw new ApplicationError(429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
        const attemptId = randomUUID();
        const context = await contextOf(
          client,
          deps,
          run,
          attemptId,
          requestId,
          input.checkpoint_id,
        );
        if (ownership) context.ownership = ownership;
        if (snapshot.version === 4) {
          await validateR3SnapshotContext(client, context, snapshot);
          context.r3Context = snapshot.context;
        }
        const afterSeq = ownership
          ? Number(
              (
                await client.query<{ seq: string }>(
                  `SELECT COALESCE(max(c.event_seq),0)::text AS seq FROM run_checkpoints c
           JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1`,
                  [runId],
                )
              ).rows[0]!.seq,
            )
          : null;
        const observations = await readRunContextObservations(
          client,
          toolContext(context),
          snapshot.tool_refs,
          { project: context.allowlist.includes('read_run_observation') },
        );
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
      true,
      ownership,
    );
  } catch (error) {
    if (ownership) await deps.runDriver!.release(ownership);
    throw error;
  }
  if (ownership && result.context) {
    try {
      deps.runDriver!.start(deps, result.context);
    } catch (error) {
      await deps.runDriver!.release(ownership);
      throw error;
    }
    return {
      conversationId,
      runId,
      context: null,
      replay: null,
      serverOwned: true,
      afterSeq: result.afterSeq ?? null,
    };
  }
  if (ownership) await deps.runDriver!.release(ownership);
  return result;
}

export async function executeHarness(
  deps: ConversationDeps,
  context: RunContext,
  write: EventWriter,
  signal?: AbortSignal,
  interruption?: AbortSignal,
): Promise<void> {
  const pool = poolOf(deps);
  if (!deps.harness) throw unavailable();
  const controller = new AbortController();
  const ownershipLost = () => controller.abort();
  context.ownership?.signal.addEventListener('abort', ownershipLost, { once: true });
  interruption?.addEventListener('abort', ownershipLost, { once: true });
  if (context.ownership?.signal.aborted || interruption?.aborted) controller.abort();
  active.set(context.runId, controller);
  let cancellation: Promise<unknown> | undefined;
  let cancellationFailure: { error: unknown } | undefined;
  let cancellationProjected = false;
  let closeSession: (() => Promise<void>) | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const disconnected = () => {
    cancellation ??= cancelConversationRun(
      deps,
      context.ownerId,
      context.conversationId,
      context.runId,
      context.requestId,
      { idempotency_key: randomUUID(), reason: 'client_disconnected' },
    ).catch((error: unknown) => {
      cancellationFailure = { error };
    });
  };
  signal?.addEventListener('abort', disconnected, { once: true });
  try {
    if (signal?.aborted) {
      disconnected();
      await cancellation;
      return;
    }
    const sessionWrite: EventWriter = async (event, authority) => {
      const open = await write(event, authority);
      if (open && event.type === 'thread.cancelled') cancellationProjected = true;
      if (!open) {
        disconnected();
        // The private publication transaction must release the Run before cancellation can lock it.
        if (authority !== 'held') await cancellation;
      }
      return open;
    };
    if (write.ready) sessionWrite.ready = write.ready;
    const session = await createHarnessSession(
      deps,
      context,
      sessionWrite,
      controller.signal,
      context.ownership ? 'subscription' : 'inline',
    );
    closeSession = session.close;
    if (session.start.snapshot === null) {
      const event = await withRunTransaction(pool, context.ownership, async (client) => {
        await lockRun(client, context);
        return appendEvent(client, context, 'thread.started', {
          ...eventPayload(context),
          stream_protocol_version: THREAD_PROTOCOL_VERSION,
          ruleset_id: context.timeContext.ruleset_id,
          tzdb_version: context.timeContext.tzdb_version,
        });
      });
      if (!(await write(event))) {
        disconnected();
        await cancellation;
        return;
      }
    }
    await runNativeHarness({
      services: deps.harness,
      start: session.start,
      signal: controller.signal,
      guardStart: session.guardStart,
      guardReply: session.guardReply,
      detachOnAbort: !!context.ownership,
      onExit: session.close,
      handleRequest: (request) => {
        const pending = (async () => {
          // No next native action may overtake a disconnect's durable decision.
          await cancellation;
          if (cancellationFailure) throw cancellationFailure.error;
          return session.handleRequest(request);
        })();
        if (context.ownership) {
          inFlight.add(pending);
          void pending.then(
            () => inFlight.delete(pending),
            () => inFlight.delete(pending),
          );
        }
        return pending;
      },
    });
    // An external revocation stops the native process without throwing. Still
    // account for a disabled owner's running attempt while ownership is held;
    // a committed cancellation already wins the terminal-state check.
    if (interruption?.aborted) throw new Error('server-owned execution interrupted');
  } catch (error) {
    await cancellation;
    try {
      const failed = await withRunTransaction(pool, context.ownership, async (client) => {
        // Revocation rejects execution, but may not prevent recording its failure.
        await lockRun(client, context, true, false);
        const code = error instanceof ApplicationError ? error.errorCode : 'INTERNAL_ERROR';
        return commitTerminal(client, context, 'failed', {
          ...eventPayload(context),
          error: {
            code,
            message: error instanceof ApplicationError ? error.message : '原生执行失败。',
            http_status: error instanceof ApplicationError ? httpStatusForError(error.code) : 500,
          },
        });
      });
      // Durable accounting does not authorize disclosure to the old connection.
      // Reuse the ordinary owner/Run read gate after the terminal commit.
      await withTransaction(pool, (client) => lockRun(client, context, false));
      await write(failed);
    } catch {
      // Stale/terminal authority wins; revoked readers receive no failure content.
    }
  } finally {
    try {
      await closeSession?.();
      signal?.removeEventListener('abort', disconnected);
      context.ownership?.signal.removeEventListener('abort', ownershipLost);
      interruption?.removeEventListener('abort', ownershipLost);
      if (active.get(context.runId) === controller) active.delete(context.runId);
      // Project the committed stop before waiting for already-dispatched effects.
      if (controller.signal.aborted && !signal?.aborted && !cancellationProjected) {
        const events = await listRunEvents(pool, context.ownerId, context.runId);
        const cancelled = events.find((event) => event.type === 'thread.cancelled');
        if (cancelled) await write(cancelled);
      }
    } finally {
      // Keep the execution slot and control pool alive through late accounting.
      await Promise.allSettled(inFlight);
    }
  }
}
