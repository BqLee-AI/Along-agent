import type { PoolClient } from 'pg';
import { forbidden } from '../../http/errors.js';
import { isActiveOwner } from '../identity/preferences.js';
import { workspaceGrantSchema, type WorkspaceGrant } from '@along/contracts';
import { validateWorkspaceGrant, WorkspaceDeniedError } from '../workspaces/service.js';
import { latestAttemptId, lockRun } from './repository.js';

export interface ToolRunBinding {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
}

type ToolScope = { allowlist?: readonly string[]; workspaceGrant?: WorkspaceGrant | null };

function validateFrozenWorkspace(
  ownerId: string,
  frozenContext: { workspaceGrant?: unknown } | null,
  binding: ToolScope,
  acceptRevokedFact = false,
): boolean {
  const frozen =
    frozenContext?.workspaceGrant == null
      ? null
      : workspaceGrantSchema.parse(frozenContext.workspaceGrant);
  // This boundary is for execution scopes. History-only projections authorize
  // the owner/Run relationship without resolving current workspace authority.
  if ('allowlist' in binding || 'workspaceGrant' in binding) {
    const supplied =
      binding.workspaceGrant == null ? null : workspaceGrantSchema.parse(binding.workspaceGrant);
    if (JSON.stringify(supplied) !== JSON.stringify(frozen))
      throw forbidden('workspace scope differs from frozen Run grant');
  }
  if (frozen) {
    try {
      validateWorkspaceGrant(ownerId, frozen);
    } catch (error) {
      if (acceptRevokedFact && error instanceof WorkspaceDeniedError) return false;
      throw error;
    }
  }
  return true;
}

export async function assertToolRunBinding(
  client: PoolClient,
  binding: Pick<ToolRunBinding, 'ownerId' | 'conversationId' | 'runId'> & ToolScope,
): Promise<void> {
  const row = (
    await client.query<{
      execution: string;
      tools_allowlist: string[];
      frozen_context: { workspaceGrant?: unknown } | null;
    }>(
      `SELECT r.execution,r.tools_allowlist,r.frozen_context FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id
      WHERE r.id=$1 AND r.owner_id=$2 AND c.owner_id=$2 AND r.conversation_id=$3`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!row) throw forbidden('invalid tool conversation/Run binding');
  if (row.execution === 'harness' && !(await isActiveOwner(client, binding.ownerId)))
    throw forbidden('Run authorization revoked');
  if (
    row.execution === 'harness' &&
    binding.allowlist?.some((tool) => !row.tools_allowlist.includes(tool))
  )
    throw forbidden('tool scope exceeds frozen Run grant');
  if ('allowlist' in binding || 'workspaceGrant' in binding)
    validateFrozenWorkspace(binding.ownerId, row.frozen_context, binding);
}

// Match terminal writers: attempt before Run. Never acquire either after an
// invocation lock. Holding both through the business transaction serializes
// execution with cancellation; a historical read never grants execution.
async function lockToolBinding(
  client: PoolClient,
  binding: ToolRunBinding & ToolScope,
  acceptRevokedFact: boolean,
): Promise<{ canExecute: boolean }> {
  const attempt = await client.query<{ status: string; attempt_no: number }>(
    `SELECT status, attempt_no FROM run_attempts
     WHERE id = $1 AND owner_id = $2 AND run_id = $3 FOR UPDATE`,
    [binding.attemptId, binding.ownerId, binding.runId],
  );
  const row = attempt.rows[0];
  if (!row) throw forbidden('invalid tool Run/attempt binding');
  const run = await client.query<{
    status: string;
    execution: string;
    tools_allowlist: string[];
    frozen_context: { workspaceGrant?: unknown } | null;
  }>(
    `SELECT r.status,r.execution,r.tools_allowlist,r.frozen_context FROM agent_runs r
     WHERE r.id = $1 AND r.owner_id = $2 AND r.conversation_id = $3
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.conversation_id AND c.owner_id = $2)
     FOR UPDATE OF r`,
    [binding.runId, binding.ownerId, binding.conversationId],
  );
  if (!run.rows[0]) throw forbidden('invalid tool conversation/Run binding');
  const latest = await client.query<{ attempt_no: number }>(
    'SELECT max(attempt_no) AS attempt_no FROM run_attempts WHERE run_id = $1',
    [binding.runId],
  );
  let canExecute =
    run.rows[0].status === 'running' &&
    row.status === 'running' &&
    row.attempt_no === latest.rows[0]?.attempt_no;
  if (run.rows[0].execution === 'harness') {
    canExecute = canExecute && (await isActiveOwner(client, binding.ownerId));
    if (binding.allowlist?.some((tool) => !run.rows[0]!.tools_allowlist.includes(tool))) {
      if (!acceptRevokedFact) throw forbidden('tool scope exceeds frozen Run grant');
      canExecute = false;
    }
  }
  const workspaceAuthorized = validateFrozenWorkspace(
    binding.ownerId,
    run.rows[0]!.frozen_context,
    binding,
    acceptRevokedFact,
  );
  canExecute = canExecute && workspaceAuthorized;
  return { canExecute };
}

export function lockToolRunBinding(
  client: PoolClient,
  binding: ToolRunBinding & ToolScope,
): Promise<{ canExecute: boolean }> {
  return lockToolBinding(client, binding, false);
}

// Only final acceptance of already dispatched, invocation-bound external
// evidence uses this boundary. A false execution qualification must not erase
// a late real effect; it still prevents disclosure or any subsequent dispatch.
export function lockToolEffectAcceptanceBinding(
  client: PoolClient,
  binding: ToolRunBinding & ToolScope,
): Promise<{ canExecute: boolean }> {
  return lockToolBinding(client, binding, true);
}

// Public authorization boundary for approval buttons: all locks are acquired
// before approvals takes its own proposal/approval locks.
export async function lockDocumentApprovalRun(
  client: PoolClient,
  binding: Pick<ToolRunBinding, 'ownerId' | 'conversationId' | 'runId'>,
): Promise<{ canAuthorize: boolean }> {
  const attemptId = await latestAttemptId(client, binding.ownerId, binding.runId);
  const { run } = await lockRun(client, { ...binding, attemptId }, false, false);
  const canAuthorize =
    run.execution === 'harness' &&
    (run.status === 'running' || run.status === 'suspended_approval') &&
    (await isActiveOwner(client, binding.ownerId));
  if (canAuthorize) validateFrozenWorkspace(binding.ownerId, run.frozen_context, {});
  return { canAuthorize };
}
