import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ZodError } from 'zod';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_R3_PROTOCOL_VERSION,
  HARNESS_CONTEXT_PROTOCOL_VERSION,
  HARNESS_MAX_FRAME_BYTES,
  HarnessSnapshotSchema,
  HarnessPauseSnapshotSchema,
  HarnessR3ContextStartSchema,
  HarnessR3SnapshotSchema,
  HistoricalHarnessSnapshotSchema,
  HarnessStartSchema,
  HarnessContextMeasurementSchema,
  HarnessModelStepSchema,
  HarnessRequestSchema,
  workspaceGrantSchema,
  type HarnessModelStep,
  type HarnessRequest,
  type HarnessSnapshot,
  type HarnessPauseSnapshot,
  type HarnessR3ContextStart,
  type HarnessR3Snapshot,
  type HarnessStart,
  type HarnessApprovalDecision,
  type RunView,
  RoutingFactsSchema,
  RoutingEmbeddingSchema,
  type RoutingFacts,
  type RoutingEmbedding,
  type RoutingPolicy,
} from '@along/contracts';
import { THREAD_PROTOCOL_VERSION } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import {
  HttpError,
  forbidden,
  notReady,
  notFound,
  stateConflict,
  validationError,
} from '../../http/errors.js';
import { validateDocumentApprovalsDone } from '../approvals/document-service.js';
import { getDocumentApproval, hasRejectedDocumentApproval } from '../approvals/document-query.js';
import { invokeTool, reserveToolInvocation } from '../tools/gateway.js';
import { readRunInvocationStates, readInvocationSnapshots } from '../tools/invocations.js';
import {
  readRunContextObservations,
  readRunContextSource,
  readRunDocumentEvidence,
} from '../tools/query.js';
import type { ToolContext, ToolPayload } from '../tools/contracts.js';
import {
  HARNESS_TOOL_DEFINITIONS,
  DELEGATION_TOOL_DEFINITIONS,
  R3_MEMORY_TOOL_DEFINITIONS,
  R3_COMPACT_MEMORY_TOOL_DEFINITIONS,
  R3_MEMORY_SOURCE_TOOL_DEFINITION,
} from '../tools/catalog.js';
import { GOAL_CONTROL_TOOL } from './goal-control.js';
import { validateGoalResult } from './goal-result.js';
import { validateWorkspaceGrant } from '../workspaces/service.js';
import { runNativeHarness } from './harness-process.js';
import type { ConversationDeps, EventWriter, RunContext, StartResult } from './contracts.js';
import { readRunContextPolicy } from './context-policy.js';
import {
  ActionKeySchema,
  ContinueRunBodySchema,
  PauseRunBodySchema,
  CancelRunBodySchema,
  ResumeRunBodySchema,
} from './schemas.js';
import { routingRuntimeOf } from './harness-config.js';
import { withRunTransaction, type RunOwnership } from './run-ownership.js';
import {
  readRoutingPolicy,
  readRoutingRecord,
  acceptRoutingDecision,
  decisionPayload,
  routingDecisionReply,
  insertRoutingRender,
  routingHash,
  routingIdentity,
  type RoutingDecisionPayload,
  type RoutingRenderPayload,
} from './routing-checkpoints.js';
import {
  insertAttempt,
  latestAttemptId,
  listRunEvents,
  lockRun,
  type LockedRun,
  type RunRow,
  readHarnessMessages,
} from './repository.js';
import {
  appendEvent,
  commitTerminal,
  readSnapshot,
  readRunApprovalDecision,
  supportsFrozenTools,
  viewOf,
} from './run-state.js';
import { resolveRunSelection } from '../model-providers/service.js';
import { readR3Context, readR3ControlContext } from './r3-context.js';
import {
  readCompactContinuation,
  readConsumedCompactContinuation,
  validateR3SnapshotContext,
} from './compact-continuation.js';
import { executeCompact } from './compact-runtime.js';
import { assertCompactEligibility, failCompact, recordCompactUsage } from './compact-operations.js';
import { AutoCompactPolicySchema, shouldAutoCompact } from './auto-compact-policy.js';

export interface HarnessSession {
  start: HarnessStart | HarnessR3ContextStart;
  handleRequest(request: HarnessRequest): Promise<unknown>;
  close(): Promise<void>;
}

const active = new Map<string, AbortController>();
const sessionAborts = new Map<string, Set<AbortController>>();

function poolOf(deps: ConversationDeps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}
function unavailable(): HttpError {
  return new HttpError(503, 503, 'HARNESS_UNAVAILABLE', '原生 Agent 暂不可用。');
}
function isStale(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.errorCode === 'STATE_CONFLICT' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'reason' in error.details &&
    error.details.reason === 'STALE_ATTEMPT'
  );
}

async function withLatest<T>(
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

async function contextOf(
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
    throw new HttpError(503, 503, 'TZDB_UNAVAILABLE', '接纳时的时间规则暂不可用。');
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
    ...(frozen.workspaceGrant ? { workspaceGrant: frozen.workspaceGrant } : {}),
    ...(frozen.workspaceGrants ? { workspaceGrants: frozen.workspaceGrants } : {}),
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
function eventPayload(context: RunContext) {
  return { conversation_id: context.conversationId, run_id: context.runId };
}
function toolContext(context: RunContext): ToolContext {
  return context;
}

function approvalAuthorizesActions(decision: HarnessApprovalDecision | null): boolean {
  return (
    decision === null ||
    (decision.kind === 'task' ? decision.status === 'consumed' : decision.status === 'approved')
  );
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
      observations,
      approval,
      workspace: context.workspaceGrant
        ? validateWorkspaceGrant(context.ownerId, context.workspaceGrant)
        : null,
    };
    if (Buffer.byteLength(JSON.stringify(start), 'utf8') > HARNESS_MAX_FRAME_BYTES)
      throw new HttpError(422, 422, 'HARNESS_CONTEXT_LIMIT', '工具上下文超过安全范围，已停下。');
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
    throw new HttpError(422, 422, 'HARNESS_CONTEXT_LIMIT', '工具上下文超过安全范围，已停下。');
  return HarnessStartSchema.parse(start);
}

// Read-only release inspection is not an authorization to resume. The caller
// must run it again after stopping writers and resume revalidates under locks.
export async function inspectReleaseWaiting(
  deps: ConversationDeps,
): Promise<Array<{ runId: string; status: 'compatible' | 'blocked'; reason?: string }>> {
  const client = await poolOf(deps).connect();
  let temporaryAdmissions = false;
  try {
    const identity = await client.query<{ admissions: boolean; administrator: boolean }>(
      `SELECT to_regclass('identity_account_admissions') IS NOT NULL AS admissions,
              to_regclass('installation_admin') IS NOT NULL AS administrator`,
    );
    if (!identity.rows[0]!.admissions) {
      // Migration 0024 admits precisely the existing administrator. This
      // session-local view forecasts eligibility without changing stored facts.
      await client.query(
        identity.rows[0]!.administrator
          ? 'CREATE TEMP VIEW identity_account_admissions AS SELECT user_id FROM installation_admin'
          : 'CREATE TEMP VIEW identity_account_admissions AS SELECT NULL::uuid AS user_id WHERE false',
      );
      temporaryAdmissions = true;
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const table = await client.query<{ present: boolean; modelBindingsExist: boolean }>(
      `SELECT to_regclass('run_context_policies') IS NOT NULL AS present,
              to_regclass('model_provider_run_bindings') IS NOT NULL AS "modelBindingsExist"`,
    );
    const runs = await client.query<RunRow>(
      "SELECT * FROM agent_runs WHERE execution='harness' AND status='suspended_approval' ORDER BY id",
    );
    const results: Array<{ runId: string; status: 'compatible' | 'blocked'; reason?: string }> = [];
    for (const run of runs.rows) {
      try {
        if (!run.waiting_checkpoint_id || !run.waiting_invocation_id || !run.waiting_approval_id)
          throw stateConflict('incomplete waiting point');
        const attempt = await client.query(
          'SELECT 1 FROM run_attempts WHERE run_id=$1 AND owner_id=$2',
          [run.id, run.owner_id],
        );
        if (!attempt.rowCount) throw stateConflict('Run attempt missing');
        const snapshot = await readSnapshot(client, run, run.waiting_checkpoint_id);
        if (
          snapshot.waiting?.invocation_id !== run.waiting_invocation_id ||
          snapshot.waiting?.approval_id !== run.waiting_approval_id
        )
          throw stateConflict('waiting checkpoint reference conflict');
        const decision = await readRunApprovalDecision(
          client,
          { ownerId: run.owner_id, conversationId: run.conversation_id, runId: run.id },
          run.waiting_invocation_id,
          run.waiting_approval_id,
        );
        if (
          snapshot.usage.iterations >= run.budget_max_iterations ||
          (snapshot.usage.tokens !== null && snapshot.usage.tokens >= run.budget_max_tokens)
        )
          throw stateConflict('waiting point budget exhausted');
        if (
          run.frozen_context?.authorization_revision === 'delegation/1' &&
          decision.kind === 'document'
        ) {
          if (decision.status === 'rejected') throw stateConflict('document approval rejected');
          const approval = await getDocumentApproval(client, run.owner_id, decision.approval_id);
          const grant = workspaceGrantSchema.parse(approval.workspace_grant);
          if (
            approval.conversation_id !== run.conversation_id ||
            approval.run_id !== run.id ||
            !run.frozen_context.workspaceGrants?.some(
              (member) =>
                JSON.stringify(workspaceGrantSchema.parse(member)) === JSON.stringify(grant),
            )
          )
            throw forbidden('document approval workspace differs from frozen Run grants');
          validateWorkspaceGrant(run.owner_id, grant);
        }
        const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
          run.waiting_checkpoint_id,
        ]);
        if (used.rowCount) throw stateConflict('approval waiting point already resumed');
        const context = await contextOf(
          client,
          deps,
          run,
          randomUUID(),
          randomUUID(),
          run.waiting_checkpoint_id,
          {
            tableExists: table.rows[0]!.present,
            modelBindingsExist: table.rows[0]!.modelBindingsExist,
          },
        );
        if (snapshot.version === 4) {
          await validateR3SnapshotContext(client, context, snapshot);
          context.r3Context = snapshot.context;
        }
        const observations = await readRunContextObservations(
          client,
          toolContext(context),
          snapshot.tool_refs,
          { project: context.allowlist.includes('read_run_observation') },
        );
        buildHarnessStart(context, snapshot, observations, decision);
        results.push({ runId: run.id, status: 'compatible' });
      } catch (error) {
        if (!(error instanceof HttpError) && !(error instanceof ZodError)) throw error;
        results.push({
          runId: run.id,
          status: 'blocked',
          reason: error instanceof HttpError ? error.errorCode : 'INVALID_HISTORICAL_SCHEMA',
        });
      }
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release(temporaryAdmissions);
  }
}

export async function getRunView(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
): Promise<RunView> {
  return withLatest(deps, ownerId, conversationId, runId, (client, locked) =>
    viewOf(client, locked, !!deps.modelTransport),
  );
}

export async function cancelConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
  expectedWaiting?: {
    checkpoint: string | null;
    invocation: string | null;
    approval: string | null;
  },
): Promise<RunView> {
  const parsed = CancelRunBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid cancel body');
  const input = parsed.data;
  const reason = input.reason ?? 'user_cancelled';
  const result = await withLatest(
    deps,
    ownerId,
    conversationId,
    runId,
    async (client, locked) => {
      if (
        expectedWaiting &&
        (locked.run.status !== 'suspended_approval' ||
          locked.run.waiting_checkpoint_id !== expectedWaiting.checkpoint ||
          locked.run.waiting_invocation_id !== expectedWaiting.invocation ||
          locked.run.waiting_approval_id !== expectedWaiting.approval)
      )
        throw stateConflict('selected waiting point changed');
      const previous = (
        await client.query<{ run_id: string; reason: string }>(
          'SELECT run_id,reason FROM harness_cancellations WHERE owner_id=$1 AND idempotency_key=$2',
          [ownerId, input.idempotency_key],
        )
      ).rows[0];
      if (previous && (previous.run_id !== runId || previous.reason !== reason))
        throw stateConflict('cancel idempotency key conflict');
      if (!previous)
        await client.query(
          'INSERT INTO harness_cancellations(owner_id,idempotency_key,run_id,reason) VALUES($1,$2,$3,$4)',
          [ownerId, input.idempotency_key, runId, reason],
        );
      await client.query(
        `UPDATE harness_pauses SET state='invalidated' WHERE run_id=$1 AND owner_id=$2 AND state IN ('pending','paused')`,
        [runId, ownerId],
      );
      await client.query(
        `UPDATE compact_operations
         SET status=CASE WHEN status IN ('pending','running') THEN 'cancelled' ELSE status END,
             candidate_status=CASE WHEN candidate_status='pending' THEN 'cancelled' ELSE candidate_status END,
             updated_at=now()
         WHERE run_id=$1 AND owner_id=$2 AND (status IN ('pending','running') OR
               (status='published' AND candidate_status='pending'))`,
        [runId, ownerId],
      );
      if (
        locked.run.status === 'running' ||
        locked.run.status === 'suspended_approval' ||
        locked.run.status === 'paused'
      ) {
        const terminal = await commitTerminal(
          client,
          { ownerId, conversationId, runId, attemptId: locked.attempt.id, requestId },
          'cancelled',
          {
            conversation_id: conversationId,
            run_id: runId,
            reason,
          },
        );
        if (terminal.protocol_version === 'v2' && terminal.type === 'thread.cancelled')
          locked.run.goal_result = terminal.payload.goal_result;
        locked.run.status = 'cancelled';
        locked.run.waiting_checkpoint_id = null;
        locked.run.waiting_invocation_id = null;
        locked.run.waiting_approval_id = null;
        locked.attempt.status = 'failed';
      }
      return viewOf(client, locked, !!deps.modelTransport);
    },
    false,
  );
  // Qualification has already been revoked durably before model/pipe abort.
  if (result.status === 'cancelled') active.get(runId)?.abort();
  if (result.status === 'cancelled')
    for (const controller of sessionAborts.get(runId) ?? []) controller.abort();
  return result;
}

