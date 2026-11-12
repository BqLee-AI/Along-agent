import type { PoolClient } from 'pg';
import { GoalResultSchema, HarnessToolResultSchema, type GoalResult } from '@along/contracts';
import type { ToolContext } from '../tools/contracts.js';
import { readRunInvocationStates, readInvocationSnapshots } from '../tools/invocations.js';
import {
  readRunTimezoneSettings,
  readRunCreatedReminders,
  readRunCancelledReminders,
  readRunInterruptionEvidence,
  readRunGoalDocumentEvidence,
  validateCreateResolutionEvidence,
} from '../tools/query.js';
import type { RunGoalDocumentEvidence } from '../tools/query.js';
import { readCancellationScopeInput, readContinuationReceipts } from './target-continuation.js';
import { stateConflict } from '../../http/errors.js';
import { readActiveSameNoteTasks, readRepeatedNotesMentioned } from '../tasks/tool-query.js';
import {
  candidatesInCancellationRequest,
  isBoundedCancellationForNote,
  renderCancellationClarification,
} from '../tools/reminder-cancel-scope.js';

type Binding = Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>;
export function validateGoalDocuments(goal: GoalResult, documents: RunGoalDocumentEvidence): void {
  for (const effect of documents.effects) {
    const referenced = goal.outcomes.filter((item) =>
      item.receipt_refs.includes(effect.invocation_id),
    );
    if ((effect.status === 'applied' || effect.status === 'verified') && referenced.length === 0)
      throw stateConflict('goal omits an accepted document effect');
    if (
      effect.status !== 'verified' &&
      referenced.some(
        (item) =>
          item.status === 'achieved' &&
          !(
            effect.status === 'conflict' &&
            item.create_resolution?.zero_write_invocation_ids.includes(effect.invocation_id)
          ),
      )
    )
      throw stateConflict('goal claims an unverified document effect');
    if (
      effect.status === 'verified' &&
      referenced.some((item) => item.status === 'achieved') &&
      (!effect.read_invocation_id ||
        !goal.outcomes.some(
          (item) =>
            item.status === 'achieved' && item.receipt_refs.includes(effect.read_invocation_id!),
        ))
    )
      throw stateConflict('goal omits the fresh document read');
  }
  if (
    goal.status === 'completed' &&
    (documents.hasPendingApproval ||
      documents.effects.some(
        (effect) =>
          effect.status !== 'verified' && !(effect.status === 'conflict' && effect.superseded),
      ))
  )
    throw stateConflict('goal completion has unresolved document effects');
}

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

