import type { PoolClient } from 'pg';
import { forbidden } from '../../http/errors.js';
import { isActiveOwner } from '../identity/preferences.js';

export interface ToolRunBinding {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
}

export async function assertToolRunBinding(
  client: PoolClient,
  binding: ToolRunBinding & { allowlist?: readonly string[] },
): Promise<void> {
  const row = (
    await client.query<{ execution: string; tools_allowlist: string[] }>(
      `SELECT r.execution,r.tools_allowlist FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id
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
}

// Match terminal writers: attempt before Run. Never acquire either after an
// invocation lock. Holding both through the business transaction serializes
// execution with cancellation; a historical read never grants execution.
export async function lockToolRunBinding(
  client: PoolClient,
  binding: ToolRunBinding & { allowlist?: readonly string[] },
): Promise<{ canExecute: boolean }> {
  const attempt = await client.query<{ status: string; attempt_no: number }>(
    `SELECT status, attempt_no FROM run_attempts
     WHERE id = $1 AND owner_id = $2 AND run_id = $3 FOR UPDATE`,
    [binding.attemptId, binding.ownerId, binding.runId],
  );
  const row = attempt.rows[0];
  if (!row) throw forbidden('invalid tool Run/attempt binding');
  const run = await client.query<{ status: string; execution: string; tools_allowlist: string[] }>(
    `SELECT r.status,r.execution,r.tools_allowlist FROM agent_runs r
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
    if (binding.allowlist?.some((tool) => !run.rows[0]!.tools_allowlist.includes(tool)))
      throw forbidden('tool scope exceeds frozen Run grant');
  }
  return { canExecute };
}
