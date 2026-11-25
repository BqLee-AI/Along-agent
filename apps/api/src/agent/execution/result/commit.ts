import type { PoolClient } from 'pg';
import { GoalResultSchema } from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { stateConflict } from '../../../platform/errors.js';
import type { RunContext } from '../contracts.js';
import { interruptedGoalResult } from './goal-result.js';
import {
  commitTerminalFacts,
  type TerminalFactOptions,
} from '../../../features/conversations/public.js';
import { hasPrivateOutput } from './private-output.js';

export async function commitTerminal(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'requestId'>,
  status: 'done' | 'failed' | 'cancelled',
  payload: unknown,
  options?: TerminalFactOptions,
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
    if (supplied === undefined && status === 'done' && !options?.prepareGoal)
      throw stateConflict('delegated terminal result is required');
    if (!options?.prepareGoal) {
      goal =
        supplied === undefined
          ? await interruptedGoalResult(client, context, status as 'failed' | 'cancelled')
          : GoalResultSchema.parse(supplied);
      payload = { ...(payload as Record<string, unknown>), goal_result: goal };
    }
  }
  const excludeAssistantFromHistory = await hasPrivateOutput(client, context);
  return commitTerminalFacts(client, context, status, payload, goal, {
    ...options,
    excludeAssistantFromHistory,
  });
}
