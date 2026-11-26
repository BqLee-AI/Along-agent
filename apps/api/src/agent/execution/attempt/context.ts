import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_R3_PROTOCOL_VERSION,
  HARNESS_CONTEXT_PROTOCOL_VERSION,
  HARNESS_MAX_FRAME_BYTES,
  HarnessR3ContextStartSchema,
  HarnessStartSchema,
  type HarnessSnapshot,
  type HarnessPauseSnapshot,
  type HarnessR3ContextStart,
  type HarnessR3Snapshot,
  type HarnessStart,
  type HarnessApprovalDecision,
  type RoutingPolicy,
} from '@along/contracts';
import { ApplicationError, stateConflict } from '../../../platform/errors.js';
import { omitRetainedDocxObservations } from '../../tools/invocations/context-source.js';
import { readRunContextObservations } from '../../tools/invocations/context-query.js';
import {
  HARNESS_TOOL_DEFINITIONS,
  DELEGATION_TOOL_DEFINITIONS,
  R3_MEMORY_TOOL_DEFINITIONS,
  R3_COMPACT_MEMORY_TOOL_DEFINITIONS,
  R3_MEMORY_SOURCE_TOOL_DEFINITION,
} from '../../tools/catalog.js';
import { validateWorkspaceGrant } from '../../../features/workspaces/public.js';
import type { ConversationDeps, RunContext } from '../contracts.js';
import { readRunContextPolicy } from '../../../features/conversations/public.js';
import { withRunTransaction, type RunOwnership } from '../driver/ownership.js';
import {
  latestAttemptId,
  requirePool,
  lockRun,
  type LockedRun,
  type RunRow,
  validateR3SnapshotContext,
  readHarnessMessages,
  readR3Context,
  readR3ControlContext,
  AutoCompactPolicySchema,
} from '../../../features/conversations/public.js';
import { supportsFrozenTools } from './frozen-tool-eligibility.js';
import { resolveRunSelection } from '../../../features/model-providers/public.js';

export function unavailable(): ApplicationError {
  return new ApplicationError(503, 'HARNESS_UNAVAILABLE', '原生 Agent 暂不可用。');
}
function isStale(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    error.errorCode === 'STATE_CONFLICT' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'reason' in error.details &&
    error.details.reason === 'STALE_ATTEMPT'
  );
}

