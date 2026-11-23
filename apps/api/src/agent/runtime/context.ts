import type { Pool, PoolClient } from 'pg';
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
import { ApplicationError, notReady, stateConflict } from '../../platform/errors.js';
import type { ToolContext } from '../tools/contracts.js';
import { omitRetainedDocxObservations } from '../tools/invocations/context-source.js';
import {
  HARNESS_TOOL_DEFINITIONS,
  DELEGATION_TOOL_DEFINITIONS,
  R3_MEMORY_TOOL_DEFINITIONS,
  R3_COMPACT_MEMORY_TOOL_DEFINITIONS,
  R3_MEMORY_SOURCE_TOOL_DEFINITION,
} from '../tools/catalog.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import type { ConversationDeps, RunContext } from './contracts.js';
import { readRunContextPolicy } from '../../features/conversations/public.js';
import { withRunTransaction, type RunOwnership } from './run-ownership.js';
import {
  latestAttemptId,
  lockRun,
  type LockedRun,
  type RunRow,
  readHarnessMessages,
  readR3Context,
  readR3ControlContext,
  AutoCompactPolicySchema,
} from '../../features/conversations/public.js';
import { supportsFrozenTools } from './frozen-tool-eligibility.js';
import { resolveRunSelection } from '../../features/model-providers/public.js';

export function poolOf(deps: ConversationDeps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}
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
  const pool = poolOf(deps);
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
    ...(frozen.microsoftLearn ? { microsoftLearn: frozen.microsoftLearn } : {}),
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

export function toolContext(context: RunContext): ToolContext {
  return context;
}

export function buildHarnessStart(
  context: RunContext,
  snapshot: HarnessSnapshot | HarnessPauseSnapshot | HarnessR3Snapshot | null,
  observations: HarnessStart['observations'],
  approval: HarnessApprovalDecision | null,
  routingPolicy: RoutingPolicy | null = null,
  eligiblePhase: HarnessStart['eligible_phase'] = 'disabled',
): HarnessStart | HarnessR3ContextStart {
  if (!context.contextPolicy || !context.messages) throw unavailable();
  if (context.executionProfile === 'compact-memory/1') {
    if (!context.r3Context || (snapshot && snapshot.version !== 4))
      throw stateConflict('v8 context or snapshot unavailable');
    const tools = [
      ...(context.authorizationRevision
        ? DELEGATION_TOOL_DEFINITIONS.map((tool) =>
            tool.name === 'list_tasks' &&
            !(
              context.allowlist.includes('get_task') &&
              context.allowlist.includes('cancel_reminder')
            )
              ? HARNESS_TOOL_DEFINITIONS.find((legacy) => legacy.name === 'list_tasks')!
              : tool,
          )
        : HARNESS_TOOL_DEFINITIONS),
      ...R3_COMPACT_MEMORY_TOOL_DEFINITIONS,
      R3_MEMORY_SOURCE_TOOL_DEFINITION,
    ].filter((tool) => context.allowlist.includes(tool.name));
    const start: HarnessR3ContextStart = {
      protocol: HARNESS_CONTEXT_PROTOCOL_VERSION,
      type: 'start',
      trusted_context: context.trustedExecutionContext ?? null,
      r3_context: context.r3Context,
      context_policy: context.contextPolicy,
      routing_policy: routingPolicy,
      eligible_phase: eligiblePhase,
      tools,
      budget: { max_iterations: context.maxIterations, max_tokens: context.maxTokens },
      snapshot,
      observations: snapshot ? omitRetainedDocxObservations(snapshot, observations) : observations,
      approval,
      workspace: context.workspaceGrant
        ? validateWorkspaceGrant(context.ownerId, context.workspaceGrant)
        : null,
    };
    if (Buffer.byteLength(JSON.stringify(start), 'utf8') > HARNESS_MAX_FRAME_BYTES)
      throw new ApplicationError(422, 'HARNESS_CONTEXT_LIMIT', '工具上下文超过安全范围，已停下。');
    return HarnessR3ContextStartSchema.parse(start);
  }
  if (snapshot?.version === 4) throw stateConflict('v8 snapshot requires v8 profile');
  if (
    snapshot &&
    (snapshot.message_refs.length !== context.messages.length ||
      snapshot.message_refs.some((id, index) => id !== context.messages![index]?.message_id))
  )
    throw stateConflict('snapshot message reference conflict');
  const start: HarnessStart = {
    protocol:
      context.executionProfile === 'pause/1' || context.executionProfile === 'pause-memory/1'
        ? HARNESS_R3_PROTOCOL_VERSION
        : HARNESS_PROTOCOL_VERSION,
    type: 'start',
    trusted_context: context.trustedExecutionContext ?? null,
    messages: context.messages,
    context_policy: context.contextPolicy,
    routing_policy: routingPolicy,
    eligible_phase: eligiblePhase,
    tools: [
      ...(context.authorizationRevision
        ? DELEGATION_TOOL_DEFINITIONS.map((tool) =>
            tool.name === 'list_tasks' &&
            !(
              context.allowlist.includes('get_task') &&
              context.allowlist.includes('cancel_reminder')
            )
              ? HARNESS_TOOL_DEFINITIONS.find((legacy) => legacy.name === 'list_tasks')!
              : tool,
          )
        : HARNESS_TOOL_DEFINITIONS),
      ...(context.executionProfile === 'pause-memory/1' ? R3_MEMORY_TOOL_DEFINITIONS : []),
    ].filter((tool) => context.allowlist.includes(tool.name)),
    budget: { max_iterations: context.maxIterations, max_tokens: context.maxTokens },
    snapshot,
    observations,
    approval,
    workspace: context.workspaceGrant
      ? validateWorkspaceGrant(context.ownerId, context.workspaceGrant)
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(start), 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw new ApplicationError(422, 'HARNESS_CONTEXT_LIMIT', '工具上下文超过安全范围，已停下。');
  return HarnessStartSchema.parse(start);
}