async function applyCreateResolutions(
  client: PoolClient,
  binding: Binding,
  goal: GoalResult,
  documents: RunGoalDocumentEvidence,
): Promise<void> {
  const outcomes = goal.outcomes.filter((item) => item.create_resolution);
  if (!outcomes.length) return;
  const row = (
    await client.query<{
      input_message_id: string;
      revision: string | null;
      original_id: string | null;
      original_text: string | null;
    }>(
      `SELECT input_message_id,frozen_context->>'createResolutionRevision' AS revision,
        frozen_context->'trustedExecutionContext'->'continuation'->>'original_input_message_id' AS original_id,
        frozen_context->'trustedExecutionContext'->'continuation'->>'original_text' AS original_text
       FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
         AND frozen_context->>'authorization_revision'='delegation/1'`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!row || !['create-resolution/1', 'create-resolution/2'].includes(row.revision ?? ''))
    throw stateConflict('create resolution is not enabled for this run');
  const messages = await client.query<{ id: string; content: string }>(
    `SELECT id,content FROM messages WHERE owner_id=$1 AND conversation_id=$2
       AND role='user' AND id=ANY($3::uuid[])`,
    [
      binding.ownerId,
      binding.conversationId,
      [row.input_message_id, ...(row.original_id ? [row.original_id] : [])],
    ],
  );
  const used = new Set<string>();
  for (const outcome of outcomes) {
    const resolution = outcome.create_resolution!;
    const source = messages.rows.find((message) => message.id === resolution.source_message_id);
    const authenticOriginal =
      source?.id === row.original_id && source.content === row.original_text;
    if (
      !source ||
      (source.id !== row.input_message_id && !authenticOriginal) ||
      !resolution.source_quote ||
      !source.content.includes(resolution.source_quote)
    )
      throw stateConflict('invalid create resolution source');
    const refs = [
      ...resolution.zero_write_invocation_ids,
      resolution.created_invocation_id,
      resolution.read_invocation_id,
    ];
    if (
      outcome.status !== 'achieved' ||
      !resolution.zero_write_invocation_ids.length ||
      new Set(refs).size !== refs.length ||
      refs.some(
        (ref) =>
          used.has(ref) ||
          !outcome.receipt_refs.includes(ref) ||
          goal.outcomes.some((other) => other !== outcome && other.receipt_refs.includes(ref)),
      )
    )
      throw stateConflict(
        'create resolution requires all distinct collision, creation and read IDs in the same outcome receipt_refs, not reused by other outcomes',
      );
    refs.forEach((ref) => used.add(ref));
    await validateCreateResolutionEvidence(client, binding, resolution, documents);
    for (const id of resolution.zero_write_invocation_ids)
      documents.effects.find((effect) => effect.invocation_id === id)!.superseded = true;
    documents.effects.find(
      (effect) => effect.invocation_id === resolution.created_invocation_id,
    )!.read_invocation_id = resolution.read_invocation_id;
  }
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
  for (const snapshot of accepted) {
    if (
      snapshot.tool_id.startsWith('workspace_') &&
      snapshot.result.status === 'ok' &&
      snapshot.result.result.kind === 'operation_error' &&
      goal.outcomes.some(
        (item) => item.status === 'achieved' && item.receipt_refs.includes(snapshot.invocation_id),
      )
    )
      throw stateConflict('goal claims a document operation error as an effect');
  }
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
  const documents = await readRunGoalDocumentEvidence(client, context);
  await applyCreateResolutions(client, context, goal, documents);
  validateGoalDocuments(goal, documents);
  if (
    states.some((row) => row.state === 'unknown') &&
    goal.status !== 'unknown' &&
    goal.status !== 'cancelled'
  )
    throw stateConflict('goal masks unknown tool effect');
  if (
    goal.status === 'completed' &&
    states.some(
      (row) =>
        row.state !== 'completed' ||
        (row.outcome_kind !== 'success' &&
          !(
            row.outcome_kind === 'approval_pending' &&
            documents.resolvedApprovalInvocationIds.includes(row.invocation_id)
          )),
    )
  )
    throw stateConflict('goal completion has unresolved or rejected actions');
  if (
    goal.status === 'blocked' &&
    goal.clarification?.kind === 'target_selection' &&
    cancellations.length === 0 &&
    creations.length === 0 &&
    settings.length === 0 &&
    documents.effects.length === 0 &&
    !documents.hasPendingApproval &&
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
        isBoundedCancellationForNote(scope.original ?? scope.current, notes[0]!)
      ) {
        const candidates = await readActiveSameNoteTasks(client, context.ownerId, notes[0]!);
        if (candidates.length > 1) {
          const question = renderCancellationClarification(
            candidatesInCancellationRequest(scope.original ?? scope.current, notes[0]!, candidates),
          );
          await client.query(
            `UPDATE agent_runs SET cancellation_scope_candidates=$3::jsonb WHERE id=$1 AND owner_id=$2`,
            [
              context.runId,
              context.ownerId,
              JSON.stringify({ original: scope.original ?? scope.current, question }),
            ],
          );
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
    documents,
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
  outcomes.push(
    ...documents
      .filter((effect) => effect.status !== 'unknown')
      .map((effect) => ({
        description:
          effect.status === 'verified'
            ? `资料 ${effect.path} 已${effect.operation === 'create' ? '创建' : '保存'}并经新读取验证`
            : effect.status === 'applied'
              ? `资料 ${effect.path} 已${effect.operation === 'create' ? '创建' : '保存'}，但尚未经新读取验证`
              : effect.status === 'failed'
                ? `资料 ${effect.path} 创建失败，未写入`
                : effect.superseded
                  ? `资料 ${effect.path} 曾发生零写冲突，已有后续调用`
                  : `资料 ${effect.path} ${effect.operation === 'create' ? '创建' : '修改'}发生冲突，未确认完成`,
        status: effect.status === 'verified' ? ('achieved' as const) : ('not_done' as const),
        receipt_refs:
          effect.status === 'verified' && effect.read_invocation_id
            ? [effect.invocation_id, effect.read_invocation_id]
            : [effect.invocation_id],
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
          : outcomes.some((item) => item.status === 'achieved')
            ? 'partial'
            : 'blocked',
    outcomes,
    clarification: null,
    answer: `${outcomes
      .slice(0, -1)
      .map((item) => item.description)
      .join(
        '；',
      )}${outcomes.length > 1 ? '。' : ''}本轮执行已中断；已接受的效果不会回滚，刷新或重连不会重做。${unknown ? '存在效果未知的调用，不会自动重试。' : ''}`,
  });
}
