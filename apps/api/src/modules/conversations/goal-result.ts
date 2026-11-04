import type { PoolClient } from 'pg';
import { GoalResultSchema, HarnessToolResultSchema, type GoalResult } from '@along/contracts';
import type { ToolContext } from '../tools/contracts.js';
import { readRunInvocationStates, readInvocationSnapshots } from '../tools/invocations.js';
import {
  readRunTimezoneSettings,
  readRunCreatedReminders,
  readRunCancelledReminders,
  readRunInterruptionEvidence,
} from '../tools/query.js';
import { readCancellationScopeInput, readContinuationReceipts } from './target-continuation.js';
import { stateConflict } from '../../http/errors.js';
import { readActiveSameNoteTasks, readRepeatedNotesMentioned } from '../tasks/tool-query.js';
import {
  isUnspecifiedSameNoteCancellation,
  renderCancellationClarification,
} from '../tools/reminder-cancel-scope.js';

type Binding = Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>;
async function inheritedGoal(
  client: PoolClient,
  binding: Binding,
): Promise<{
  runId: string;
  goal: GoalResult;
  cancellations: Array<{
    invocationId: string;
    taskId: string;
    state: 'cancel_pending' | 'cancelled';
  }>;
} | null> {
  const row = (
    await client.query<{ continuation: unknown }>(
      `SELECT frozen_context->'trustedExecutionContext'->'continuation' AS continuation
     FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  const continuation = row?.continuation;
  if (
    !continuation ||
    typeof continuation !== 'object' ||
    !('goal_result' in continuation) ||
    !('run_id' in continuation) ||
    typeof continuation.run_id !== 'string'
  )
    return null;
  const goal = GoalResultSchema.safeParse(continuation.goal_result);
  if (!goal.success) return null;
  const cancellations: Array<{
    invocationId: string;
    taskId: string;
    state: 'cancel_pending' | 'cancelled';
  }> = [];
  if ('receipts' in continuation && Array.isArray(continuation.receipts)) {
    for (const receipt of continuation.receipts) {
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        receipt.tool_id !== 'cancel_reminder' ||
        typeof receipt.invocation_id !== 'string'
      )
        continue;
      const result = HarnessToolResultSchema.safeParse(receipt.result);
      if (
        result.success &&
        result.data.status === 'ok' &&
        result.data.result.kind === 'reminder_cancelled'
      )
        cancellations.push({
          invocationId: receipt.invocation_id,
          taskId: result.data.result.task_id,
          state: result.data.result.state,
        });
    }
  }
  return { runId: continuation.run_id, goal: goal.data, cancellations };
}

export async function validateGoalResult(
  client: PoolClient,
  context: ToolContext,
  supplied: unknown,
): Promise<GoalResult> {
  const goal = GoalResultSchema.parse(supplied);
  const states = await readRunInvocationStates(client, context);
  const refs = [...new Set(goal.outcomes.flatMap((item) => item.receipt_refs))];
  const inherited = await inheritedGoal(client, context);
  const inheritedRefs = new Set(
    inherited?.goal.outcomes
      .filter((item) => item.status === 'achieved')
      .flatMap((item) => item.receipt_refs) ?? [],
  );
  const inheritedCancellations = new Set(
    inherited?.cancellations.map((item) => item.invocationId) ?? [],
  );
  if (inherited) {
    await readContinuationReceipts(
      client,
      context,
      inherited.runId,
      [...new Set([...inheritedRefs, ...inheritedCancellations])],
      context.timeContext,
    );
    for (const ref of inheritedRefs) {
      if (
        !goal.outcomes.some((item) => item.status === 'achieved' && item.receipt_refs.includes(ref))
      )
        throw stateConflict('goal omits an inherited accepted effect');
    }
    for (const ref of inheritedCancellations) {
      if (!goal.outcomes.some((item) => item.receipt_refs.includes(ref)))
        throw stateConflict('goal omits an inherited cancellation request');
    }
  }
  const accepted = await readInvocationSnapshots(
    client,
    context,
    refs.filter((ref) => !inheritedRefs.has(ref) && !inheritedCancellations.has(ref)),
  );
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
  const creations = await readRunCreatedReminders(client, context);
  for (const creation of creations) {
    if (
      !goal.outcomes.some(
        (item) => item.status === 'achieved' && item.receipt_refs.includes(creation.invocation_id),
      )
    )
      throw stateConflict('goal omits an accepted reminder creation');
  }
  const cancellations = await readRunCancelledReminders(client, context);
  for (const cancellation of cancellations) {
    if (!goal.outcomes.some((item) => item.receipt_refs.includes(cancellation.invocation_id)))
      throw stateConflict('goal omits an accepted reminder cancellation');
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
  if (
    goal.status === 'blocked' &&
    goal.clarification?.kind === 'target_selection' &&
    cancellations.length === 0 &&
    creations.length === 0 &&
    settings.length === 0 &&
    inheritedRefs.size === 0 &&
    inheritedCancellations.size === 0
  ) {
    const scope = await readCancellationScopeInput(client, context);
    if (scope.revision === 'scope/1') {
      const notes = await readRepeatedNotesMentioned(
        client,
        context.ownerId,
        scope.original ?? scope.current,
      );
      if (
        notes.length === 1 &&
        isUnspecifiedSameNoteCancellation(scope.original ?? scope.current, notes[0]!)
      ) {
        const candidates = await readActiveSameNoteTasks(client, context.ownerId, notes[0]!);
        if (candidates.length > 1) {
          const question = renderCancellationClarification(candidates);
          return {
            ...goal,
            clarification: { kind: 'target_selection', question },
            answer: question,
          };
        }
      }
    }
  }
  return goal;
}

// Interruption is not a semantic reassessment of the user's goals: preserve
// known setting receipts and explicitly leave the remaining request unfinished.
export async function interruptedGoalResult(
  client: PoolClient,
  binding: Binding,
  status: 'failed' | 'cancelled',
): Promise<GoalResult> {
  const {
    settings,
    creations,
    cancellations,
    hasUnknown: unknown,
  } = await readRunInterruptionEvidence(client, binding);
  const inherited = await inheritedGoal(client, binding);
  const outcomes: GoalResult['outcomes'] = settings.map((setting) => ({
    description:
      setting.timezone_id === null
        ? '已清除本人默认时区'
        : `已保存本人默认时区：${setting.timezone_id}`,
    status: 'achieved',
    receipt_refs: [setting.invocation_id],
  }));
  outcomes.push(...(inherited?.goal.outcomes.filter((item) => item.status === 'achieved') ?? []));
  const alreadyInherited = new Set(outcomes.flatMap((item) => item.receipt_refs));
  outcomes.push(
    ...(inherited?.cancellations
      .filter((item) => !alreadyInherited.has(item.invocationId))
      .map((item) => ({
        description:
          item.state === 'cancelled'
            ? `提醒 ${item.taskId} 已取消`
            : `提醒 ${item.taskId} 取消请求已接受，等待撤销回执`,
        status: 'achieved' as const,
        receipt_refs: [item.invocationId],
      })) ?? []),
  );
  outcomes.push(
    ...creations.map((creation) => ({
      description: `已记录提醒：${creation.original_note ?? creation.task_id}`,
      status: 'achieved' as const,
      receipt_refs: [creation.invocation_id],
    })),
  );
  outcomes.push(
    ...cancellations.map((cancellation) => ({
      description:
        cancellation.state === 'cancelled'
          ? `提醒 ${cancellation.task_id} 已取消`
          : `提醒 ${cancellation.task_id} 取消请求已接受，等待撤销回执`,
      status: 'achieved' as const,
      receipt_refs: [cancellation.invocation_id],
    })),
  );
  outcomes.push({
    description: '本轮剩余目标未完成；不会自动重做已接受效果',
    status: unknown ? 'unknown' : 'not_done',
    receipt_refs: [],
  });
  return GoalResultSchema.parse({
    status:
      status === 'cancelled'
        ? 'cancelled'
        : unknown
          ? 'unknown'
          : outcomes.length > 1
            ? 'partial'
            : 'blocked',
    outcomes,
    clarification: null,
    answer: `${outcomes
      .slice(0, -1)
      .map((item) => item.description)
      .join(
        '；',
      )}${outcomes.length > 1 ? '。' : ''}本轮执行已中断；已接受的设置和提醒不会回滚，刷新或重连不会重做。${unknown ? '存在效果未知的调用，不会自动重试。' : ''}`,
  });
}
