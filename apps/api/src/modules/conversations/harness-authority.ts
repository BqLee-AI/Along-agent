import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ZodError } from 'zod';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_MAX_FRAME_BYTES,
  HarnessSnapshotSchema,
  HistoricalHarnessSnapshotSchema,
  HarnessStartSchema,
  HarnessModelStepSchema,
  HarnessRequestSchema,
  workspaceGrantSchema,
  type HarnessModelStep,
  type HarnessRequest,
  type HarnessSnapshot,
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
import { HARNESS_TOOL_DEFINITIONS, DELEGATION_TOOL_DEFINITIONS } from '../tools/catalog.js';
import { GOAL_CONTROL_TOOL } from './goal-control.js';
import { validateGoalResult } from './goal-result.js';
import { validateWorkspaceGrant } from '../workspaces/service.js';
import { runNativeHarness } from './harness-process.js';
import type { ConversationDeps, EventWriter, RunContext, StartResult } from './contracts.js';
import { ensureRunContextPolicy, readRunContextPolicy } from './context-policy.js';
import { measureHarnessContext } from './harness-context.js';
import { CancelRunBodySchema, ResumeRunBodySchema } from './schemas.js';
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

export interface HarnessSession {
  start: HarnessStart;
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
  candidatePolicy?: { tableExists: boolean },
): Promise<RunContext> {
  const frozen = run.frozen_context;
  if (!frozen || !run.input_message_id) throw stateConflict('Run accepted input missing');
  const message = (
    await client.query<{ content: string }>(
      `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
      [run.input_message_id, run.owner_id, run.conversation_id],
    )
  ).rows[0];
  if (!message) throw stateConflict('Run accepted message missing');
  if (
    deps.timeContext.ruleset_id !== frozen.rulesetId ||
    deps.timeContext.tzdb_version !== frozen.tzdbVersion ||
    (frozen.aliasVersion !== null &&
      (!deps.timeContext.available || deps.timeContext.aliases.version !== frozen.aliasVersion))
  )
    throw new HttpError(503, 503, 'TZDB_UNAVAILABLE', '接纳时的时间规则暂不可用。');
  if (frozen.workspaceGrant) validateWorkspaceGrant(run.owner_id, frozen.workspaceGrant);
  const contextPolicy = candidatePolicy
    ? ((candidatePolicy.tableExists
        ? await readRunContextPolicy(client, run.owner_id, run.id)
        : null) ?? deps.harness?.contextPolicy)
    : await readRunContextPolicy(client, run.owner_id, run.id);
  const deployed = deps.harness?.contextPolicy;
  if (
    !contextPolicy ||
    !deployed ||
    contextPolicy.model_binding.model !== deployed.model_binding.model ||
    contextPolicy.model_binding.adapter_revision !== deployed.model_binding.adapter_revision
  )
    throw unavailable();
  if (!supportsFrozenTools(run)) throw stateConflict('unsupported frozen tool in historical Run');
  const messageRefs = frozen.messageRefs ?? [run.input_message_id];
  const messages = await readHarnessMessages(
    client,
    {
      ownerId: run.owner_id,
      conversationId: run.conversation_id,
      userMessageId: run.input_message_id,
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
    inputText: message.content,
    confirmedTimezone: frozen.confirmedTimezone,
    anchorReceivedAtUtc: frozen.anchorReceivedAtUtc,
    receivedAtUtc: frozen.receivedAtUtc,
    foldChoice: frozen.foldChoice,
    timeContext: deps.timeContext,
    maxIterations: run.budget_max_iterations,
    maxTokens: run.budget_max_tokens,
    allowlist: run.tools_allowlist,
    ...(frozen.workspaceGrant ? { workspaceGrant: frozen.workspaceGrant } : {}),
    ...(frozen.workspaceGrants ? { workspaceGrants: frozen.workspaceGrants } : {}),
    ...(frozen.authorization_revision
      ? {
          authorizationRevision: frozen.authorization_revision,
          trustedExecutionContext: frozen.trustedExecutionContext,
        }
      : {}),
    messageRefs,
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

function buildHarnessStart(
  context: RunContext,
  snapshot: HarnessSnapshot | null,
  observations: HarnessStart['observations'],
  approval: HarnessApprovalDecision | null,
  routingPolicy: RoutingPolicy | null = null,
  eligiblePhase: HarnessStart['eligible_phase'] = 'disabled',
): HarnessStart {
  if (!context.contextPolicy || !context.messages) throw unavailable();
  if (
    snapshot &&
    (snapshot.message_refs.length !== context.messages.length ||
      snapshot.message_refs.some((id, index) => id !== context.messages![index]?.message_id))
  )
    throw stateConflict('snapshot message reference conflict');
  const start: HarnessStart = {
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'start',
    trusted_context: context.trustedExecutionContext ?? null,
    messages: context.messages,
    context_policy: context.contextPolicy,
    routing_policy: routingPolicy,
    eligible_phase: eligiblePhase,
    tools: (context.authorizationRevision
      ? DELEGATION_TOOL_DEFINITIONS.map((tool) =>
          tool.name === 'list_tasks' &&
          !(context.allowlist.includes('get_task') && context.allowlist.includes('cancel_reminder'))
            ? HARNESS_TOOL_DEFINITIONS.find((legacy) => legacy.name === 'list_tasks')!
            : tool,
        )
      : HARNESS_TOOL_DEFINITIONS
    ).filter((tool) => context.allowlist.includes(tool.name)),
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
    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('run_context_policies') IS NOT NULL AS present",
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
          { tableExists: table.rows[0]!.present },
        );
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
  return withLatest(deps, ownerId, conversationId, runId, viewOf);
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
      if (locked.run.status === 'running' || locked.run.status === 'suspended_approval') {
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
      return viewOf(client, locked);
    },
    false,
  );
  // Qualification has already been revoked durably before model/pipe abort.
  if (result.status === 'cancelled') active.get(runId)?.abort();
  if (result.status === 'cancelled')
    for (const controller of sessionAborts.get(runId) ?? []) controller.abort();
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
        await ensureRunContextPolicy(client, ownerId, runId, deps.harness.contextPolicy);
        const context = await contextOf(
          client,
          deps,
          run,
          attemptId,
          requestId,
          input.checkpoint_id,
        );
        if (ownership) context.ownership = ownership;
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
    const context = await contextOf(
      client,
      deps,
      locked.run,
      supplied.attemptId,
      supplied.requestId,
      resume?.checkpoint_id,
    );
    if (supplied.ownership) context.ownership = supplied.ownership;
    const snapshot = resume ? await readSnapshot(client, locked.run, resume.checkpoint_id) : null;
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
      locked.attempt.attempt_no === 1 &&
      !resume &&
      !snapshot &&
      !decision &&
      !states.length &&
      !checkpoint.rowCount &&
      policy?.payload.policy.mode !== 'off' &&
      policy !== null;
    return { context, snapshot, observations, approval, policy, eligible, decision };
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
  let correctingGoal = false;
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
  let modelStarted = false;
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
  async function validateSnapshot(client: PoolClient, snapshot: HarnessSnapshot): Promise<void> {
    if (
      modelStarted &&
      (snapshot.usage.iterations !== cumulative.iterations ||
        snapshot.usage.tokens !== cumulative.tokens)
    )
      throw stateConflict('snapshot usage must match accepted model steps');
    const frozenRefs = context.messageRefs ?? [context.userMessageId];
    if (
      snapshot.message_refs.length !== frozenRefs.length ||
      snapshot.message_refs.some((ref, index) => ref !== frozenRefs[index])
    )
      throw stateConflict('snapshot message reference conflict');
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
      ? HistoricalHarnessSnapshotSchema.parse(previous.payload)
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
        await guarded(async () => undefined);
        if (modelStream && request.type === 'finish' && request.outcome !== 'done')
          await closeModel();
        if (modelStream && request.type !== 'model_next' && request.type !== 'answer')
          throw stateConflict('model stream must complete before another action');
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
                    messageId: context.userMessageId,
                    text: context.inputText,
                    messages: context.messages!.map(({ role, content }) => ({ role, content })),
                    hasPendingApproval,
                    workspaceSelected: !!context.workspaceGrant,
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
          if (!approvalAuthorizesActions(initial.approval))
            throw forbidden('rejected approval cannot authorize another action');
          if (!deps.harness || !context.contextPolicy) throw unavailable();
          const remaining =
            cumulative.tokens === null ? null : Math.max(0, context.maxTokens - cumulative.tokens);
          if (request.remaining_tokens !== remaining)
            throw stateConflict('model balance must match accepted cumulative usage');
          if (cumulative.iterations >= context.maxIterations)
            throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
          const measurement = (deps.harness.measure ?? measureHarnessContext)(
            { ...request, type: 'measure_context' },
            tools,
            context.contextPolicy,
          );
          if (request.type === 'measure_context') return measurement;
          if (measurement.limit_reason || request.max_output_tokens > measurement.output_ceiling) {
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
          await guarded(async (client) => {
            await assertActionAuthority(client);
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
          });
          modelStream = {
            ref: request.request_ref,
            iterator: deps.harness.model(request, tools, modelSignal)[Symbol.asyncIterator](),
            pendingDelta: null,
            pulling: false,
          };
          modelStarted = true;
          return nextModelStep();
        }
        if (request.type === 'reserve') {
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
          const reserved = await reserveToolInvocation(
            pool,
            { ...toolContext(context), signal: sessionSignal },
            {
              callKey: request.call_key,
              toolId: request.tool_id,
              args: request.args,
            },
          );
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
          const snapshot = HarnessSnapshotSchema.parse(request.context);
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
                HARNESS_PROTOCOL_VERSION,
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
            ? HistoricalHarnessSnapshotSchema.parse(previous.payload)
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
): Promise<void> {
  const pool = poolOf(deps);
  if (!deps.harness) throw unavailable();
  const controller = new AbortController();
  const ownershipLost = () => controller.abort();
  context.ownership?.signal.addEventListener('abort', ownershipLost, { once: true });
  if (context.ownership?.signal.aborted) controller.abort();
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
