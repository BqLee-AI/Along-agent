import type { PoolClient } from 'pg';
import { HarnessToolResultSchema, RunViewSchema, type RunView } from '@along/contracts';
import { AmbiguousTimeDetailsSchema } from '@along/stream-protocol';
import { readAcceptedInvocationResult } from '../invocations/accepted-result.js';

type RunBinding = { ownerId: string; conversationId: string; runId: string };

// Actual accepted tool outcomes, not model prose or a client's claimed relation.
export async function listReminderClarifications(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
): Promise<
  Array<{ runId: string; invocationId: string; kind: 'timezone' | 'fold'; timezone?: string }>
> {
  const { rows } = await client.query<{
    run_id: string;
    invocation_id: string;
    state: string;
    accepted_result: unknown;
  }>(
    `SELECT t.run_id,t.invocation_id,t.state,t.accepted_result FROM tool_invocations t
     WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.tool_id='propose_task'
       AND t.state='completed' AND t.outcome_kind IN ('clarification','time_error')
       AND NOT EXISTS (SELECT 1 FROM tool_invocations other WHERE other.run_id=t.run_id
         AND other.tool_id='propose_task' AND other.invocation_id<>t.invocation_id)`,
    [ownerId, conversationId],
  );
  const candidates: Array<{
    runId: string;
    invocationId: string;
    kind: 'timezone' | 'fold';
    timezone?: string;
  }> = [];
  for (const row of rows) {
    const parsed = HarnessToolResultSchema.safeParse(row.accepted_result);
    if (!parsed.success || parsed.data.status !== 'ok') continue;
    const result = parsed.data.result;
    if (result.kind === 'clarify' && result.reason === 'TIMEZONE_MISSING')
      candidates.push({ runId: row.run_id, invocationId: row.invocation_id, kind: 'timezone' });
    if (result.kind === 'time_error' && result.error.code === 'AMBIGUOUS_LOCAL_TIME') {
      const detail = AmbiguousTimeDetailsSchema.safeParse(result.error.details);
      if (detail.success)
        candidates.push({
          runId: row.run_id,
          invocationId: row.invocation_id,
          kind: 'fold',
          timezone: detail.data.timezone_id,
        });
    }
  }
  return candidates;
}

// Callers establish the owner/run binding; this read cannot admit or execute effects.
export async function readReminderTimeErrors(
  client: PoolClient,
  binding: RunBinding,
): Promise<NonNullable<RunView['reminder_time_errors']>> {
  const { rows } = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    outcome_kind: string | null;
    approval_id: string | null;
    accepted_result: unknown;
    frozen_context: { authorizationRevision?: unknown };
  }>(
    `SELECT invocation_id,tool_id,result_version,outcome_kind,approval_id,accepted_result,frozen_context
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='create_reminder' AND state='completed' ORDER BY accepted_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const errors: NonNullable<RunView['reminder_time_errors']> = [];
  for (const row of rows) {
    const result = await readAcceptedInvocationResult(client, binding, row);
    if (result.status === 'ok' && result.result.kind === 'time_error')
      errors.push(
        RunViewSchema.shape.reminder_time_errors.unwrap().element.parse({
          invocation_id: row.invocation_id,
          error: result.result.error,
        }),
      );
  }
  return errors;
}
