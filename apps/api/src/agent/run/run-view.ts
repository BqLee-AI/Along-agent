import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { workspaceGrantSchema, type RunView } from '@along/contracts';
import { ApplicationError } from '../../platform/errors.js';
import { hasPendingPrivateTerminal, type LockedRun } from '../../features/conversations/public.js';
import { getDocumentApproval } from '../../features/approvals/public.js';
import { validateWorkspaceGrant, WorkspaceDeniedError } from '../../features/workspaces/public.js';
import {
  readRunCreatedReminders,
  readRunGoalDocumentEvidence,
  readRunReminderTimeErrors,
} from '../tools/evidence/run-evidence.js';
import { getRunSelections, isRunSelectionUsable } from '../../features/model-providers/public.js';
import { readRunApprovalDecision } from '../execution/load-approval-decision.js';
import { supportsFrozenTools } from '../execution/attempt/frozen-tool-eligibility.js';
import { readSnapshot } from '../execution/attempt/restore-snapshot.js';

export async function viewOf(
  client: PoolClient,
  locked: LockedRun,
  modelTransportAvailable: boolean,
): Promise<RunView> {
  const { run, attempt } = locked;
  const pause = (
    await client.query<{
      id: string;
      reason: 'user' | 'runtime';
      purpose: 'none' | 'manual_compact' | 'automatic_compact';
      state: 'pending' | 'paused';
    }>(
      `SELECT id,reason,purpose,state FROM harness_pauses
     WHERE owner_id=$1 AND run_id=$2 AND state IN ('pending','paused')`,
      [run.owner_id, run.id],
    )
  ).rows[0];
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
      if (!(error instanceof ApplicationError) && !(error instanceof ZodError)) throw error;
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
    pause: pause
      ? { pause_id: pause.id, reason: pause.reason, purpose: pause.purpose, status: pause.state }
      : null,
    can_pause:
      run.execution === 'harness' &&
      (run.frozen_context?.execution_profile === 'pause/1' ||
        run.frozen_context?.execution_profile === 'pause-memory/1' ||
        run.frozen_context?.execution_profile === 'compact-memory/1') &&
      run.status === 'running' &&
      !pause,
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
          goal_result:
            run.goal_result && !(await hasPendingPrivateTerminal(client, run.id))
              ? run.goal_result
              : null,
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
