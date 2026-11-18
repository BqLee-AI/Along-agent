import type { PoolClient } from 'pg';
import { z } from 'zod';
import { stateConflict } from '../../../platform/errors.js';
import { assertToolRunBinding } from '../../../features/conversations/public.js';
import type { ToolContext } from '../contracts.js';

const runInvocationStateSchema = z
  .object({
    invocation_id: z.string().uuid(),
    call_key: z.string(),
    tool_id: z.string(),
    approval_ref: z
      .object({
        kind: z.enum(['task', 'document']),
        approval_id: z.string().uuid(),
      })
      .strict()
      .nullable(),
    state: z.enum(['reserved', 'unknown', 'completed']),
    outcome_kind: z
      .enum(['success', 'approval_pending', 'clarification', 'time_error', 'denied', 'failed'])
      .nullable(),
    approval_id: z.string().uuid().nullable(),
  })
  .strict();
export type RunInvocationState = z.infer<typeof runInvocationStateSchema>;

export async function readRunInvocationStates(
  client: PoolClient,
  ctx: Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>,
): Promise<RunInvocationState[]> {
  await assertToolRunBinding(client, ctx);
  const { rows } = await client.query(
    `SELECT invocation_id, call_key, tool_id, state, outcome_kind, approval_id FROM tool_invocations
     WHERE owner_id = $1 AND conversation_id = $2 AND run_id = $3
     ORDER BY created_at, invocation_id`,
    [ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  return rows.map((row) => {
    const approvalRef =
      row.approval_id && row.outcome_kind === 'approval_pending'
        ? {
            kind: row.tool_id === 'workspace_propose_replace' ? 'document' : 'task',
            approval_id: row.approval_id,
          }
        : null;
    if (
      approvalRef?.kind === 'task' &&
      !['propose_task', 'request_cancel_task'].includes(row.tool_id)
    )
      throw stateConflict('invalid task approval tool reference');
    return runInvocationStateSchema.parse({ ...row, approval_ref: approvalRef });
  });
}

export interface RunInvocationIdentity {
  invocation_id: string;
  tool_id: string;
  args_hash: string;
  first_attempt_id: string;
  call_key: string;
  execution_kind: string;
}

/** Caller already holds execution qualification; this only reads invocation facts. */
export async function readRunInvocationIdentities(
  client: PoolClient,
  binding: Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>,
): Promise<RunInvocationIdentity[]> {
  return (
    await client.query<RunInvocationIdentity>(
      `SELECT invocation_id,tool_id,args_hash,first_attempt_id,call_key,execution_kind
        FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3`,
      [binding.ownerId, binding.conversationId, binding.runId],
    )
  ).rows;
}