export async function withLatest<T>(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  action: (client: PoolClient, locked: LockedRun) => Promise<T>,
  authorize = true,
  ownership?: RunOwnership,
): Promise<T> {
  const pool = requirePool(deps);
  for (;;) {
    const attemptId = await latestAttemptId(pool, ownerId, runId);
    try {
      return await withRunTransaction(pool, ownership, async (client) => {
        if (ownership) await ownership.assert(client, runId);
        const locked = await lockRun(
          client,
          { ownerId, conversationId, runId, attemptId },
          false,
          authorize,
        );
        return action(client, locked);
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw stateConflict('action idempotency key conflict');
      if (!isStale(error)) throw error;
      // resume committed after our discovery; relocate without replaying effects.
    }
  }
}

export async function contextOf(
  client: PoolClient,
  deps: ConversationDeps,
  run: RunRow,
  attemptId: string,
  requestId: string,
  checkpointId?: string,
  candidatePolicy?: { tableExists: boolean; modelBindingsExist: boolean },
): Promise<RunContext> {
  const frozen = run.frozen_context;
  if (!frozen) throw stateConflict('Run accepted input missing');
  const control = frozen.execution_profile === 'compact-memory/1' && run.input_message_id === null;
  if (!control && !run.input_message_id) throw stateConflict('Run accepted input missing');
  const message = control
    ? null
    : (
        await client.query<{ content: string }>(
          `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
          [run.input_message_id, run.owner_id, run.conversation_id],
        )
      ).rows[0];
  if (!control && !message) throw stateConflict('Run accepted message missing');
  if (
    deps.timeContext.ruleset_id !== frozen.rulesetId ||
    deps.timeContext.tzdb_version !== frozen.tzdbVersion ||
    (frozen.aliasVersion !== null &&
      (!deps.timeContext.available || deps.timeContext.aliases.version !== frozen.aliasVersion))
  )
    throw new ApplicationError(503, 'TZDB_UNAVAILABLE', '接纳时的时间规则暂不可用。');
  if (frozen.workspaceGrant) validateWorkspaceGrant(run.owner_id, frozen.workspaceGrant);
  if (candidatePolicy && !candidatePolicy.modelBindingsExist)
    throw stateConflict('legacy Run model binding unavailable; cannot resume');
  const contextPolicy = candidatePolicy
    ? ((candidatePolicy.tableExists
        ? await readRunContextPolicy(client, run.owner_id, run.id)
        : null) ?? deps.harness?.contextPolicy)
    : await readRunContextPolicy(client, run.owner_id, run.id);
  const selected = await resolveRunSelection(client, run.owner_id, run.id);
  if (!selected) throw stateConflict('legacy Run model binding unavailable; cannot resume');
  if (
    !contextPolicy ||
    !deps.harness ||
    contextPolicy.model_binding.model !== selected.model_id ||
    contextPolicy.model_binding.adapter_revision !==
      deps.harness.contextPolicy.model_binding.adapter_revision
  )
    throw unavailable();
  if (!supportsFrozenTools(run)) throw stateConflict('unsupported frozen tool in historical Run');
  if (!deps.modelTransport) throw unavailable();
  const r3Context =
    frozen.execution_profile === 'compact-memory/1'
      ? control
        ? await readR3ControlContext(client, {
            ownerId: run.owner_id,
            conversationId: run.conversation_id,
            runId: run.id,
          })
        : await readR3Context(client, {
            ownerId: run.owner_id,
            conversationId: run.conversation_id,
            runId: run.id,
            userMessageId: run.input_message_id!,
          })
      : undefined;
  if (
    r3Context &&
    (control
      ? r3Context.input.type !== 'compact_control'
      : r3Context.input.type !== 'user' ||
        r3Context.input.message_id !== run.input_message_id ||
        r3Context.input.content !== message!.content)
  )
    throw stateConflict('R3 context input differs from accepted message');
  const messageRefs = frozen.messageRefs ?? (run.input_message_id ? [run.input_message_id] : []);
  const messages = r3Context
    ? [
        ...r3Context.messages,
        ...(control
          ? []
          : [
              {
                message_id: run.input_message_id!,
                role: 'user' as const,
                content: message!.content,
              },
            ]),
      ]
    : await readHarnessMessages(
        client,
        {
          ownerId: run.owner_id,
          conversationId: run.conversation_id,
          userMessageId: run.input_message_id!,
        },
        messageRefs,
      );
  return {
    ownerId: run.owner_id,
    conversationId: run.conversation_id,
    runId: run.id,
    attemptId,
    requestId,
    execution: run.execution,
    userMessageId: run.input_message_id,
    ...(control ? { compactControl: true as const } : {}),
    inputText: message?.content ?? '',
    confirmedTimezone: frozen.confirmedTimezone,
    anchorReceivedAtUtc: frozen.anchorReceivedAtUtc,
    receivedAtUtc: frozen.receivedAtUtc,
    foldChoice: frozen.foldChoice,
    timeContext: deps.timeContext,
    maxIterations: run.budget_max_iterations,
    maxTokens: run.budget_max_tokens,
    allowlist: run.tools_allowlist,
    ...(frozen.personalBot ? { personalBot: frozen.personalBot } : {}),
    ...(frozen.autoCompactPolicy
      ? { autoCompactPolicy: AutoCompactPolicySchema.parse(frozen.autoCompactPolicy) }
      : {}),
    ...(frozen.compactCompletionCap === undefined
      ? {}
      : {
          compactCompletionCap: z
            .number()
            .int()
            .positive()
            .safe()
            .parse(frozen.compactCompletionCap),
        }),
    ...(frozen.workspaceGrant ? { workspaceGrant: frozen.workspaceGrant } : {}),
    ...(frozen.workspaceGrants ? { workspaceGrants: frozen.workspaceGrants } : {}),
    ...(frozen.feishuDocx ? { feishuDocx: frozen.feishuDocx } : {}),
    ...(frozen.authorization_revision
      ? {
          authorizationRevision: frozen.authorization_revision,
          trustedExecutionContext: frozen.trustedExecutionContext,
        }
      : {}),
    ...(r3Context
      ? { executionProfile: 'compact-memory/1' as const, r3Context }
      : {
          messageRefs,
          ...(frozen.execution_profile ? { executionProfile: frozen.execution_profile } : {}),
        }),
    messages,
    contextPolicy,
    ...(checkpointId ? { resumeCheckpointId: checkpointId } : {}),
  };
}

export async function restoreSnapshotContext(
  client: PoolClient,
  context: RunContext,
  snapshot: HarnessSnapshot | HarnessPauseSnapshot | HarnessR3Snapshot,
): Promise<void> {
  if (snapshot.version !== 4) return;
  await validateR3SnapshotContext(client, context, snapshot);
  context.r3Context = snapshot.context;
}

export function readSnapshotObservations(
  client: PoolClient,
  context: RunContext,
  snapshot: Pick<HarnessSnapshot, 'tool_refs'>,
  options?: { inspectOnly: true },
) {
  return readRunContextObservations(client, context, snapshot.tool_refs, {
    project: context.allowlist.includes('read_run_observation'),
    ...options,
  });
}

export const AGENT_REVISION = 'assistant/r1';

export function buildHarnessStart(
  context: RunContext,
  snapshot: HarnessSnapshot | HarnessPauseSnapshot | HarnessR3Snapshot | null,
  observations: HarnessStart['observations'],
  approval: HarnessApprovalDecision | null,
  routingPolicy: RoutingPolicy | null = null,
  eligiblePhase: HarnessStart['eligible_phase'] = 'disabled',
  compactPreview?: HarnessR3ContextStart['compact_preview'],
): HarnessStart | HarnessR3ContextStart {
  if (!context.contextPolicy || !context.messages) throw unavailable();
  const profile = context.executionProfile;
  const compact = profile === 'compact-memory/1';
  const pause = profile === 'pause/1' || profile === 'pause-memory/1';
  const { allowlist } = context;
  const extraTools = compact
    ? [...R3_COMPACT_MEMORY_TOOL_DEFINITIONS, R3_MEMORY_SOURCE_TOOL_DEFINITION]
    : profile === 'pause-memory/1'
      ? R3_MEMORY_TOOL_DEFINITIONS
      : [];
  const directTaskTools = allowlist.includes('get_task') && allowlist.includes('cancel_reminder');
  const tools: HarnessStart['tools'] = [];
  for (const catalog of [
    context.authorizationRevision ? DELEGATION_TOOL_DEFINITIONS : HARNESS_TOOL_DEFINITIONS,
    extraTools,
  ]) {
    for (const tool of catalog) {
      if (!allowlist.includes(tool.name)) continue;
      tools.push(
        context.authorizationRevision && tool.name === 'list_tasks' && !directTaskTools
          ? HARNESS_TOOL_DEFINITIONS.find((legacy) => legacy.name === 'list_tasks')!
          : tool,
      );
    }
  }
  const common = {
    type: 'start' as const,
    trusted_context: context.trustedExecutionContext ?? null,
    context_policy: context.contextPolicy,
    routing_policy: routingPolicy,
    eligible_phase: eligiblePhase,
    tools,
    budget: { max_iterations: context.maxIterations, max_tokens: context.maxTokens },
    approval,
  };
  let start: HarnessStart | HarnessR3ContextStart;
  if (compact) {
    if (!context.r3Context || (snapshot && snapshot.version !== 4))
      throw stateConflict('v8 context or snapshot unavailable');
    const c = context.contextPolicy;
    const p = context.autoCompactPolicy;
    const autoCompact =
      !compactPreview &&
      context.r3Context.input.type === 'user' &&
      p &&
      c.input_meter !== 'unavailable' &&
      c.model_binding.model === p.model &&
      c.model_binding.adapter_revision === p.adapterRevision &&
      c.meter_revision === p.meterRevision &&
      (c.model_window_tokens === p.windowTokens ||
        (c.model_window_tokens === null && p.evidenceId === 'application-envelope-estimate/1'))
        ? {
            window_tokens: p.windowTokens,
            trigger_ratio: p.triggerRatio,
            input_reserve: p.compactInputTokens,
            output_reserve: context.compactCompletionCap ?? c.completion_cap,
            continuation_tokens: p.continuationTokens,
            continuation_iterations: p.continuationIterations,
          }
        : null;
    const r3Context = context.r3Context;
    let supplied: HarnessR3ContextStart['r3_context'] = r3Context;
    if (compactPreview || snapshot?.context === r3Context) supplied = null;
    else if (snapshot && r3Context.summary && r3Context.summary.id !== snapshot.context.summary?.id)
      supplied = { compact_summary: r3Context.summary };
    start = {
      ...common,
      protocol: HARNESS_CONTEXT_PROTOCOL_VERSION,
      r3_context: supplied,
      ...(compactPreview && { mode: 'measure_only', compact_preview: compactPreview }),
      ...(autoCompact && { auto_compact: autoCompact }),
      snapshot,
      observations: snapshot ? omitRetainedDocxObservations(snapshot, observations) : observations,
    };
  } else {
    if (snapshot?.version === 4) throw stateConflict('v8 snapshot requires v8 profile');
    if (
      snapshot &&
      (snapshot.message_refs.length !== context.messages.length ||
        snapshot.message_refs.some((id, index) => id !== context.messages![index]?.message_id))
    )
      throw stateConflict('snapshot message reference conflict');
    start = {
      ...common,
      protocol: pause ? HARNESS_R3_PROTOCOL_VERSION : HARNESS_PROTOCOL_VERSION,
      messages: context.messages,
      snapshot,
      observations,
    };
  }
  start.workspace = context.workspaceGrant
    ? validateWorkspaceGrant(context.ownerId, context.workspaceGrant)
    : null;
  if (Buffer.byteLength(JSON.stringify(start), 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw new ApplicationError(422, 'HARNESS_CONTEXT_LIMIT', '工具上下文超过安全范围，已停下。');
  return start.protocol === HARNESS_CONTEXT_PROTOCOL_VERSION
    ? HarnessR3ContextStartSchema.parse(start)
    : HarnessStartSchema.parse(start);
}
