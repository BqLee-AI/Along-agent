import type { PoolClient } from 'pg';
import { GoalResultSchema, type GoalResult } from '@along/contracts';
import type { ToolContext } from '../tools/contracts.js';
import { readRunInvocationStates, readInvocationSnapshots } from '../tools/invocations.js';
import { readRunTimezoneSettings } from '../tools/query.js';
import { stateConflict } from '../../http/errors.js';

type Binding = Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>;
export async function validateGoalResult(
  client: PoolClient,
  context: ToolContext,
  supplied: unknown,
): Promise<GoalResult> {
  const goal = GoalResultSchema.parse(supplied);
  const states = await readRunInvocationStates(client, context);
  const refs = [...new Set(goal.outcomes.flatMap((item) => item.receipt_refs))];
  const accepted = await readInvocationSnapshots(client, context, refs);
  if (accepted.some((row) => row.result.status !== 'ok'))
    throw stateConflict('goal references unsuccessful receipt');
  const settings = await readRunTimezoneSettings(client, context);
  for (const setting of settings) {
    if (
      !goal.outcomes.some(
        (item) => item.status === 'achieved' && item.receipt_refs.includes(setting.invocation_id),
      )
    )
      throw stateConflict('goal omits an accepted setting effect');
  }
  if (
    states.some((row) => row.state === 'unknown') &&
    goal.status !== 'unknown' &&
    goal.status !== 'cancelled'
  )
    throw stateConflict('goal masks unknown tool effect');
  if (
    goal.status === 'completed' &&
    states.some((row) => row.state !== 'completed' || row.outcome_kind !== 'success')
  )
    throw stateConflict('goal completion has unresolved or rejected actions');
  return goal;
}

// Interruption is not a semantic reassessment of the user's goals: preserve
// known setting receipts and explicitly leave the remaining request unfinished.
export async function interruptedGoalResult(
  client: PoolClient,
  binding: Binding,
  status: 'failed' | 'cancelled',
): Promise<GoalResult> {
  const settings = await readRunTimezoneSettings(client, binding);
  const states = await readRunInvocationStates(client, binding);
  const unknown = states.some((row) => row.state === 'unknown');
  const outcomes: GoalResult['outcomes'] = settings.map((setting) => ({
    description:
      setting.timezone_id === null
        ? '已清除本人默认时区'
        : `已保存本人默认时区：${setting.timezone_id}`,
    status: 'achieved',
    receipt_refs: [setting.invocation_id],
  }));
  outcomes.push({
    description: '本轮剩余目标未完成；不会自动重做已接受设置',
    status: unknown ? 'unknown' : 'not_done',
    receipt_refs: [],
  });
  return GoalResultSchema.parse({
    status:
      status === 'cancelled'
        ? 'cancelled'
        : unknown
          ? 'unknown'
          : settings.length
            ? 'partial'
            : 'blocked',
    outcomes,
    clarification: null,
    answer: `${outcomes
      .slice(0, -1)
      .map((item) => item.description)
      .join(
        '；',
      )}${settings.length ? '。' : ''}本轮执行已中断；已接受的设置不会回滚，刷新或重连不会重做。${unknown ? '存在效果未知的调用，不会自动重试。' : ''}`,
  });
}