export async function requestConversationPause(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  body: unknown,
  key: string | null,
): Promise<{ status: 'pending' | 'paused'; pause_id: string }> {
  if (!PauseRunBodySchema.safeParse(body).success || !ActionKeySchema.safeParse(key).success)
    throw validationError('invalid pause request');
  return withLatest(deps, ownerId, conversationId, runId, async (client, locked) => {
    const prior = (
      await client.query<{
        id: string;
        run_id: string;
        conversation_id: string;
        state: string;
        reason: string;
        purpose: string;
        resume_source: string;
      }>(
        `SELECT id,run_id,conversation_id,state,reason,purpose,resume_source FROM harness_pauses WHERE owner_id=$1 AND idempotency_key=$2`,
        [ownerId, key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.run_id !== runId ||
        prior.conversation_id !== conversationId ||
        prior.reason !== 'user' ||
        prior.purpose !== 'none' ||
        prior.resume_source !== 'user' ||
        (prior.state !== 'pending' && prior.state !== 'paused')
      )
        throw stateConflict('pause idempotency key conflict');
      return { status: prior.state as 'pending' | 'paused', pause_id: prior.id };
    }
    if (
      locked.run.execution !== 'harness' ||
      !['pause/1', 'pause-memory/1', 'compact-memory/1'].includes(
        locked.run.frozen_context?.execution_profile ?? '',
      ) ||
      locked.run.status !== 'running' ||
      locked.attempt.status !== 'running'
    )
      throw stateConflict('Run cannot be paused', { status: locked.run.status });
    const id = randomUUID();
    await client.query(
      `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
       VALUES($1,$2,$3,$4,$5,$6,'user','none','user','pending')`,
      [id, ownerId, conversationId, runId, locked.attempt.id, key],
    );
    return { status: 'pending' as const, pause_id: id };
  });
}

/** Register an internal compact pause only for a profile that can resume a
 * compacted view. Existing v7 Runs can never be upgraded by this action. */
export async function requestRuntimeCompactPause(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  purpose: 'manual_compact' | 'automatic_compact',
  key: string,
): Promise<{ status: string; pause_id: string }> {
  if (
    !ActionKeySchema.safeParse(key).success ||
    (purpose !== 'manual_compact' && purpose !== 'automatic_compact')
  )
    throw validationError('invalid compact pause request');
  return withLatest(deps, ownerId, conversationId, runId, async (client, locked) => {
    const prior = (
      await client.query<{
        id: string;
        run_id: string;
        conversation_id: string;
        state: string;
        reason: string;
        purpose: string;
        resume_source: string;
      }>(
        `SELECT id,run_id,conversation_id,state,reason,purpose,resume_source
       FROM harness_pauses WHERE owner_id=$1 AND idempotency_key=$2`,
        [ownerId, key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.run_id !== runId ||
        prior.conversation_id !== conversationId ||
        prior.reason !== 'runtime' ||
        prior.purpose !== purpose ||
        prior.resume_source !== 'runtime'
      )
        throw stateConflict('pause idempotency key conflict');
      return { status: prior.state, pause_id: prior.id };
    }
    if (
      !deps.runDriver ||
      locked.run.execution !== 'harness' ||
      locked.run.frozen_context?.execution_lifecycle !== 'server-owned' ||
      (locked.run.frozen_context?.execution_profile as string | undefined) !== 'compact-memory/1' ||
      locked.run.status !== 'running' ||
      locked.attempt.status !== 'running'
    )
      throw stateConflict('Run cannot compact', { status: locked.run.status });
    for (const grant of locked.run.frozen_context.workspaceGrants ?? [])
      validateWorkspaceGrant(ownerId, grant);
    if (locked.run.frozen_context.workspaceGrant)
      validateWorkspaceGrant(ownerId, locked.run.frozen_context.workspaceGrant);
    if (!(await resolveRunSelection(client, ownerId, runId)))
      throw stateConflict('frozen model binding unavailable');
    const live = await client.query(
      `SELECT 1 FROM harness_pauses WHERE run_id=$1 AND state IN ('pending','paused')`,
      [runId],
    );
    if (live.rowCount) throw stateConflict('Run already has a pending pause');
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
       VALUES($1,$2,$3,$4,$5,$6,'runtime',$7,'runtime','pending') ON CONFLICT (owner_id,idempotency_key) DO NOTHING RETURNING id`,
      [id, ownerId, conversationId, runId, locked.attempt.id, key, purpose],
    );
    if (!inserted.rowCount) {
      const raced = (
        await client.query<{
          id: string;
          run_id: string;
          conversation_id: string;
          reason: string;
          purpose: string;
          resume_source: string;
          state: string;
        }>(
          `SELECT id,run_id,conversation_id,reason,purpose,resume_source,state FROM harness_pauses WHERE owner_id=$1 AND idempotency_key=$2`,
          [ownerId, key],
        )
      ).rows[0];
      if (
        !raced ||
        raced.run_id !== runId ||
        raced.conversation_id !== conversationId ||
        raced.reason !== 'runtime' ||
        raced.purpose !== purpose ||
        raced.resume_source !== 'runtime'
      )
        throw stateConflict('pause idempotency key conflict');
      return { status: raced.state, pause_id: raced.id };
    }
    await client.query(
      `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status)
       VALUES($1,$2,$3,$4,$5,'pending')`,
      [id, ownerId, conversationId, runId, locked.attempt.id],
    );
    return { status: 'pending' as const, pause_id: id };
  });
}

export async function getCompactReceipt(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  pauseId: string,
) {
  return withLatest(deps, ownerId, conversationId, runId, async (client, locked) => {
    const row = (
      await client.query<{
        state: string;
        status: string;
        error_code: string | null;
        candidate_status: string;
        candidate_error_code: string | null;
      }>(
        `SELECT p.state,o.status,o.error_code,o.candidate_status,o.candidate_error_code
      FROM harness_pauses p JOIN compact_operations o ON o.pause_id=p.id
      WHERE p.id=$1 AND p.owner_id=$2 AND p.conversation_id=$3 AND p.run_id=$4
        AND p.reason='runtime' AND p.purpose='manual_compact'`,
        [pauseId, ownerId, conversationId, runId],
      )
    ).rows[0];
    if (!row) throw notFound('compact operation not found');
    const control = locked.run.input_message_id === null;
    const runFailure =
      locked.run.status === 'failed' &&
      row.status !== 'failed' &&
      (control || row.state === 'invalidated')
        ? ((
            await client.query<{ code: string | null }>(
              `SELECT c.payload->'payload'->'error'->>'code' AS code FROM run_checkpoints c
           JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind='thread.failed'
           ORDER BY c.event_seq DESC LIMIT 1`,
              [runId],
            )
          ).rows[0]?.code ?? 'RUN_FAILED')
        : null;
    const status =
      row.status === 'cancelled' ||
      (row.state === 'invalidated' && locked.run.status === 'cancelled')
        ? 'cancelled'
        : row.status === 'failed' || runFailure
          ? 'failed'
          : row.state === 'consumed' && (!control || locked.run.status === 'done')
            ? 'continued'
            : row.status === 'published'
              ? 'published'
              : row.status === 'running'
                ? 'compacting'
                : row.state === 'paused'
                  ? 'paused'
                  : row.state === 'invalidated'
                    ? 'failed'
                    : 'pending';
    return {
      status,
      run_id: runId,
      pause_id: pauseId,
      candidate_status: row.candidate_status,
      ...(row.error_code || runFailure
        ? { error_code: row.error_code ?? runFailure }
        : row.state === 'invalidated' && status === 'failed'
          ? { error_code: 'RUN_TERMINATED' }
          : {}),
      ...(row.candidate_error_code ? { candidate_error_code: row.candidate_error_code } : {}),
    };
  });
}

/** Consume only the runtime-owned compact pause, after all model and candidate
 * facts are durable. The returned context is launched by the existing owner. */
export async function continueRuntimeCompact(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  pauseId: string,
  requestId: string,
  ownership?: RunOwnership,
): Promise<RunContext> {
  return withLatest(
    deps,
    ownerId,
    conversationId,
    runId,
    async (client, locked) => {
      if (
        locked.run.frozen_context?.execution_profile !== 'compact-memory/1' ||
        locked.run.status !== 'paused'
      )
        throw stateConflict('compact continuation unavailable');
      const binding = {
        ownerId,
        conversationId,
        runId,
        attemptId: locked.attempt.id,
        pauseId,
        ownership,
      };
      const guard = async (guardClient: PoolClient) => {
        for (const grant of locked.run.frozen_context?.workspaceGrants ?? [])
          validateWorkspaceGrant(ownerId, grant);
        if (locked.run.frozen_context?.workspaceGrant)
          validateWorkspaceGrant(ownerId, locked.run.frozen_context.workspaceGrant);
        if (!(await resolveRunSelection(guardClient, ownerId, runId)))
          throw stateConflict('frozen model binding unavailable');
      };
      const restored = await readCompactContinuation(
        client,
        binding,
        locked.run.input_message_id,
        {
          maxIterations: locked.run.budget_max_iterations,
          maxTokens: locked.run.budget_max_tokens,
        },
        guard,
      );
      const attemptId = randomUUID();
      const context = await contextOf(client, deps, locked.run, attemptId, requestId);
      if (ownership) context.ownership = ownership;
      context.r3Context = restored.context;
      const observations = await readRunContextObservations(
        client,
        toolContext(context),
        restored.snapshot.tool_refs,
        {
          project: context.allowlist.includes('read_run_observation'),
        },
      );
      buildHarnessStart(context, restored.snapshot, observations, null);
      await insertAttempt(client, {
        attemptId,
        ownerId,
        runId,
        attemptNo: locked.attempt.attempt_no + 1,
        ...(ownership ? { leaseToken: ownership.token } : {}),
      });
      await client.query(
        `INSERT INTO harness_pause_resumes(owner_id,idempotency_key,run_id,pause_id,attempt_id,source)
       VALUES($1,$2,$3,$2,$4,'runtime')`,
        [ownerId, pauseId, runId, attemptId],
      );
      await client.query(
        `INSERT INTO compact_continuations(pause_id,attempt_id,snapshot,context) VALUES($1,$2,$3::jsonb,$4::jsonb)`,
        [pauseId, attemptId, JSON.stringify(restored.snapshot), JSON.stringify(restored.context)],
      );
      await client.query(`UPDATE harness_pauses SET state='consumed' WHERE id=$1`, [pauseId]);
      await client.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [runId]);
      return context;
    },
    true,
    ownership,
  );
}

/** Run only after the native process has durably stopped at a runtime pause.
 * All external I/O is outside the authority transaction. */
export async function executeRuntimeCompact(
  deps: ConversationDeps,
  context: RunContext,
  interruption?: AbortSignal,
): Promise<RunContext | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.ownership?.signal.addEventListener('abort', abort, { once: true });
  interruption?.addEventListener('abort', abort, { once: true });
  if (context.ownership?.signal.aborted || interruption?.aborted) controller.abort();
  active.set(context.runId, controller);
  try {
    return await executeRuntimeCompactWork(deps, context, controller.signal);
  } finally {
    context.ownership?.signal.removeEventListener('abort', abort);
    interruption?.removeEventListener('abort', abort);
    if (active.get(context.runId) === controller) active.delete(context.runId);
  }
}

async function executeRuntimeCompactWork(
  deps: ConversationDeps,
  context: RunContext,
  signal: AbortSignal,
): Promise<RunContext | null> {
  if (!deps.harness || !deps.modelTransport || !context.contextPolicy || !context.ownership)
    return null;
  const pool = poolOf(deps);
  const tx = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withRunTransaction(pool, context.ownership, fn);
  const prepared = await tx(async (client) => {
    const locked = await lockRun(client, context, false, false);
    if (
      locked.run.status !== 'paused' ||
      locked.run.frozen_context?.execution_profile !== 'compact-memory/1'
    )
      return null;
    const row = (
      await client.query<{ id: string; snapshot: unknown; purpose: string }>(
        `SELECT p.id,p.snapshot,p.purpose FROM harness_pauses p JOIN compact_operations o ON o.pause_id=p.id
       WHERE p.owner_id=$1 AND p.conversation_id=$2 AND p.run_id=$3 AND p.attempt_id=$4
         AND p.state='paused' AND p.reason='runtime' AND o.status='pending'`,
        [context.ownerId, context.conversationId, context.runId, context.attemptId],
      )
    ).rows[0];
    if (!row) return null;
    const snapshot = HarnessR3SnapshotSchema.parse(row.snapshot);
    await validateR3SnapshotContext(client, context, snapshot);
    const selected = await resolveRunSelection(client, context.ownerId, context.runId);
    if (!selected || selected.model_id !== context.contextPolicy!.model_binding.model)
      throw stateConflict('frozen model binding unavailable');
    const observations = await readRunContextObservations(
      client,
      toolContext(context),
      snapshot.tool_refs,
      {
        project: context.allowlist.includes('read_run_observation'),
      },
    );
    return { pauseId: row.id, snapshot, selected, observations, purpose: row.purpose };
  });
  if (!prepared) return null;
  const { snapshot, pauseId, observations } = prepared;
  const binding = {
    ownerId: context.ownerId,
    conversationId: context.conversationId,
    runId: context.runId,
    attemptId: context.attemptId,
    pauseId,
    ownership: context.ownership,
  };
  const guard = async (client: PoolClient, ids: readonly string[]) => {
    for (const grant of context.workspaceGrants ?? [])
      validateWorkspaceGrant(context.ownerId, grant);
    if (context.workspaceGrant) validateWorkspaceGrant(context.ownerId, context.workspaceGrant);
    const selected = await resolveRunSelection(client, context.ownerId, context.runId);
    if (!selected || selected.model_id !== context.contextPolicy!.model_binding.model)
      throw stateConflict('frozen model binding unavailable');
    const row = (
      await client.query<{
        snapshot: unknown;
        head: string | null;
        own_head: boolean;
        usage_recorded: boolean;
        usage_tokens: string | null;
      }>(
        `SELECT p.snapshot,h.summary_id AS head,
          EXISTS(SELECT 1 FROM compact_summaries s WHERE s.id=h.summary_id AND s.freeze_id=o.freeze_id) AS own_head,
          o.usage_recorded,o.usage_tokens::text
        FROM harness_pauses p JOIN compact_operations o ON o.pause_id=p.id
        LEFT JOIN compact_heads h ON h.owner_id=p.owner_id AND h.conversation_id=p.conversation_id
        WHERE p.id=$1 AND p.owner_id=$2 AND p.run_id=$3`,
        [pauseId, context.ownerId, context.runId],
      )
    ).rows[0];
    if (
      !row ||
      JSON.stringify(HarnessR3SnapshotSchema.parse(row.snapshot)) !== JSON.stringify(snapshot) ||
      ((row.head ?? null) !== (snapshot.context.summary?.id ?? null) && !row.own_head)
    )
      throw stateConflict('compact protected view changed');
    const permitted = new Set(snapshot.original_manifest.message_ids);
    if (ids.some((id) => !permitted.has(id) || id === context.userMessageId))
      throw stateConflict('compact source outside protected view');
    if (
      row.usage_recorded &&
      (row.usage_tokens === null ||
        (snapshot.usage.tokens !== null &&
          snapshot.usage.tokens + Number(row.usage_tokens) >= context.maxTokens) ||
        snapshot.usage.iterations + 1 >= context.maxIterations)
    )
      throw stateConflict('compact leaves no continuation budget');
    const states = await readRunInvocationStates(client, toolContext(context));
    for (const state of states) {
      if (state.state !== 'completed' || state.outcome_kind === 'failed')
        throw stateConflict('compact has unresolved tool effects');
      if (
        state.outcome_kind === 'approval_pending' &&
        (!state.approval_id ||
          !snapshot.tool_refs.includes(state.invocation_id) ||
          (await readRunApprovalDecision(client, context, state.invocation_id, state.approval_id))
            .status === 'pending')
      )
        throw stateConflict('compact has unresolved approval');
    }
  };
  const reject = async (code: string) => {
    await tx(async (client) => {
      await assertCompactEligibility(client, binding, (c) => guard(c, []));
      await failCompact(client, binding, code);
    });
  };
  try {
    if (
      (snapshot.usage.tokens !== null && snapshot.usage.tokens >= context.maxTokens) ||
      snapshot.native_state.pending_model ||
      snapshot.usage.iterations + 1 >= context.maxIterations ||
      !snapshot.context.messages.length
    ) {
      await reject(
        snapshot.context.messages.length
          ? 'COMPACT_CONTINUATION_UNAVAILABLE'
          : 'COMPACT_NO_CONTENT',
      );
    } else {
      const transport = await deps.modelTransport(prepared.selected);
      await executeCompact({
        pool,
        binding,
        messageIds: snapshot.context.messages.map((message) => message.message_id),
        promptRevision: 'compact/1',
        policy: context.contextPolicy,
        budget: {
          iterationsRemaining: context.maxIterations - snapshot.usage.iterations,
          continuationIterations:
            prepared.purpose === 'automatic_compact'
              ? context.autoCompactPolicy!.continuationIterations
              : 1,
          tokensRemaining:
            snapshot.usage.tokens === null ? null : context.maxTokens - snapshot.usage.tokens,
          continuationTokens:
            prepared.purpose === 'automatic_compact'
              ? context.autoCompactPolicy!.continuationTokens
              : context.contextPolicy.completion_cap,
          maxOutputTokens: context.contextPolicy.completion_cap,
        },
        transport,
        signal,
        guard,
        validateContinuation: async (frozen, result) => {
          if (!result.usage) throw stateConflict('compact continuation measurement unavailable');
          const total =
            snapshot.usage.tokens === null
              ? null
              : snapshot.usage.tokens + result.usage.total_tokens;
          if (total !== null && (!Number.isSafeInteger(total) || total >= context.maxTokens))
            throw stateConflict('compact continuation budget exhausted');
          const revision = (
            await pool.query<{ revision: string }>(
              'SELECT (previous_revision+1)::text AS revision FROM compact_freezes WHERE id=$1 AND owner_id=$2',
              [frozen.freezeId, context.ownerId],
            )
          ).rows[0]?.revision;
          if (!revision) throw stateConflict('compact freeze unavailable');
          const covered = new Set(frozen.coverageMessageIds);
          const candidate = {
            ...snapshot.context,
            summary: {
              id: randomUUID(),
              revision,
              text: result.text,
              message_ids: frozen.coverageMessageIds,
            },
            messages: snapshot.context.messages.filter(
              (message) => !covered.has(message.message_id),
            ),
          };
          const nextSnapshot = {
            ...snapshot,
            usage: { iterations: snapshot.usage.iterations + 1, tokens: total },
          };
          const start = buildHarnessStart(
            { ...context, r3Context: candidate },
            nextSnapshot,
            observations,
            null,
          );
          if (start.protocol !== HARNESS_CONTEXT_PROTOCOL_VERSION)
            throw stateConflict('compact requires v8');
          let seen = false;
          await runNativeHarness({
            services: deps.harness!,
            start: { ...start, mode: 'measure_only' },
            signal,
            detachOnAbort: true,
            handleRequest: async (request) => {
              if (
                seen ||
                request.type !== 'context_preview' ||
                request.pending_model ||
                request.remaining_tokens !== (total === null ? null : context.maxTokens - total) ||
                request.max_output_tokens === 0
              )
                throw stateConflict('compact continuation preview unavailable');
              seen = true;
              const { pending_model: _pending, ...preview } = request;
              void _pending;
              const measurement = HarnessContextMeasurementSchema.parse(
                await transport.measure(
                  { ...preview, type: 'measure_context' },
                  context.authorizationRevision ? [...start.tools, GOAL_CONTROL_TOOL] : start.tools,
                  context.contextPolicy!,
                ),
              );
              const meter = measurement.input_meter;
              if (
                measurement.limit_reason ||
                measurement.wire_bytes > HARNESS_MAX_FRAME_BYTES ||
                measurement.http_bytes > HARNESS_MAX_FRAME_BYTES ||
                measurement.output_ceiling < request.max_output_tokens ||
                (request.remaining_tokens !== null &&
                  meter.quality !== 'unavailable' &&
                  (meter.input_tokens === null ||
                    meter.input_tokens + request.max_output_tokens > request.remaining_tokens))
              )
                throw stateConflict('compact continuation exceeds measured capacity');
              return { accepted: true };
            },
          });
          if (!seen || signal.aborted)
            throw stateConflict('compact continuation preview unavailable');
        },
      });
    }
  } catch (error) {
    // Preserve unknown usage if a provider reservation committed but the
    // surrounding transport failed before returning an accountable result.
    await withTransaction(pool, async (client) => {
      const operation = (
        await client.query<{ status: string; call_started: boolean; usage_recorded: boolean }>(
          `SELECT status,call_started,usage_recorded FROM compact_operations WHERE pause_id=$1 AND owner_id=$2`,
          [pauseId, context.ownerId],
        )
      ).rows[0];
      if (!operation || !['pending', 'running'].includes(operation.status)) return;
      if (operation.call_started && !operation.usage_recorded)
        await recordCompactUsage(client, binding, null);
      await failCompact(
        client,
        binding,
        error instanceof HttpError ? error.errorCode : 'COMPACT_RUNTIME_FAILED',
      );
    });
  }
  try {
    return await continueRuntimeCompact(
      deps,
      context.ownerId,
      context.conversationId,
      context.runId,
      pauseId,
      context.requestId,
      context.ownership,
    );
  } catch {
    // A failed control or automatic compact has no safe conversational successor.
    // Cancellation or lost authority wins over terminalizing the paused Run.
    if (context.compactControl || prepared.purpose === 'automatic_compact') {
      try {
        await tx(async (client) => {
          const locked = await lockRun(client, context, false, false);
          if (locked.run.status !== 'paused') return;
          const failed = (
            await client.query<{ error_code: string | null }>(
              `SELECT error_code FROM compact_operations WHERE pause_id=$1 AND owner_id=$2 AND status='failed'`,
              [pauseId, context.ownerId],
            )
          ).rows[0];
          if (!failed) return;
          await commitTerminal(
            client,
            context,
            'failed',
            {
              ...eventPayload(context),
              error: {
                code: failed.error_code ?? 'COMPACT_FAILED',
                message: 'compact failed',
                http_status: 422,
              },
            },
            { preserveAttemptStatus: true },
          );
        });
      } catch {
        /* cancellation or lost authority wins */
      }
    }
    return null;
  }
}

export async function continueConversationPause(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
  key: string | null,
): Promise<StartResult> {
  const parsed = ContinueRunBodySchema.safeParse(body);
  if (!parsed.success || !ActionKeySchema.safeParse(key).success)
    throw validationError('invalid continue request');
  const pauseId = parsed.data.pause_id;
  const pool = poolOf(deps);
  const current = (
    await pool.query<{ lifecycle: string | null; prior: boolean }>(
      `SELECT frozen_context->>'execution_lifecycle' AS lifecycle,
      EXISTS(SELECT 1 FROM harness_pause_resumes WHERE owner_id=$1 AND idempotency_key=$4) AS prior
     FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND id=$3`,
      [ownerId, conversationId, runId, key],
    )
  ).rows[0];
  let ownership: RunOwnership | undefined;
  if (current?.lifecycle === 'server-owned' && !current.prior) {
    if (!deps.runDriver) throw unavailable();
    ownership = await deps.runDriver.acquire(runId, true);
  }
  let result: StartResult;
  try {
    result = await withLatest(
      deps,
      ownerId,
      conversationId,
      runId,
      async (client, locked) => {
        const previous = (
          await client.query<{ run_id: string; pause_id: string; attempt_id: string }>(
            `SELECT run_id,pause_id,attempt_id FROM harness_pause_resumes WHERE owner_id=$1 AND idempotency_key=$2`,
            [ownerId, key],
          )
        ).rows[0];
        if (previous) {
          if (previous.run_id !== runId || previous.pause_id !== pauseId)
            throw stateConflict('continue idempotency key conflict');
          const events = await listRunEvents(client, ownerId, runId);
          const seqs = await client.query<{ event_seq: string }>(
            'SELECT event_seq FROM run_checkpoints WHERE attempt_id=$1',
            [previous.attempt_id],
          );
          const selected = new Set(seqs.rows.map((row) => Number(row.event_seq)));
          return {
            conversationId,
            runId,
            context: null,
            replay: events.filter((event) => selected.has(event.seq)),
          };
        }
        if (locked.run.frozen_context?.execution_lifecycle === 'server-owned' && !ownership)
          throw stateConflict('Run ownership required');
        const pause = (
          await client.query<{
            attempt_id: string;
            snapshot: unknown;
            state: string;
            resume_source: string;
            purpose: string;
          }>(
            `SELECT attempt_id,snapshot,state,resume_source,purpose FROM harness_pauses
         WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4 FOR UPDATE`,
            [pauseId, ownerId, conversationId, runId],
          )
        ).rows[0];
        if (
          locked.run.status !== 'paused' ||
          !locked.run.frozen_context ||
          !['pause/1', 'pause-memory/1', 'compact-memory/1'].includes(
            locked.run.frozen_context.execution_profile ?? '',
          ) ||
          !pause ||
          pause.state !== 'paused' ||
          pause.attempt_id !== locked.attempt.id ||
          pause.resume_source !== 'user' ||
          pause.purpose !== 'none'
        )
          throw stateConflict('Run has no matching user pause');
        const snapshot =
          locked.run.frozen_context?.execution_profile === 'compact-memory/1'
            ? HarnessR3SnapshotSchema.parse(pause.snapshot)
            : HarnessPauseSnapshotSchema.parse(pause.snapshot);
        const finalAnswer =
          !locked.run.frozen_context.authorization_revision &&
          snapshot.native_state.pending_model?.tool_calls.length === 0;
        const pendingCalls = snapshot.native_state.pending_model?.tool_calls;
        const finalGoal =
          !!locked.run.frozen_context.authorization_revision &&
          pendingCalls?.length === 1 &&
          pendingCalls[0]?.function.name === 'finish_goal' &&
          snapshot.usage.iterations <= locked.run.budget_max_iterations &&
          (snapshot.usage.tokens === null || snapshot.usage.tokens < locked.run.budget_max_tokens);
        if (
          !finalAnswer &&
          !finalGoal &&
          (snapshot.usage.iterations >= locked.run.budget_max_iterations ||
            (snapshot.usage.tokens !== null &&
              snapshot.usage.tokens >= locked.run.budget_max_tokens))
        )
          throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
        for (const grant of locked.run.frozen_context.workspaceGrants ?? [])
          validateWorkspaceGrant(ownerId, grant);
        const attemptId = randomUUID();
        const context = await contextOf(client, deps, locked.run, attemptId, requestId);
        if (ownership) context.ownership = ownership;
        if (snapshot.version === 4) {
          await validateR3SnapshotContext(client, context, snapshot);
          context.r3Context = snapshot.context;
        }
        const observations = await readRunContextObservations(
          client,
          toolContext(context),
          snapshot.tool_refs,
          {
            project: context.allowlist.includes('read_run_observation'),
          },
        );
        buildHarnessStart(context, snapshot, observations, null);
        const afterSeq = ownership
          ? Number(
              (
                await client.query<{ seq: string }>(
                  `SELECT COALESCE(max(c.event_seq),0)::text AS seq FROM run_checkpoints c
         JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1`,
                  [runId],
                )
              ).rows[0]!.seq,
            )
          : null;
        await insertAttempt(client, {
          attemptId,
          ownerId,
          runId,
          attemptNo: locked.attempt.attempt_no + 1,
          ...(ownership ? { leaseToken: ownership.token } : {}),
        });
        await client.query(
          `INSERT INTO harness_pause_resumes(owner_id,idempotency_key,run_id,pause_id,attempt_id,source)
         VALUES($1,$2,$3,$4,$5,'user')`,
          [ownerId, key, runId, pauseId, attemptId],
        );
        await client.query(`UPDATE harness_pauses SET state='consumed' WHERE id=$1`, [pauseId]);
        await client.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [runId]);
        return { conversationId, runId, context, replay: null, ...(ownership ? { afterSeq } : {}) };
      },
      true,
      ownership,
    );
  } catch (error) {
    if (ownership) await deps.runDriver!.release(ownership);
    throw error;
  }
  if (ownership && result.context) {
    try {
      deps.runDriver!.start(deps, result.context);
    } catch (error) {
      await deps.runDriver!.release(ownership);
      throw error;
    }
    return {
      conversationId,
      runId,
      context: null,
      replay: null,
      serverOwned: true,
      afterSeq: result.afterSeq ?? null,
    };
  }
  if (ownership) await deps.runDriver!.release(ownership);
  return result;
}

export async function resumeConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
): Promise<StartResult> {
  const parsed = ResumeRunBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid resume body');
  const input = parsed.data;
  const pool = poolOf(deps);
  const current = (
    await pool.query<{ lifecycle: string | null; prior: boolean }>(
      `SELECT frozen_context->>'execution_lifecycle' AS lifecycle,
       EXISTS (SELECT 1 FROM harness_resumes WHERE owner_id=$1 AND idempotency_key=$4) AS prior
     FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND id=$3`,
      [ownerId, conversationId, runId, input.idempotency_key],
    )
  ).rows[0];
  let ownership: RunOwnership | undefined;
  if (current?.lifecycle === 'server-owned' && !current.prior) {
    if (!deps.runDriver) throw unavailable();
    ownership = await deps.runDriver.acquire(runId, true);
  }
  let result: StartResult;
  try {
    result = await withLatest(
      deps,
      ownerId,
      conversationId,
      runId,
      async (client, locked) => {
        const prior = (
          await client.query<{ run_id: string; checkpoint_id: string; attempt_id: string }>(
            'SELECT run_id,checkpoint_id,attempt_id FROM harness_resumes WHERE owner_id=$1 AND idempotency_key=$2',
            [ownerId, input.idempotency_key],
          )
        ).rows[0];
        if (prior) {
          if (prior.run_id !== runId || prior.checkpoint_id !== input.checkpoint_id)
            throw stateConflict('resume idempotency key conflict');
          const attempt = (
            await client.query<{ status: string }>('SELECT status FROM run_attempts WHERE id=$1', [
              prior.attempt_id,
            ])
          ).rows[0];
          if (attempt?.status === 'running')
            throw stateConflict('resumed Run still running', {
              status: 'running',
              run_id: runId,
              attempt_id: prior.attempt_id,
            });
          const events = await listRunEvents(client, ownerId, runId);
          const seqs = (
            await client.query<{ event_seq: string }>(
              'SELECT event_seq FROM run_checkpoints WHERE attempt_id=$1',
              [prior.attempt_id],
            )
          ).rows.map((row) => Number(row.event_seq));
          const selected = new Set(seqs);
          return {
            conversationId,
            runId,
            context: null,
            replay: events.filter((event) => selected.has(event.seq)),
          };
        }
        const run = locked.run;
        if (run.frozen_context?.execution_lifecycle === 'server-owned' && !ownership)
          throw stateConflict('Run ownership required');
        if (
          run.execution !== 'harness' ||
          run.status !== 'suspended_approval' ||
          run.waiting_checkpoint_id !== input.checkpoint_id ||
          !run.waiting_approval_id
        )
          throw stateConflict('Run has no matching approval waiting point', { status: run.status });
        const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
          input.checkpoint_id,
        ]);
        if (used.rowCount) throw stateConflict('approval waiting point already resumed');
        const snapshot = await readSnapshot(client, run, input.checkpoint_id);
        if (
          !snapshot.waiting ||
          snapshot.waiting.invocation_id !== run.waiting_invocation_id ||
          snapshot.waiting.approval_id !== run.waiting_approval_id
        )
          throw stateConflict('waiting checkpoint reference conflict');
        const decision = await readRunApprovalDecision(
          client,
          { ownerId, conversationId, runId },
          snapshot.waiting.invocation_id,
          run.waiting_approval_id,
        );
        if (decision.status === 'pending')
          throw stateConflict('approval still pending', { status: 'pending' });
        if (
          run.frozen_context?.authorization_revision === 'delegation/1' &&
          decision.kind === 'document' &&
          decision.status !== 'approved'
        )
          throw stateConflict('rejected document approval cannot resume');
        if (
          run.frozen_context?.authorization_revision === 'delegation/1' &&
          decision.kind === 'document'
        ) {
          const approval = await getDocumentApproval(client, ownerId, decision.approval_id);
          const grant = workspaceGrantSchema.parse(approval.workspace_grant);
          if (
            approval.conversation_id !== conversationId ||
            approval.run_id !== runId ||
            !run.frozen_context.workspaceGrants?.some(
              (member) =>
                JSON.stringify(workspaceGrantSchema.parse(member)) === JSON.stringify(grant),
            )
          )
            throw forbidden('document approval workspace differs from frozen Run grants');
          validateWorkspaceGrant(ownerId, grant);
        }
        if (!deps.harness) throw unavailable();
        if (
          snapshot.usage.iterations >= run.budget_max_iterations ||
          (snapshot.usage.tokens !== null && snapshot.usage.tokens >= run.budget_max_tokens)
        )
          throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
        const attemptId = randomUUID();
        const context = await contextOf(
          client,
          deps,
          run,
          attemptId,
          requestId,
          input.checkpoint_id,
        );
        if (ownership) context.ownership = ownership;
        if (snapshot.version === 4) {
          await validateR3SnapshotContext(client, context, snapshot);
          context.r3Context = snapshot.context;
        }
        const afterSeq = ownership
          ? Number(
              (
                await client.query<{ seq: string }>(
                  `SELECT COALESCE(max(c.event_seq),0)::text AS seq FROM run_checkpoints c
           JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1`,
                  [runId],
                )
              ).rows[0]!.seq,
            )
          : null;
        const observations = await readRunContextObservations(
          client,
          toolContext(context),
          snapshot.tool_refs,
          { project: context.allowlist.includes('read_run_observation') },
        );
        buildHarnessStart(context, snapshot, observations, decision);
        await insertAttempt(client, {
          attemptId,
          ownerId,
          runId,
          attemptNo: locked.attempt.attempt_no + 1,
          ...(ownership ? { leaseToken: ownership.token } : {}),
        });
        await client.query(
          'INSERT INTO harness_resumes(owner_id,idempotency_key,run_id,checkpoint_id,attempt_id) VALUES($1,$2,$3,$4,$5)',
          [ownerId, input.idempotency_key, runId, input.checkpoint_id, attemptId],
        );
        await client.query(
          `UPDATE agent_runs SET status='running',waiting_checkpoint_id=NULL,
      waiting_invocation_id=NULL,waiting_approval_id=NULL WHERE id=$1`,
          [runId],
        );
        return { conversationId, runId, context, replay: null, ...(ownership ? { afterSeq } : {}) };
      },
      true,
      ownership,
    );
  } catch (error) {
    if (ownership) await deps.runDriver!.release(ownership);
    throw error;
  }
  if (ownership && result.context) {
    try {
      deps.runDriver!.start(deps, result.context);
    } catch (error) {
      await deps.runDriver!.release(ownership);
      throw error;
    }
    return {
      conversationId,
      runId,
      context: null,
      replay: null,
      serverOwned: true,
      afterSeq: result.afterSeq ?? null,
    };
  }
  if (ownership) await deps.runDriver!.release(ownership);
  return result;
}

// The public test seam exercises the same guarded frame handler used by the
// real native process; production always calls it through runNativeHarness.
export async function createHarnessSession(
  deps: ConversationDeps,
  supplied: RunContext,
  write: EventWriter,
  signal: AbortSignal,
): Promise<HarnessSession> {
  const pool = poolOf(deps);
  const initial = await withRunTransaction(pool, supplied.ownership, async (client) => {
    const locked = await lockRun(client, supplied);
    if (locked.run.execution !== 'harness') throw stateConflict('not a harness Run');
    const resume = (
      await client.query<{ checkpoint_id: string }>(
        'SELECT checkpoint_id FROM harness_resumes WHERE attempt_id=$1 AND run_id=$2 AND owner_id=$3',
        [supplied.attemptId, supplied.runId, supplied.ownerId],
      )
    ).rows[0];
    const pausedResume = (
      await client.query<{ snapshot: unknown; source: string }>(
        `SELECT p.snapshot,r.source FROM harness_pause_resumes r JOIN harness_pauses p ON p.id=r.pause_id
       WHERE r.attempt_id=$1 AND r.run_id=$2 AND r.owner_id=$3 AND p.state='consumed'`,
        [supplied.attemptId, supplied.runId, supplied.ownerId],
      )
    ).rows[0];
    if (resume && pausedResume) throw stateConflict('ambiguous continuation');
    const context = await contextOf(
      client,
      deps,
      locked.run,
      supplied.attemptId,
      supplied.requestId,
      resume?.checkpoint_id,
    );
    if (supplied.ownership) context.ownership = supplied.ownership;
    const compact =
      pausedResume?.source === 'runtime'
        ? await readConsumedCompactContinuation(client, context)
        : null;
    const snapshot =
      compact?.snapshot ??
      (pausedResume
        ? locked.run.frozen_context?.execution_profile === 'compact-memory/1'
          ? HarnessR3SnapshotSchema.parse(pausedResume.snapshot)
          : HarnessPauseSnapshotSchema.parse(pausedResume.snapshot)
        : resume
          ? await readSnapshot(client, locked.run, resume.checkpoint_id)
          : null);
    if (snapshot?.version === 4) {
      await validateR3SnapshotContext(client, context, snapshot);
      context.r3Context = compact?.context ?? snapshot.context;
    }
    const observations = snapshot
      ? await readRunContextObservations(client, toolContext(context), snapshot.tool_refs, {
          project: context.allowlist.includes('read_run_observation'),
        })
      : [];
    const approval = snapshot?.waiting
      ? await readRunApprovalDecision(
          client,
          context,
          snapshot.waiting.invocation_id,
          snapshot.waiting.approval_id,
        )
      : null;
    const policy = await readRoutingPolicy(client, context.ownerId, context.runId);
    const decision = await readRoutingRecord<RoutingDecisionPayload>(
      client,
      context,
      'harness_routing_decision',
    );
    const states = await readRunInvocationStates(client, toolContext(context));
    const checkpoint = await client.query(
      `SELECT 1 FROM run_checkpoints WHERE attempt_id=$1 AND kind='harness_snapshot' LIMIT 1`,
      [context.attemptId],
    );
    const eligible =
      !context.trustedExecutionContext?.continuation &&
      !context.r3Context?.summary &&
      locked.attempt.attempt_no === 1 &&
      !resume &&
      !snapshot &&
      !decision &&
      !states.length &&
      !checkpoint.rowCount &&
      policy?.payload.policy.mode !== 'off' &&
      policy !== null;
    return { context, snapshot, observations, approval, policy, eligible, decision, compact };
  });
  const { context } = initial;
  const start = buildHarnessStart(
    context,
    initial.snapshot,
    initial.observations,
    initial.approval,
    initial.policy?.payload.policy ?? null,
    initial.eligible ? 'fresh_first_step' : 'disabled',
  );
  const tools = context.authorizationRevision ? [...start.tools, GOAL_CONTROL_TOOL] : start.tools;
  let stopped = false;
  let correctingGoal =
    (initial.snapshot?.version === 3 || initial.snapshot?.version === 4) &&
    initial.snapshot.native_state.closing_goal;
  let lastSnapshot = initial.snapshot;
  const delivered = new Set(initial.snapshot?.tool_refs ?? []);
  const cumulative = { ...(initial.snapshot?.usage ?? { iterations: 0, tokens: 0 }) };
  const sessionController = new AbortController();
  const sessionSignal = AbortSignal.any([signal, sessionController.signal]);
  const modelController = new AbortController();
  const modelSignal = AbortSignal.any([sessionSignal, modelController.signal]);
  const controllers = sessionAborts.get(context.runId) ?? new Set<AbortController>();
  controllers.add(sessionController);
  sessionAborts.set(context.runId, controllers);
  const routing = routingRuntimeOf(deps);
  const policy = initial.policy?.payload.policy ?? null;
  let facts: RoutingFacts | null = null;
  let embedding: RoutingEmbedding | null = null;
  let encodingCount = 0;
  let encodingPending = false;
  let routingDecision = initial.decision;
  let modelStarted =
    (initial.snapshot?.version === 3 || initial.snapshot?.version === 4) &&
    initial.snapshot.usage.iterations > 0;
  let latestModelMessage =
    initial.snapshot?.version === 3 || initial.snapshot?.version === 4
      ? initial.snapshot.native_state.pending_model
      : null;
  let modelToolCount = delivered.size;
  let nextPermit = false;
  let lastMeasurement: {
    measurement: ReturnType<typeof HarnessContextMeasurementSchema.parse>;
    remaining: number | null;
    output: number;
  } | null = null;
  let modelStream: {
    ref: string;
    iterator: AsyncGenerator<HarnessModelStep, void, unknown>;
    pendingDelta: string | null;
    pulling: boolean;
  } | null = null;
  async function closeModel(): Promise<void> {
    modelController.abort();
    const current = modelStream;
    modelStream = null;
    // The pending next() owns any transport error; cleanup must not replace it.
    const closing = current?.iterator.return().catch(() => undefined);
    if (context.ownership && sessionSignal.aborted) void closing;
    else await closing;
  }
  async function nextModelStep(): Promise<HarnessModelStep> {
    const current = modelStream;
    if (!current || current.pendingDelta !== null || current.pulling)
      throw stateConflict('model continuation requires an acknowledged previous delta');
    current.pulling = true;
    try {
      await guarded(assertActionAuthority);
      const next = await current.iterator.next();
      if (next.done)
        throw new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'model ended without completion');
      const parsed = HarnessModelStepSchema.safeParse(next.value);
      if (!parsed.success)
        throw new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'model step rejected');
      const step = parsed.data;
      await guarded(assertActionAuthority);
      if (step.type === 'delta') current.pendingDelta = step.delta;
      else {
        if (step.type === 'complete') {
          latestModelMessage =
            step.reply.message.tool_calls.length <= 1 ? step.reply.message : null;
          modelToolCount = delivered.size;
        } else latestModelMessage = null;
        cumulative.iterations++;
        const usage = step.type === 'complete' ? step.reply.usage : step.usage;
        cumulative.tokens =
          cumulative.tokens === null || usage === null
            ? null
            : cumulative.tokens + usage.total_tokens;
        if (cumulative.tokens !== null && !Number.isSafeInteger(cumulative.tokens))
          throw new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'model usage overflow');
        modelStream = null;
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
  async function guarded<T>(
    action: (client: PoolClient, locked: LockedRun) => Promise<T>,
  ): Promise<T> {
    if (stopped || sessionSignal.aborted) throw stateConflict('harness attempt stopped');
    return withRunTransaction(pool, context.ownership, async (client) => {
      const locked = await lockRun(client, context);
      if (stopped || sessionSignal.aborted) throw stateConflict('harness attempt stopped');
      if (context.workspaceGrant) validateWorkspaceGrant(context.ownerId, context.workspaceGrant);
      return action(client, locked);
    });
  }
  async function assertActionAuthority(client: PoolClient): Promise<void> {
    if (
      context.authorizationRevision === 'delegation/1' &&
      (await hasRejectedDocumentApproval(client, context))
    )
      throw forbidden('rejected document approval cannot authorize another action');
  }
  async function routingEligible(client: PoolClient, locked: LockedRun): Promise<void> {
    if (
      !initial.eligible ||
      !policy ||
      policy.mode === 'off' ||
      locked.attempt.attempt_no !== 1 ||
      modelStarted ||
      lastSnapshot ||
      cumulative.iterations !== 0 ||
      cumulative.tokens !== 0 ||
      routingDecision
    )
      throw stateConflict('routing requires fresh first step');
    if ((await readRunInvocationStates(client, toolContext(context))).length)
      throw stateConflict('routing must precede tool reservation');
  }
  function validateFacts(value: RoutingFacts): RoutingFacts {
    const result = RoutingFactsSchema.parse(value);
    if (
      !policy ||
      policy.mode === 'off' ||
      result.input_sha256 !== routingHash(context.inputText) ||
      result.bundle_sha256 !== policy.bundle_sha256
    )
      throw stateConflict('routing facts input or bundle binding conflict');
    const scalars = Array.from(context.inputText);
    for (const candidate of result.candidates) {
      if (!policy.candidate_intents.includes(candidate.intent))
        throw forbidden('routing candidate outside frozen policy');
      const keys = Object.keys(candidate.args);
      if (candidate.intent === 'task_list_bounded') {
        if (
          candidate.tool_id !== 'list_tasks' ||
          !keys.includes('limit') ||
          keys.some((key) => key !== 'limit' && key !== 'state') ||
          ('state' in candidate.args && candidate.args.state !== null) ||
          !Number.isInteger(candidate.args.limit) ||
          Number(candidate.args.limit) < 1 ||
          Number(candidate.args.limit) > 50
        )
          throw stateConflict('routing task arguments outside bounded contract');
      } else if (candidate.intent === 'prefs_timezone_read') {
        if (candidate.tool_id !== 'get_user_prefs' || keys.length || candidate.sources.length)
          throw stateConflict('routing prefs must use server owner and empty arguments');
      } else {
        const date = candidate.args.date;
        if (
          candidate.tool_id !== 'read_brief_cards' ||
          keys.length !== 1 ||
          keys[0] !== 'date' ||
          typeof date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date)
        )
          throw stateConflict('routing brief requires one Gregorian date');
        const year = Number(date.slice(0, 4)),
          month = Number(date.slice(5, 7)),
          day = Number(date.slice(8));
        const days = [
          31,
          year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
          31,
          30,
          31,
          30,
          31,
          31,
          30,
          31,
          30,
          31,
        ];
        if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!)
          throw stateConflict('routing brief requires valid Gregorian date');
      }
      if (candidate.sources.length !== keys.length)
        throw stateConflict('routing requires one source for every parameter');
      const seen = new Set<string>();
      for (const source of candidate.sources) {
        if (
          !keys.includes(source.field) ||
          seen.has(source.field) ||
          source.parser_revision !== policy.parser_revision
        )
          throw stateConflict('routing parameter source binding conflict');
        seen.add(source.field);
        if (source.source === 'contract_default') {
          if (
            candidate.intent !== 'task_list_bounded' ||
            !(
              (source.field === 'limit' && candidate.args.limit === 20) ||
              (source.field === 'state' && candidate.args.state === null)
            )
          )
            throw stateConflict('routing parameter has no contract default');
        } else if (
          (source.field !== 'limit' && source.field !== 'date') ||
          source.message_id !== context.userMessageId ||
          source.end > scalars.length ||
          scalars.slice(source.start, source.end).join('') !== source.raw ||
          (source.field === 'date'
            ? candidate.args.date !== source.raw
            : !/^\d+$/.test(source.raw) || Number(source.raw) !== candidate.args.limit)
        )
          throw stateConflict('routing message source does not match frozen input');
      }
    }
    // Keep the runtime-owned evidence identity; its private input binding is not serializable.
    return value;
  }
  async function directInvocation(client: PoolClient, invocationId: string): Promise<void> {
    const decision = routingDecision?.payload;
    if (!decision || decision.decision !== 'direct')
      throw stateConflict('routing direct decision missing');
    const rows = (
      await client.query<{
        invocation_id: string;
        tool_id: string;
        args_hash: string;
        first_attempt_id: string;
        call_key: string;
        execution_kind: string;
      }>(
        `SELECT invocation_id,tool_id,args_hash,first_attempt_id,call_key,execution_kind
        FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3`,
        [context.ownerId, context.conversationId, context.runId],
      )
    ).rows;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.invocation_id !== invocationId ||
      row.first_attempt_id !== context.attemptId ||
      row.call_key !== 'harness/1' ||
      row.execution_kind !== 'read_only' ||
      row.tool_id !== decision.tool_id ||
      row.args_hash !== decision.args_hash
    )
      throw stateConflict('routing direct requires unique original invocation');
  }
  async function send(event: ThreadEvent): Promise<void> {
    if (!(await write(event))) throw stateConflict('client disconnected');
  }
  async function approvalEvents(
    payload: Extract<ToolPayload, { kind: 'approval' | 'document_approval' }>,
  ): Promise<void> {
    if (payload.kind === 'document_approval') {
      const event = await guarded((client) =>
        appendEvent(client, context, 'approval_required', {
          ...eventPayload(context),
          approval_id: payload.approval.approval_id,
          card_id: `document-approval:${payload.approval.approval_id}`,
          presentation_hash: payload.approval.presentation_hash,
        }),
      );
      await send(event);
      return;
    }
    const events = await guarded(async (client) => [
      await appendEvent(client, context, 'card.proposed', {
        ...eventPayload(context),
        card_id: payload.card_id,
        schema_version: 'v1',
        wall_time: payload.approval.wallTime,
        timezone_id: payload.approval.timezoneId,
        original_text: payload.original_text,
      }),
      await appendEvent(client, context, 'approval_required', {
        ...eventPayload(context),
        approval_id: payload.approval.approvalId,
        card_id: payload.card_id,
        presentation_hash: payload.approval.presentationHash,
      }),
    ]);
    for (const event of events) await send(event);
  }
  async function validateSnapshot(
    client: PoolClient,
    snapshot: HarnessSnapshot | HarnessR3Snapshot,
  ): Promise<void> {
    if (
      (modelStarted || snapshot.version === 4) &&
      (snapshot.usage.iterations !== cumulative.iterations ||
        snapshot.usage.tokens !== cumulative.tokens)
    )
      throw stateConflict('snapshot usage must match accepted model steps');
    if (snapshot.version === 4) {
      if (
        context.executionProfile !== 'compact-memory/1' ||
        routingIdentity(snapshot.context) !== routingIdentity(context.r3Context)
      )
        throw stateConflict('snapshot context differs from trusted execution view');
      await validateR3SnapshotContext(client, context, snapshot);
    } else {
      const frozenRefs = context.messageRefs ?? [context.userMessageId];
      if (
        snapshot.message_refs.length !== frozenRefs.length ||
        snapshot.message_refs.some((ref, index) => ref !== frozenRefs[index])
      )
        throw stateConflict('snapshot message reference conflict');
    }
    if (new Set(snapshot.tool_refs).size !== snapshot.tool_refs.length)
      throw stateConflict('duplicate snapshot tool reference');
    const states = await readRunInvocationStates(client, toolContext(context));
    const accepted = states.filter((row) => row.state === 'completed');
    if (
      accepted.length !== snapshot.tool_refs.length ||
      accepted.some((row) => !snapshot.tool_refs.includes(row.invocation_id))
    )
      throw stateConflict('snapshot must retain accepted Run invocations');
    const observations = await readRunContextObservations(
      client,
      toolContext(context),
      snapshot.tool_refs,
      { project: context.allowlist.includes('read_run_observation') },
    );
    if (snapshot.version === 4) {
      if (snapshot.native_state.units.length !== snapshot.tool_refs.length)
        throw stateConflict('snapshot must retain each accepted observation');
      for (let i = 0; i < snapshot.native_state.units.length; i++) {
        const unit = snapshot.native_state.units[i]!;
        if (unit.observation.invocation_id !== snapshot.tool_refs[i])
          throw stateConflict('snapshot observation order conflict');
        const source = await readRunContextSource(
          client,
          toolContext(context),
          unit.observation.invocation_id,
          unit.observation.view,
        );
        if (routingIdentity(source) !== routingIdentity(unit.observation))
          throw stateConflict('snapshot observation differs from accepted result');
      }
      if (
        snapshot.native_state.pending_model &&
        (modelToolCount !== delivered.size ||
          routingIdentity(snapshot.native_state.pending_model) !==
            routingIdentity(latestModelMessage))
      )
        throw stateConflict('snapshot pending model differs from accepted response');
    }
    const next = accepted.reduce((max, row) => {
      const match = /^harness\/([1-9]\d*)$/.exec(row.call_key);
      if (!match) throw stateConflict('invalid harness invocation slot');
      return Math.max(max, Number(match[1]) + 1);
    }, 1);
    if (snapshot.next_call_no !== next || snapshot.usage.iterations > context.maxIterations)
      throw stateConflict('snapshot usage or call counter conflict');
    if (
      routingDecision?.payload.decision === 'direct' &&
      (snapshot.usage.iterations !== 0 ||
        snapshot.usage.tokens !== 0 ||
        snapshot.waiting ||
        snapshot.tool_refs.length !== 1 ||
        accepted.length !== 1)
    )
      throw stateConflict('routing snapshot must retain unique result and zero model usage');
    const previous = (
      await client.query<{ payload: unknown }>(
        `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
        WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq DESC LIMIT 1`,
        [context.runId],
      )
    ).rows[0];
    const baseline = previous
      ? context.executionProfile === 'compact-memory/1'
        ? HarnessR3SnapshotSchema.parse(previous.payload)
        : HistoricalHarnessSnapshotSchema.parse(previous.payload)
      : lastSnapshot;
    if (
      baseline &&
      (snapshot.next_call_no < baseline.next_call_no ||
        snapshot.usage.iterations < baseline.usage.iterations ||
        (baseline.usage.tokens !== null &&
          snapshot.usage.tokens !== null &&
          snapshot.usage.tokens < baseline.usage.tokens))
    )
      throw stateConflict('snapshot cannot move backwards');
    if (
      baseline &&
      baseline.usage.iterations > 0 &&
      baseline.usage.tokens === null &&
      snapshot.usage.tokens !== null
    )
      throw stateConflict('unknown cumulative token usage must remain unknown');
    const pending = accepted.filter((row) => row.outcome_kind === 'approval_pending');
    const unresolved = [];
    for (const row of pending) {
      if (!row.approval_id) throw stateConflict('missing approval reference');
      if (
        (await readRunApprovalDecision(client, context, row.invocation_id, row.approval_id))
          .status === 'pending'
      )
        unresolved.push(row);
    }
    if (snapshot.waiting) {
      const row = pending.find(
        (row) =>
          row.invocation_id === snapshot.waiting!.invocation_id &&
          row.approval_id === snapshot.waiting!.approval_id,
      );
      if (!row || !delivered.has(row.invocation_id))
        throw stateConflict('snapshot waiting reference conflict');
      if (unresolved.some((pending) => pending.invocation_id !== row.invocation_id))
        throw stateConflict('snapshot omits unresolved approval');
    } else if (unresolved.length) throw stateConflict('snapshot omits unresolved approval');
    buildHarnessStart(
      context,
      snapshot,
      observations,
      snapshot.waiting
        ? await readRunApprovalDecision(
            client,
            context,
            snapshot.waiting.invocation_id,
            snapshot.waiting.approval_id,
          )
        : null,
    );
  }
  return {
    start,
    close: async () => {
      stopped = true;
      sessionController.abort();
      controllers.delete(sessionController);
      if (!controllers.size && sessionAborts.get(context.runId) === controllers)
        sessionAborts.delete(context.runId);
      await closeModel();
    },
    handleRequest: async (suppliedRequest) => {
      try {
        const request = HarnessRequestSchema.parse(suppliedRequest);
        if (request.protocol !== start.protocol)
          throw stateConflict('harness protocol version conflict');
        if (
          context.compactControl &&
          !(['pause_probe', 'pause_point', 'finish'] as const).some((type) => type === request.type)
        )
          throw stateConflict('compact control cannot execute conversational actions');
        if (
          context.compactControl &&
          request.type === 'finish' &&
          request.outcome === 'done' &&
          (!initial.snapshot || !initial.compact)
        )
          throw stateConflict('compact control requires a published successor');
        await guarded(async () => undefined);
        if (modelStream && request.type === 'finish' && request.outcome !== 'done')
          await closeModel();
        if (modelStream && request.type !== 'model_next' && request.type !== 'answer')
          throw stateConflict('model stream must complete before another action');
        if (request.type === 'pause_probe') {
          if (
            !(
              ((context.executionProfile === 'pause/1' ||
                context.executionProfile === 'pause-memory/1') &&
                request.protocol === HARNESS_R3_PROTOCOL_VERSION) ||
              (context.executionProfile === 'compact-memory/1' &&
                request.protocol === HARNESS_CONTEXT_PROTOCOL_VERSION)
            )
          )
            throw stateConflict('pause protocol not enabled for Run');
          return guarded(async (client) => {
            await assertActionAuthority(client);
            let pending =
              (
                await client.query(
                  `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
                  [context.ownerId, context.runId, context.attemptId],
                )
              ).rowCount !== 0;
            const measured = lastMeasurement;
            lastMeasurement = null;
            if (
              !pending &&
              request.after_measurement &&
              nextPermit &&
              !context.compactControl &&
              context.executionProfile === 'compact-memory/1' &&
              context.r3Context &&
              context.contextPolicy &&
              measured &&
              shouldAutoCompact({
                policy: context.autoCompactPolicy ?? null,
                contextPolicy: context.contextPolicy,
                measurement: measured.measurement,
                remainingTokens: measured.remaining,
                maxOutputTokens: measured.output,
                iterationsRemaining: context.maxIterations - cumulative.iterations,
                uncoveredMessageCount: context.r3Context.messages.length,
              })
            ) {
              const prior = await client.query(
                `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND purpose='automatic_compact'
                 AND snapshot->'context'=$3::jsonb LIMIT 1`,
                [context.ownerId, context.runId, JSON.stringify(context.r3Context)],
              );
              const live = await client.query(
                `SELECT 1 FROM harness_pauses WHERE run_id=$1 AND state IN ('pending','paused')`,
                [context.runId],
              );
              if (!prior.rowCount && !live.rowCount) {
                const id = randomUUID();
                await client.query(
                  `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
                   VALUES($1,$2,$3,$4,$5,$6,'runtime','automatic_compact','runtime','pending')`,
                  [
                    id,
                    context.ownerId,
                    context.conversationId,
                    context.runId,
                    context.attemptId,
                    randomUUID(),
                  ],
                );
                await client.query(
                  `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status)
                   VALUES($1,$2,$3,$4,$5,'pending')`,
                  [id, context.ownerId, context.conversationId, context.runId, context.attemptId],
                );
                pending = true;
              }
            }
            nextPermit = !pending;
            return { pending };
          });
        }
        if (request.type === 'pause_point') {
          if (
            !(
              ((context.executionProfile === 'pause/1' ||
                context.executionProfile === 'pause-memory/1') &&
                request.protocol === HARNESS_R3_PROTOCOL_VERSION) ||
              (context.executionProfile === 'compact-memory/1' &&
                request.protocol === HARNESS_CONTEXT_PROTOCOL_VERSION)
            )
          )
            throw stateConflict('pause protocol not enabled for Run');
          const paused = await guarded(async (client) => {
            const pending = (
              await client.query<{ id: string }>(
                `SELECT id FROM harness_pauses WHERE owner_id=$1 AND run_id=$2
               AND attempt_id=$3 AND state='pending' FOR UPDATE`,
                [context.ownerId, context.runId, context.attemptId],
              )
            ).rows[0];
            if (!pending) {
              nextPermit = true;
              return false;
            }
            await assertActionAuthority(client);
            const snapshot = request.context;
            if (snapshot.version === 4 && snapshot.waiting)
              throw stateConflict('pause cannot consume approval waiting');
            if (
              snapshot.native_state.pending_model &&
              (modelToolCount !== delivered.size ||
                routingIdentity(snapshot.native_state.pending_model) !==
                  routingIdentity(latestModelMessage))
            )
              throw stateConflict('pause pending model call differs from accepted response');
            if (
              snapshot.usage.iterations !== cumulative.iterations ||
              snapshot.usage.tokens !== cumulative.tokens
            )
              throw stateConflict('pause usage differs from accepted model steps');
            const states = await readRunInvocationStates(client, toolContext(context));
            if (states.some((row) => row.state !== 'completed' || row.outcome_kind === 'failed'))
              throw stateConflict('pause requires all tool effects to be resolved');
            await validateSnapshot(
              client,
              snapshot.version === 4
                ? snapshot
                : {
                    version: 2,
                    message_refs: snapshot.message_refs,
                    tool_refs: snapshot.tool_refs,
                    next_call_no: snapshot.next_call_no,
                    usage: snapshot.usage,
                    waiting: null,
                  },
            );
            if (snapshot.native_state.units.length !== snapshot.tool_refs.length)
              throw stateConflict('pause must retain each accepted observation');
            for (let i = 0; i < snapshot.native_state.units.length; i++) {
              const unit = snapshot.native_state.units[i]!;
              if (unit.observation.invocation_id !== snapshot.tool_refs[i])
                throw stateConflict('pause observation order differs from accepted tools');
              const authoritative = await readRunContextSource(
                client,
                toolContext(context),
                unit.observation.invocation_id,
                unit.observation.view,
              );
              if (routingIdentity(authoritative) !== routingIdentity(unit.observation))
                throw stateConflict('pause observation differs from accepted result');
            }
            buildHarnessStart(
              context,
              snapshot,
              await readRunContextObservations(client, toolContext(context), snapshot.tool_refs, {
                project: context.allowlist.includes('read_run_observation'),
              }),
              null,
            );
            await client.query(
              `UPDATE harness_pauses SET state='paused',snapshot=$2::jsonb WHERE id=$1`,
              [pending.id, JSON.stringify(snapshot)],
            );
            await client.query(`UPDATE agent_runs SET status='paused' WHERE id=$1`, [
              context.runId,
            ]);
            await client.query(`UPDATE run_attempts SET status='done',ended_at=now() WHERE id=$1`, [
              context.attemptId,
            ]);
            return true;
          });
          if (paused) stopped = true;
          return { paused };
        }
        if (request.type === 'route_probe') {
          if (request.stage === 'facts') {
            return await guarded(async (client, locked) => {
              await routingEligible(client, locked);
              if (facts || encodingCount || encodingPending)
                throw stateConflict('routing facts probe out of order');
              const pending = (
                await client.query<{
                  id: string;
                  waiting_invocation_id: string;
                  waiting_approval_id: string;
                }>(
                  `SELECT id,waiting_invocation_id,waiting_approval_id FROM agent_runs
              WHERE owner_id=$1 AND conversation_id=$2 AND status='suspended_approval'`,
                  [context.ownerId, context.conversationId],
                )
              ).rows;
              let hasPendingApproval = false;
              for (const run of pending) {
                const decision = await readRunApprovalDecision(
                  client,
                  {
                    ownerId: context.ownerId,
                    conversationId: context.conversationId,
                    runId: run.id,
                  },
                  run.waiting_invocation_id,
                  run.waiting_approval_id,
                );
                if (decision.status === 'pending') hasPendingApproval = true;
              }
              facts = validateFacts(
                routing.facts(
                  {
                    messageId: context.userMessageId!,
                    text: context.inputText,
                    messages: context.messages!.map(({ role, content }) => ({ role, content })),
                    hasPendingApproval,
                    workspaceSelected:
                      !!context.workspaceGrant || !!context.workspaceGrants?.length,
                  },
                  policy!,
                ),
              );
              return structuredClone(facts);
            });
          }
          const cached = await guarded(async (client, locked) => {
            await routingEligible(client, locked);
            if (
              !facts ||
              request.facts_ref !== facts.facts_ref ||
              !facts.eligible ||
              facts.rule_intent !== null ||
              encodingCount ||
              encodingPending
            )
              throw stateConflict('routing embedding probe out of order');
            encodingCount = 1;
            encodingPending = true;
            return facts;
          });
          try {
            const encoded = RoutingEmbeddingSchema.parse(
              await routing.embedding(context.inputText, cached, policy!, sessionSignal),
            );
            return await guarded(async (client, locked) => {
              await routingEligible(client, locked);
              if (
                encoded.facts_ref !== cached.facts_ref ||
                encoded.input_sha256 !== cached.input_sha256 ||
                encoded.bundle_sha256 !== cached.bundle_sha256
              )
                throw stateConflict('routing embedding evidence binding conflict');
              embedding = encoded;
              return structuredClone(encoded);
            });
          } finally {
            encodingPending = false;
          }
        }
        if (request.type === 'route_decide') {
          const accepted = await guarded(async (client, locked) => {
            if (
              encodingPending ||
              !facts ||
              request.facts_ref !== facts.facts_ref ||
              !initial.policy ||
              !policy ||
              policy.mode === 'off'
            )
              throw stateConflict('routing decision requires cached completed evidence');
            const candidate =
              request.decision === 'direct'
                ? (facts.candidates.find((entry) => entry.intent === request.candidate_intent) ??
                  null)
                : null;
            const payload = decisionPayload(
              context,
              initial.policy.id,
              facts,
              embedding,
              encodingCount,
              request.decision,
              request.reason,
              candidate,
            );
            const previous = await readRoutingRecord<RoutingDecisionPayload>(
              client,
              context,
              'harness_routing_decision',
            );
            if (previous) {
              if (request.candidate_intent !== previous.payload.intent)
                throw stateConflict('routing decision is immutable');
              return acceptRoutingDecision(client, context, payload);
            }
            if (
              context.executionProfile === 'pause/1' ||
              context.executionProfile === 'pause-memory/1' ||
              context.executionProfile === 'compact-memory/1'
            ) {
              const pending = await client.query(
                `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
                [context.ownerId, context.runId, context.attemptId],
              );
              if (pending.rowCount) return null;
            }
            await routingEligible(client, locked);
            if (request.decision === 'fallback') {
              if (request.candidate_intent !== null)
                throw stateConflict('fallback cannot authorize candidate');
            } else {
              if (
                !candidate ||
                !facts.eligible ||
                policy.mode !== 'enforce' ||
                !policy.direct_intents.includes(candidate.intent) ||
                !context.allowlist.includes(candidate.tool_id) ||
                routing.choose(facts, embedding, policy) !== candidate.intent
              )
                throw forbidden(
                  'routing direct not authorized by cached evidence and frozen policy',
                );
            }
            return acceptRoutingDecision(client, context, payload);
          });
          if (!accepted) return { pause_requested: true };
          routingDecision = accepted;
          return routingDecisionReply(accepted);
        }
        if (request.type === 'render_route_result') {
          const prepared = await guarded(async (client) => {
            if (
              !routingDecision ||
              routingDecision.payload.decision !== 'direct' ||
              request.decision_ref !== routingDecision.id ||
              !policy ||
              policy.mode === 'off' ||
              request.template_revision !== policy.renderer_revision ||
              modelStarted ||
              !lastSnapshot ||
              lastSnapshot.waiting ||
              lastSnapshot.tool_refs.length !== 1 ||
              lastSnapshot.tool_refs[0] !== request.invocation_ref ||
              lastSnapshot.usage.iterations !== 0 ||
              lastSnapshot.usage.tokens !== 0 ||
              !delivered.has(request.invocation_ref)
            )
              throw stateConflict(
                'routing render requires accepted result and zero-model snapshot',
              );
            await directInvocation(client, request.invocation_ref);
            const previous = await readRoutingRecord<RoutingRenderPayload>(
              client,
              context,
              'harness_routing_render',
            );
            if (previous) {
              if (
                previous.payload.decision_ref !== request.decision_ref ||
                previous.payload.invocation_ref !== request.invocation_ref ||
                previous.payload.template_revision !== request.template_revision
              )
                throw stateConflict('routing render is immutable');
              return null;
            }
            const accepted = (
              await readInvocationSnapshots(client, toolContext(context), [request.invocation_ref])
            )[0];
            if (!accepted || accepted.result.status !== 'ok')
              throw stateConflict('routing requires successful accepted result');
            return accepted.result;
          });
          if (prepared === null) return { rendered: true };
          // Pure projection and all byte/chunk preparation deliberately happen outside locks.
          let text: string;
          try {
            text = routing.render(routingDecision!.payload.intent!, prepared);
          } catch (error) {
            if (error instanceof Error && error.message === 'ROUTING_RENDER_CAPACITY')
              throw new HttpError(422, 422, 'HARNESS_CONTEXT_LIMIT', '只读结果超过完整展示容量。');
            throw error;
          }
          if (!text || Buffer.byteLength(text, 'utf8') > HARNESS_MAX_FRAME_BYTES)
            throw new HttpError(422, 422, 'HARNESS_CONTEXT_LIMIT', '只读结果超过完整展示容量。');
          const chunks: string[] = [];
          let chunk = '';
          for (const scalar of text) {
            if (chunk.length + scalar.length > 4000) {
              chunks.push(chunk);
              chunk = '';
            }
            chunk += scalar;
          }
          if (chunk) chunks.push(chunk);
          const events = await guarded(async (client) => {
            await directInvocation(client, request.invocation_ref);
            if (await readRoutingRecord(client, context, 'harness_routing_render'))
              throw stateConflict('routing render already accepted');
            const events: ThreadEvent[] = [];
            for (const delta of chunks)
              events.push(
                await appendEvent(client, context, 'message.delta', {
                  ...eventPayload(context),
                  delta,
                }),
              );
            await insertRoutingRender(client, context, {
              decision_ref: request.decision_ref,
              invocation_ref: request.invocation_ref,
              template_revision: request.template_revision,
              body_sha256: routingHash(text),
              chunk_count: chunks.length,
            });
            return events;
          });
          for (const event of events) {
            await guarded(async () => undefined);
            await send(event);
          }
          return { rendered: true };
        }
        if (
          routingDecision?.payload.decision === 'direct' &&
          (request.type === 'model' ||
            request.type === 'measure_context' ||
            request.type === 'model_next' ||
            request.type === 'suspend' ||
            request.type === 'answer')
        )
          throw forbidden('routing direct cannot call model or accept native answer');
        if (
          initial.eligible &&
          !routingDecision &&
          (request.type === 'model' ||
            request.type === 'measure_context' ||
            request.type === 'reserve' ||
            request.type === 'invoke')
        )
          throw stateConflict('routing requires terminal decision before original path');
        if (request.type === 'model_next') {
          if (!modelStream || request.model_ref !== modelStream.ref)
            throw stateConflict('model continuation reference conflict');
          return nextModelStep();
        }
        if (request.type === 'context_source') {
          if (!delivered.has(request.invocation_id))
            throw forbidden('context source outside accepted Run references');
          const observation = await guarded((client) =>
            readRunContextSource(client, toolContext(context), request.invocation_id, request.view),
          );
          await guarded(async () => undefined);
          return observation;
        }
        if (request.type === 'model' || request.type === 'measure_context') {
          if (
            (context.executionProfile === 'pause/1' ||
              context.executionProfile === 'pause-memory/1' ||
              context.executionProfile === 'compact-memory/1') &&
            request.type === 'model'
          ) {
            if (!nextPermit) throw stateConflict('model requires a safe-point permit');
            nextPermit = false;
          }
          if (!approvalAuthorizesActions(initial.approval))
            throw forbidden('rejected approval cannot authorize another action');
          if (!deps.harness || !context.contextPolicy) throw unavailable();
          const remaining =
            cumulative.tokens === null ? null : Math.max(0, context.maxTokens - cumulative.tokens);
          if (request.remaining_tokens !== remaining)
            throw stateConflict('model balance must match accepted cumulative usage');
          if (cumulative.iterations >= context.maxIterations)
            throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
          if (!deps.modelTransport) throw unavailable();
          const selected = await guarded((client) =>
            resolveRunSelection(client, context.ownerId, context.runId),
          );
          if (!selected) throw stateConflict('legacy Run model binding unavailable');
          if (selected.model_id !== context.contextPolicy.model_binding.model) throw unavailable();
          const transport = await deps.modelTransport(selected);
          const measurement = await transport.measure(
            { ...request, type: 'measure_context' },
            tools,
            context.contextPolicy,
          );
          if (request.type === 'measure_context') {
            lastMeasurement = {
              measurement: HarnessContextMeasurementSchema.parse(measurement),
              remaining: request.remaining_tokens,
              output: request.max_output_tokens,
            };
            return measurement;
          }
          const scheduled = await guarded(async (client) => {
            await assertActionAuthority(client);
            if (
              context.executionProfile === 'pause/1' ||
              context.executionProfile === 'pause-memory/1' ||
              context.executionProfile === 'compact-memory/1'
            ) {
              const pending = await client.query(
                `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
                [context.ownerId, context.runId, context.attemptId],
              );
              if (pending.rowCount) return false;
            }
            if (
              measurement.limit_reason ||
              request.max_output_tokens > measurement.output_ceiling
            ) {
              const budget =
                measurement.limit_reason === 'budget' ||
                (remaining !== null && request.max_output_tokens > remaining);
              throw new HttpError(
                budget ? 429 : 422,
                budget ? 429 : 422,
                budget ? 'BUDGET_EXCEEDED' : 'HARNESS_CONTEXT_LIMIT',
                '模型请求超过本轮额度或容量。',
              );
            }
            const states = await readRunInvocationStates(client, toolContext(context));
            if (states.some((row) => row.state === 'unknown' || row.outcome_kind === 'failed'))
              throw stateConflict('Run has unresolved tool effects');
            if (
              states.some(
                (row) =>
                  row.outcome_kind === 'approval_pending' &&
                  !initial.snapshot?.tool_refs.includes(row.invocation_id),
              )
            )
              throw stateConflict('approval requires suspension before further actions');
            // Establish the model reservation under the same attempt → Run
            // locks used by pause registration, before invoking the transport.
            modelStream = {
              ref: request.request_ref,
              iterator: transport.model(request, tools, modelSignal)[Symbol.asyncIterator](),
              pendingDelta: null,
              pulling: false,
            };
            modelStarted = true;
            return true;
          });
          if (!scheduled) return { type: 'pause_requested' };
          return nextModelStep();
        }
        if (request.type === 'reserve') {
          if (
            context.executionProfile === 'pause/1' ||
            context.executionProfile === 'pause-memory/1' ||
            context.executionProfile === 'compact-memory/1'
          ) {
            if (!nextPermit) throw stateConflict('tool reservation requires a safe-point permit');
            nextPermit = false;
          }
          if (correctingGoal)
            throw stateConflict('goal correction cannot reserve business actions');
          if (!approvalAuthorizesActions(initial.approval))
            throw forbidden('rejected approval cannot authorize another action');
          if (!context.allowlist.includes(request.tool_id))
            throw forbidden('tool outside frozen Run grant');
          if (
            routingDecision?.payload.decision === 'direct' &&
            (request.call_key !== 'harness/1' ||
              request.tool_id !== routingDecision.payload.tool_id ||
              routingIdentity(request.args) !== routingIdentity(routingDecision.payload.args))
          )
            throw forbidden('routing direct must reserve original unique tool and arguments');
          await guarded(async (client) => {
            await assertActionAuthority(client);
            if (routingDecision?.payload.decision === 'direct') {
              const states = await readRunInvocationStates(client, toolContext(context));
              if (
                states.length > 1 ||
                states.some(
                  (state) =>
                    state.call_key !== 'harness/1' ||
                    state.tool_id !== routingDecision!.payload.tool_id ||
                    state.state !== 'reserved',
                )
              )
                throw stateConflict('routing direct cannot reserve a second slot');
            }
            const states = await readRunInvocationStates(client, toolContext(context));
            if (states.some((row) => row.state === 'unknown' || row.outcome_kind === 'failed'))
              throw stateConflict('Run has unresolved tool effects');
            if (
              states.some(
                (row) =>
                  row.outcome_kind === 'approval_pending' &&
                  !initial.snapshot?.tool_refs.includes(row.invocation_id),
              )
            )
              throw stateConflict('approval requires suspension before further actions');
            const accepted = states.filter((row) => row.state === 'completed').length;
            if (accepted >= 64)
              throw new HttpError(
                422,
                422,
                'HARNESS_CONTEXT_LIMIT',
                '工具引用达到安全上限，已停下。',
              );
            if (request.call_key !== `harness/${accepted + 1}`)
              throw stateConflict('invalid next harness slot');
          });
          const reservation = {
            callKey: request.call_key,
            toolId: request.tool_id,
            args: request.args,
          };
          const toolCtx = { ...toolContext(context), signal: sessionSignal };
          const reserved =
            routingDecision?.payload.decision !== 'direct' &&
            (context.executionProfile === 'pause/1' ||
              context.executionProfile === 'pause-memory/1' ||
              context.executionProfile === 'compact-memory/1')
              ? await reserveToolInvocation(pool, toolCtx, reservation, { deferOnPause: true })
              : await reserveToolInvocation(pool, toolCtx, reservation);
          if ('pauseRequested' in reserved) return { pause_requested: true };
          await guarded(async () => undefined);
          return { invocation_id: reserved.invocationId };
        }
        if (request.type === 'invoke') {
          if (correctingGoal) throw stateConflict('goal correction cannot invoke business actions');
          if (!approvalAuthorizesActions(initial.approval))
            throw forbidden('rejected approval cannot authorize another action');
          if (
            routingDecision?.payload.decision === 'direct' &&
            (request.tool_id !== routingDecision.payload.tool_id ||
              routingIdentity(request.args) !== routingIdentity(routingDecision.payload.args))
          )
            throw forbidden('routing direct must invoke original tool and arguments');
          if (initial.snapshot?.tool_refs.includes(request.invocation_id))
            throw stateConflict('resume consumes stored observations without reinvoking them');
          await guarded(async (client) => {
            await assertActionAuthority(client);
            if (routingDecision?.payload.decision === 'direct')
              await directInvocation(client, request.invocation_id);
            const states = await readRunInvocationStates(client, toolContext(context));
            if (states.some((row) => row.state === 'unknown' || row.outcome_kind === 'failed'))
              throw stateConflict('Run has unresolved tool effects');
            if (
              states.some(
                (row) =>
                  row.outcome_kind === 'approval_pending' &&
                  !initial.snapshot?.tool_refs.includes(row.invocation_id) &&
                  row.invocation_id !== request.invocation_id,
              )
            )
              throw stateConflict('approval requires suspension before further actions');
          });
          const outcome = await invokeTool(
            pool,
            { ...toolContext(context), signal: sessionSignal },
            {
              invocationId: request.invocation_id,
              toolId: request.tool_id,
              args: request.args,
            },
          );
          await guarded(async () => undefined);
          if (
            !delivered.has(outcome.invocationId) &&
            outcome.status === 'ok' &&
            (outcome.result.kind === 'approval' || outcome.result.kind === 'document_approval')
          )
            await approvalEvents(outcome.result);
          delivered.add(outcome.invocationId);
          return outcome;
        }
        if (request.type === 'snapshot') {
          const snapshot =
            request.context.version === 4
              ? HarnessR3SnapshotSchema.parse(request.context)
              : HarnessSnapshotSchema.parse(request.context);
          const id = await guarded(async (client) => {
            await validateSnapshot(client, snapshot);
            const seq = (
              await client.query<{ seq: number }>(
                'SELECT COALESCE(max(seq),0)::int+1 AS seq FROM run_checkpoints WHERE attempt_id=$1',
                [context.attemptId],
              )
            ).rows[0]?.seq;
            const id = randomUUID();
            await client.query(
              `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
          VALUES($1,$2,$3,$4,'harness_snapshot',$5::jsonb,$6)`,
              [
                id,
                context.ownerId,
                context.attemptId,
                seq,
                JSON.stringify(snapshot),
                start.protocol,
              ],
            );
            return id;
          });
          lastSnapshot = snapshot;
          return { checkpoint_ref: id };
        }
        if (request.type === 'suspend') {
          await guarded(async (client, locked) => {
            await assertActionAuthority(client);
            const latest = (
              await client.query<{ id: string }>(
                `SELECT id FROM run_checkpoints WHERE attempt_id=$1 AND kind='harness_snapshot' ORDER BY seq DESC LIMIT 1`,
                [context.attemptId],
              )
            ).rows[0]?.id;
            if (latest !== request.checkpoint_ref)
              throw stateConflict('suspend requires latest attempt checkpoint');
            const snapshot = await readSnapshot(client, locked.run, request.checkpoint_ref);
            await validateSnapshot(client, snapshot);
            if (
              snapshot.waiting?.invocation_id !== request.invocation_id ||
              snapshot.waiting.approval_id !== request.approval_id
            )
              throw stateConflict('suspend waiting reference conflict');
            if (initial.snapshot?.tool_refs.includes(request.invocation_id))
              throw stateConflict('original approval waiting point cannot suspend again');
            const states = await readRunInvocationStates(client, toolContext(context));
            if (states.some((row) => row.state !== 'completed' || row.outcome_kind === 'failed'))
              throw stateConflict('cannot suspend unresolved tool effects');
            await client.query(
              `UPDATE harness_pauses SET state='invalidated'
               WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
              [context.ownerId, context.runId, context.attemptId],
            );
            await client.query(
              `UPDATE agent_runs SET status='suspended_approval',waiting_checkpoint_id=$2,
          waiting_invocation_id=$3,waiting_approval_id=$4 WHERE id=$1`,
              [context.runId, request.checkpoint_ref, request.invocation_id, request.approval_id],
            );
            await client.query(`UPDATE run_attempts SET status='done',ended_at=now() WHERE id=$1`, [
              context.attemptId,
            ]);
          });
          stopped = true;
          return { suspended: true };
        }
        if (request.type === 'answer') {
          if (
            !modelStream ||
            modelStream.pendingDelta === null ||
            request.delta !== modelStream.pendingDelta
          )
            throw stateConflict('native answer must match the accepted model delta');
          const event = await guarded((client) =>
            appendEvent(client, context, 'message.delta', {
              ...eventPayload(context),
              delta: request.delta,
            }),
          );
          await send(event);
          if (modelStream) modelStream.pendingDelta = null;
          return { accepted: true };
        }
        if (request.type === 'finish_goal') {
          if (context.executionProfile === 'compact-memory/1') {
            if (!nextPermit) throw stateConflict('goal completion requires a safe-point permit');
            nextPermit = false;
          }
          if (!context.authorizationRevision || !modelStarted)
            throw stateConflict('goal completion requires delegated model execution');
          if (
            request.usage.iterations !== cumulative.iterations ||
            request.usage.tokens !== cumulative.tokens
          )
            throw stateConflict('goal usage must match accepted model steps');
          if (
            request.usage.iterations > context.maxIterations ||
            (request.usage.tokens !== null && request.usage.tokens > context.maxTokens)
          )
            throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
          const result = await guarded(async (client) => {
            let goal;
            try {
              goal = await validateGoalResult(client, toolContext(context), request.goal_result);
            } catch (error) {
              if (error instanceof HttpError && error.errorCode === 'STATE_CONFLICT')
                return {
                  accepted: false as const,
                  code: 'INVALID_GOAL_RESULT',
                  message: error.message,
                };
              throw error;
            }
            const event = await commitTerminal(
              client,
              context,
              goal.status === 'cancelled' ? 'cancelled' : 'done',
              {
                ...eventPayload(context),
                ...(goal.status === 'cancelled'
                  ? { reason: 'harness_cancelled' }
                  : { approval_id: null }),
                goal_result: goal,
              },
            );
            return { accepted: true as const, event };
          });
          if (!result.accepted) {
            correctingGoal = true;
            return result;
          }
          stopped = true;
          await send(result.event);
          return { accepted: true };
        }
        if (request.type !== 'finish') throw stateConflict('unsupported terminal control');
        if (
          !context.compactControl &&
          (context.executionProfile === 'pause/1' ||
            context.executionProfile === 'pause-memory/1' ||
            context.executionProfile === 'compact-memory/1') &&
          request.outcome === 'done' &&
          routingDecision?.payload.decision !== 'direct'
        ) {
          if (!nextPermit) throw stateConflict('completion requires a safe-point permit');
          nextPermit = false;
        }
        if (
          context.authorizationRevision &&
          request.outcome === 'done' &&
          routingDecision?.payload.decision !== 'direct'
        )
          throw stateConflict('delegated goal requires finish_goal');
        if (
          modelStarted &&
          (request.usage.iterations !== cumulative.iterations ||
            request.usage.tokens !== cumulative.tokens)
        )
          throw stateConflict('terminal usage must match accepted model steps');
        const event = await guarded(async (client) => {
          const previous = (
            await client.query<{ payload: unknown }>(
              `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
          WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq DESC LIMIT 1`,
              [context.runId],
            )
          ).rows[0];
          const baseline = previous
            ? context.executionProfile === 'compact-memory/1'
              ? HarnessR3SnapshotSchema.parse(previous.payload)
              : HistoricalHarnessSnapshotSchema.parse(previous.payload)
            : lastSnapshot;
          if (
            baseline &&
            (request.usage.iterations < baseline.usage.iterations ||
              (baseline.usage.tokens !== null &&
                request.usage.tokens !== null &&
                request.usage.tokens < baseline.usage.tokens) ||
              (baseline.usage.iterations > 0 &&
                baseline.usage.tokens === null &&
                request.usage.tokens !== null))
          )
            throw stateConflict('terminal usage cannot move backwards');
          if (request.outcome === 'done') {
            if (routingDecision?.payload.decision === 'direct') {
              const render = await readRoutingRecord<RoutingRenderPayload>(
                client,
                context,
                'harness_routing_render',
              );
              if (
                modelStarted ||
                cumulative.iterations !== 0 ||
                cumulative.tokens !== 0 ||
                request.usage.iterations !== 0 ||
                request.usage.tokens !== 0 ||
                !render ||
                render.payload.decision_ref !== routingDecision.id
              )
                throw stateConflict(
                  'routing completion requires accepted render receipt and zero model usage',
                );
              await directInvocation(client, render.payload.invocation_ref);
              const accepted = await readRunInvocationStates(client, toolContext(context));
              if (
                accepted.length !== 1 ||
                accepted[0]?.state !== 'completed' ||
                accepted[0].outcome_kind !== 'success'
              )
                throw stateConflict(
                  'routing completion requires unique successful accepted result',
                );
            }
            if (
              initial.approval?.kind === 'document' &&
              !approvalAuthorizesActions(initial.approval)
            )
              throw forbidden('rejected approval cannot complete the original action');
            if (
              request.usage.iterations > context.maxIterations ||
              (request.usage.tokens !== null && request.usage.tokens > context.maxTokens)
            )
              throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
            const states = await readRunInvocationStates(client, toolContext(context));
            for (const row of states) {
              if (row.state !== 'completed' || row.outcome_kind === 'failed')
                throw stateConflict('Run has unresolved tool effects');
              if (
                row.outcome_kind === 'approval_pending' &&
                row.approval_id &&
                (await readRunApprovalDecision(client, context, row.invocation_id, row.approval_id))
                  .status === 'pending'
              )
                throw stateConflict('Run has unresolved approval');
              if (
                row.outcome_kind === 'approval_pending' &&
                !initial.snapshot?.tool_refs.includes(row.invocation_id)
              )
                throw stateConflict('approval requires explicit suspension and resume');
            }
            await validateDocumentApprovalsDone(
              client,
              context,
              await readRunDocumentEvidence(client, context),
            );
            if (
              !modelStarted &&
              cumulative.iterations === 0 &&
              routingDecision?.payload.decision !== 'direct'
            )
              throw stateConflict('zero-model completion requires accepted routing render receipt');
          }
          let goalResult;
          if (request.outcome === 'done' && context.authorizationRevision) {
            const render = await readRoutingRecord<RoutingRenderPayload>(
              client,
              context,
              'harness_routing_render',
            );
            if (!render) throw stateConflict('routing render missing');
            const deltas = await client.query<{ delta: string }>(
              `SELECT c.payload->'payload'->>'delta' AS delta FROM run_checkpoints c
               JOIN run_attempts a ON a.id=c.attempt_id
               WHERE a.run_id=$1 AND c.kind='message.delta' ORDER BY c.event_seq`,
              [context.runId],
            );
            const answer = deltas.rows.map((row) => row.delta).join('');
            if (routingHash(answer) !== render.payload.body_sha256)
              throw stateConflict('routing answer differs from accepted render');
            goalResult = await validateGoalResult(client, toolContext(context), {
              status: 'completed',
              outcomes: [
                {
                  description: '完成本次有限只读查询',
                  status: 'achieved',
                  receipt_refs: [render.payload.invocation_ref],
                },
              ],
              clarification: null,
              answer,
            });
          }
          const payload =
            request.outcome === 'done'
              ? {
                  ...eventPayload(context),
                  approval_id: null,
                  ...(goalResult ? { goal_result: goalResult } : {}),
                }
              : request.outcome === 'cancelled'
                ? { ...eventPayload(context), reason: 'harness_cancelled' }
                : {
                    ...eventPayload(context),
                    error: {
                      code: request.error?.code ?? 'HARNESS_EXITED',
                      message: request.error?.message ?? '原生执行失败。',
                      http_status: request.error?.code === 'BUDGET_EXCEEDED' ? 429 : 500,
                    },
                  };
          return commitTerminal(client, context, request.outcome, payload);
        });
        stopped = true;
        await send(event);
        return { accepted: true };
      } catch (error) {
        if (
          suppliedRequest.type === 'route_probe' ||
          suppliedRequest.type === 'route_decide' ||
          suppliedRequest.type === 'render_route_result' ||
          routingDecision?.payload.decision === 'direct'
        ) {
          stopped = true;
          sessionController.abort();
        }
        throw error;
      }
    },
  };
}

export async function executeHarness(
  deps: ConversationDeps,
  context: RunContext,
  write: EventWriter,
  signal?: AbortSignal,
  interruption?: AbortSignal,
): Promise<void> {
  const pool = poolOf(deps);
  if (!deps.harness) throw unavailable();
  const controller = new AbortController();
  const ownershipLost = () => controller.abort();
  context.ownership?.signal.addEventListener('abort', ownershipLost, { once: true });
  interruption?.addEventListener('abort', ownershipLost, { once: true });
  if (context.ownership?.signal.aborted || interruption?.aborted) controller.abort();
  active.set(context.runId, controller);
  let cancellation: Promise<unknown> | undefined;
  let cancellationFailure: { error: unknown } | undefined;
  let cancellationProjected = false;
  let closeSession: (() => Promise<void>) | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const disconnected = () => {
    cancellation ??= cancelConversationRun(
      deps,
      context.ownerId,
      context.conversationId,
      context.runId,
      context.requestId,
      { idempotency_key: randomUUID(), reason: 'client_disconnected' },
    ).catch((error: unknown) => {
      cancellationFailure = { error };
    });
  };
  signal?.addEventListener('abort', disconnected, { once: true });
  try {
    if (signal?.aborted) {
      disconnected();
      await cancellation;
      return;
    }
    const session = await createHarnessSession(
      deps,
      context,
      async (event) => {
        const open = await write(event);
        if (open && event.type === 'thread.cancelled') cancellationProjected = true;
        if (!open) {
          disconnected();
          await cancellation;
        }
        return open;
      },
      controller.signal,
    );
    closeSession = session.close;
    if (session.start.snapshot === null) {
      const event = await withRunTransaction(pool, context.ownership, async (client) => {
        await lockRun(client, context);
        return appendEvent(client, context, 'thread.started', {
          ...eventPayload(context),
          stream_protocol_version: THREAD_PROTOCOL_VERSION,
          ruleset_id: context.timeContext.ruleset_id,
          tzdb_version: context.timeContext.tzdb_version,
        });
      });
      if (!(await write(event))) {
        disconnected();
        await cancellation;
        return;
      }
    }
    await runNativeHarness({
      services: deps.harness,
      start: session.start,
      signal: controller.signal,
      detachOnAbort: !!context.ownership,
      onExit: session.close,
      handleRequest: (request) => {
        const pending = (async () => {
          // No next native action may overtake a disconnect's durable decision.
          await cancellation;
          if (cancellationFailure) throw cancellationFailure.error;
          return session.handleRequest(request);
        })();
        if (context.ownership) {
          inFlight.add(pending);
          void pending.then(
            () => inFlight.delete(pending),
            () => inFlight.delete(pending),
          );
        }
        return pending;
      },
    });
    // An external revocation stops the native process without throwing. Still
    // account for a disabled owner's running attempt while ownership is held;
    // a committed cancellation already wins the terminal-state check.
    if (interruption?.aborted) throw new Error('server-owned execution interrupted');
  } catch (error) {
    await cancellation;
    try {
      const failed = await withRunTransaction(pool, context.ownership, async (client) => {
        // Revocation rejects execution, but may not prevent recording its failure.
        await lockRun(client, context, true, false);
        const code = error instanceof HttpError ? error.errorCode : 'INTERNAL_ERROR';
        return commitTerminal(client, context, 'failed', {
          ...eventPayload(context),
          error: {
            code,
            message: error instanceof HttpError ? error.message : '原生执行失败。',
            http_status: error instanceof HttpError ? error.httpStatus : 500,
          },
        });
      });
      // Durable accounting does not authorize disclosure to the old connection.
      // Reuse the ordinary owner/Run read gate after the terminal commit.
      await withTransaction(pool, (client) => lockRun(client, context, false));
      await write(failed);
    } catch {
      // Stale/terminal authority wins; revoked readers receive no failure content.
    }
  } finally {
    try {
      await closeSession?.();
      signal?.removeEventListener('abort', disconnected);
      context.ownership?.signal.removeEventListener('abort', ownershipLost);
      interruption?.removeEventListener('abort', ownershipLost);
      if (active.get(context.runId) === controller) active.delete(context.runId);
      // Project the committed stop before waiting for already-dispatched effects.
      if (controller.signal.aborted && !signal?.aborted && !cancellationProjected) {
        const events = await listRunEvents(pool, context.ownerId, context.runId);
        const cancelled = events.find((event) => event.type === 'thread.cancelled');
        if (cancelled) await write(cancelled);
      }
    } finally {
      // Keep the execution slot and control pool alive through late accounting.
      await Promise.allSettled(inFlight);
    }
  }
}
