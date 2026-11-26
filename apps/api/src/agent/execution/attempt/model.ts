import { hasPendingPauseWithinTransaction } from '../../../features/conversations/public.js';
import {
  HarnessContextMeasurementSchema,
  HarnessModelStepSchema,
  type HarnessModelStep,
  type HarnessRequest,
} from '@along/contracts';
import { ApplicationError, forbidden, stateConflict } from '../../../platform/errors.js';
import { resolveRunSelection } from '../../../features/model-providers/public.js';
import { botScopeAllows, lockRunBotScope } from '../../../features/bots/public.js';
import { assertContextSourcesAuthorized } from '../../tools/invocations/context-source.js';
import { requireCurrentFeishuBotAuthority } from '../../tools/invocations/accepted-result.js';
import { readRunInvocationStates } from '../../tools/invocations/run-state.js';
import { assertBotPromptScope, withBotInstructions } from './bot-prompt-scope.js';
import { unavailable } from './context.js';
import {
  approvalAuthorizesActions,
  assertActionsUnblocked,
  type AttemptEnvironment,
} from './state.js';

/** Single-step transport handling shares the attempt's accepted usage and delta state. */
export function createModelHandlers(environment: AttemptEnvironment) {
  const {
    deps,
    context,
    initial,
    state: attemptState,
    tools,
    guarded,
    assertActionAuthority,
    sessionSignal,
    modelSignal,
    modelController,
  } = environment;
  async function closeModel(): Promise<void> {
    modelController.abort();
    const current = attemptState.modelStream;
    attemptState.modelStream = null;
    // The pending next() owns any transport error; cleanup must not replace it.
    const closing = current?.iterator.return().catch(() => undefined);
    if (context.ownership && sessionSignal.aborted) void closing;
    else await closing;
  }
  async function nextModelStep(): Promise<HarnessModelStep> {
    const current = attemptState.modelStream;
    if (!current || current.pendingDelta !== null || current.pulling)
      throw stateConflict('model continuation requires an acknowledged previous delta');
    current.pulling = true;
    try {
      await guarded(assertActionAuthority);
      const next = await current.iterator.next();
      if (next.done)
        throw new ApplicationError(502, 'HARNESS_PROTOCOL_ERROR', 'model ended without completion');
      const parsed = HarnessModelStepSchema.safeParse(next.value);
      if (!parsed.success)
        throw new ApplicationError(502, 'HARNESS_PROTOCOL_ERROR', 'model step rejected');
      const step = parsed.data;
      await guarded(assertActionAuthority);
      if (step.type === 'delta') current.pendingDelta = step.delta;
      else {
        if (step.type === 'complete') {
          attemptState.latestModelMessage =
            step.reply.message.tool_calls.length <= 1 ? step.reply.message : null;
          attemptState.modelToolCount = attemptState.delivered.size;
        } else attemptState.latestModelMessage = null;
        attemptState.cumulative.iterations++;
        const usage = step.type === 'complete' ? step.reply.usage : step.usage;
        attemptState.cumulative.tokens =
          attemptState.cumulative.tokens === null || usage === null
            ? null
            : attemptState.cumulative.tokens + usage.total_tokens;
        if (
          attemptState.cumulative.tokens !== null &&
          !Number.isSafeInteger(attemptState.cumulative.tokens)
        )
          throw new ApplicationError(502, 'HARNESS_PROTOCOL_ERROR', 'model usage overflow');
        attemptState.modelStream = null;
        await current.iterator.return();
      }
      return step;
    } catch (error) {
      await closeModel();
      throw error;
    } finally {
      current.pulling = false;
    }
  }
  async function next(request: Extract<HarnessRequest, { type: 'model_next' }>) {
    if (!attemptState.modelStream || request.model_ref !== attemptState.modelStream.ref)
      throw stateConflict('model continuation reference conflict');
    return nextModelStep();
  }
  async function model(request: Extract<HarnessRequest, { type: 'model' | 'measure_context' }>) {
    attemptState.measuredForCompact = false;
    if (
      (context.executionProfile === 'pause/1' ||
        context.executionProfile === 'pause-memory/1' ||
        context.executionProfile === 'compact-memory/1') &&
      request.type === 'model'
    ) {
      if (!attemptState.nextPermit) throw stateConflict('model requires a safe-point permit');
      attemptState.nextPermit = false;
    }
    if (!approvalAuthorizesActions(initial.approval))
      throw forbidden('rejected approval cannot authorize another action');
    if (!deps.harness || !context.contextPolicy) throw unavailable();
    const remaining =
      attemptState.cumulative.tokens === null
        ? null
        : Math.max(0, context.maxTokens - attemptState.cumulative.tokens);
    if (request.remaining_tokens !== remaining)
      throw stateConflict('model balance must match accepted cumulative usage');
    if (attemptState.cumulative.iterations >= context.maxIterations)
      throw new ApplicationError(429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
    if (!deps.modelTransport) throw unavailable();
    const { selected, permittedTools } = await guarded(async (client) => {
      const selected = await resolveRunSelection(client, context.ownerId, context.runId);
      const scope = context.personalBot ? await lockRunBotScope(client, context) : null;
      return {
        selected,
        permittedTools: scope
          ? tools.filter((tool) => tool.name === 'finish_goal' || botScopeAllows(scope, tool.name))
          : tools,
      };
    });
    if (!selected) throw stateConflict('legacy Run model binding unavailable');
    if (selected.model_id !== context.contextPolicy.model_binding.model) throw unavailable();
    const transport = await deps.modelTransport(selected, {
      runId: context.runId,
      attemptId: context.attemptId,
      operation: 'model',
    });
    const effective = withBotInstructions(request, context.personalBot);
    const measurement = await transport.measure(
      { ...effective, type: 'measure_context' },
      permittedTools,
      context.contextPolicy,
    );
    if (request.type === 'measure_context') {
      const measured = HarnessContextMeasurementSchema.parse(measurement);
      attemptState.measuredForCompact =
        context.autoCompactPolicy !== undefined &&
        measured.input_meter.input_tokens !== null &&
        measured.input_meter.meter_revision === context.autoCompactPolicy.meterRevision &&
        measured.limit_reason === null;
      return measured;
    }
    const scheduled = await guarded(async (client) => {
      await assertActionAuthority(client);
      if (
        context.executionProfile === 'pause/1' ||
        context.executionProfile === 'pause-memory/1' ||
        context.executionProfile === 'compact-memory/1'
      ) {
        const pending = await hasPendingPauseWithinTransaction(client, context);
        if (pending) return false;
      }
      if (measurement.limit_reason || request.max_output_tokens > measurement.output_ceiling) {
        const budget =
          measurement.limit_reason === 'budget' ||
          (remaining !== null && request.max_output_tokens > remaining);
        throw new ApplicationError(
          budget ? 429 : 422,
          budget ? 'BUDGET_EXCEEDED' : 'HARNESS_CONTEXT_LIMIT',
          '模型请求超过本轮额度或容量。',
        );
      }
      const states = await readRunInvocationStates(client, context);
      assertActionsUnblocked(states, initial.snapshot?.tool_refs);
      const observations = context.personalBot
        ? states
            .filter(
              (row) =>
                row.state === 'completed' &&
                row.outcome_kind !== 'denied' &&
                row.outcome_kind !== 'failed',
            )
            .map((row) => row.invocation_id)
        : [];
      const privateReceipt = states.some(
        (row) =>
          row.tool_id === 'feishu_docx_read' &&
          row.state === 'completed' &&
          row.outcome_kind === 'success',
      );
      if (privateReceipt) await requireCurrentFeishuBotAuthority(client, context);
      // Hold the Run and Feishu grant locks through local enqueue, not the provider response.
      const authorizeDispatch =
        privateReceipt || context.personalBot
          ? (enqueue: () => void) =>
              guarded(async (current) => {
                await assertActionAuthority(current);
                if (context.personalBot) {
                  const scope = await lockRunBotScope(current, context);
                  if (
                    permittedTools.some(
                      (tool) => tool.name !== 'finish_goal' && !botScopeAllows(scope, tool.name),
                    )
                  )
                    throw forbidden('Bot tool scope changed before provider dispatch');
                  await assertBotPromptScope(current, context, scope);
                  await assertContextSourcesAuthorized(current, context, observations);
                }
                if (privateReceipt) await requireCurrentFeishuBotAuthority(current, context);
                enqueue();
              })
          : undefined;
      // Establish the model reservation under the same attempt → Run
      // locks used by pause registration, before invoking the transport.
      attemptState.modelStream = {
        ref: request.request_ref,
        iterator: transport
          .model({ ...effective, type: 'model' }, permittedTools, modelSignal, authorizeDispatch)
          [Symbol.asyncIterator](),
        pendingDelta: null,
        pulling: false,
      };
      attemptState.modelStarted = true;
      attemptState.lastModelInputTokens = measurement.input_meter.input_tokens;
      return true;
    });
    if (!scheduled) return { type: 'pause_requested' };
    return nextModelStep();
  }
  return { close: closeModel, next, model };
}
