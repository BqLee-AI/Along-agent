// Admission owns the complete transaction and execution bindings for new runs.
import {
  listReminderClarifications,
  readReminderTimeErrors,
} from '../tools/reminders/reminder-source.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { TrustedExecutionContextSchema, type ExecutionKind } from '@along/contracts';
import type { ConversationDeps, RunContext, StartResult } from '../runtime/contracts.js';
import { buildHarnessStart } from '../runtime/context.js';
import {
  freezeR3Context,
  freezeR3ControlContext,
  readCompactView,
  lockIdleCompactRequest,
  saveIdleCompactRequest,
  type IdleCompactReceipt,
  AutoCompactPolicySchema,
  createAutoCompactPolicy,
  SendMessageBodySchema,
  type SendMessageBody,
  createConversation,
  deleteExpiredIdempotency,
  findIdempotency,
  freezeConversationTimezone,
  getConversation,
  insertAttempt,
  insertIdempotency,
  insertMessage,
  insertRun,
  listHarnessMessageRefs,
  listRunEvents,
  lockRun,
  type ConversationRow,
  acceptReminderDate,
  CANCEL_INTENT,
  requirePool,
} from '../../features/conversations/public.js';
import { commitTerminal } from './finish.js';
import {
  BUSINESS_TOOL_IDS,
  HARNESS_BASE_TOOL_IDS,
  R3_MEMORY_TOOL_IDS,
  R3_MEMORY_SOURCE_TOOL_ID,
  DELEGATION_TOOL_IDS,
  DELEGATION_WORKSPACE_READ_TOOL_IDS,
  DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
  DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
  TOOL_IDS,
} from '../tools/contracts.js';
import {
  getWorkspaceGrant,
  resolveWorkspaceGrants,
  validateWorkspaceGrant,
} from '../../features/workspaces/public.js';
import { findReminderDirective } from '@along/time-core';
import { requireTimeContext } from '../../features/time/public.js';
import { withTransaction } from '../../db/transaction.js';
import {
  forbidden,
  notFound,
  stateConflict,
  validationError,
  ApplicationError,
} from '../../platform/errors.js';
import { ensureRunContextPolicy } from '../../features/conversations/public.js';
import { insertRoutingPolicy } from '../routing/routing-checkpoints.js';
import { routingRuntimeOf } from '../runtime/config.js';
import { acceptTargetContinuation } from './target-continuation.js';
import {
  isActiveOwner,
  lockViewerAccess,
  readUserPreferences,
} from '../../features/identity/public.js';
import { withRunTransaction, type RunOwnership } from '../runtime/run-ownership.js';
import {
  resolveSelection,
  bindRunSelection,
  lockOwner,
} from '../../features/model-providers/public.js';
import {
  freezeFeishuBotDocxGrant,
  loadFeishuBotDocxConfiguration,
  readFeishuBotObservationKey,
  suppliedFeishuDocxUrl,
} from '../../features/office-connectors/public.js';

const AGENT_REVISION = 'assistant/r1';
const BUSINESS_MAX_ITERATIONS = 10;
const BUSINESS_MAX_TOKENS = 8000;

// time-core's pure parser accepts second precision only (no milliseconds).
function utcSecondIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pgErrorOf(err: unknown): { code?: string; constraint?: string } | null {
  if (!err || typeof err !== 'object') return null;
  const code = 'code' in err ? err.code : undefined;
  const constraint = 'constraint' in err ? err.constraint : undefined;
  return {
    code: typeof code === 'string' ? code : undefined,
    constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

function requestHashOf(input: {
  conversationId: string | undefined;
  text: string;
  timezone: string | null;
  fold: string;
  execution: ExecutionKind;
  workspaceId?: string;
  workspaceIds?: string[];
  clarificationOfRunId?: string;
  authorizationRevision?: 'delegation/1';
  modelSelection?: { provider_id: string; model_id: string };
}): string {
  const material: unknown[] = [
    input.conversationId ?? null,
    input.text,
    input.timezone,
    input.fold,
  ];
  if (input.workspaceId !== undefined) material.push(input.workspaceId);
  if (input.workspaceIds !== undefined) material.push([...input.workspaceIds].sort());
  if (input.clarificationOfRunId !== undefined) material.push(input.clarificationOfRunId);
  if (input.authorizationRevision) material.push(input.authorizationRevision);
  if (input.modelSelection !== undefined)
    material.push({
      model_selection: [input.modelSelection.provider_id, input.modelSelection.model_id],
    });
  const canonical = JSON.stringify(material);
  return createHash('sha256')
    .update(
      input.workspaceIds !== undefined
        ? 'harness/workspace-set/v1\0'
        : input.workspaceId !== undefined
          ? 'harness/workspace/v2\0'
          : input.execution === 'harness'
            ? 'harness/v1\0'
            : '',
    )
    .update(canonical, 'utf8')
    .digest('hex');
}

function textOf(body: SendMessageBody): string {
  if (!body.raw_text) throw validationError('raw_text is required');
  return body.raw_text;
}

/** Admit an explicit idle compact command; no ordinary message is created.
 * The durable receipt and every execution binding commit in one transaction. */
export async function startIdleCompact(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  requestId: string,
  key: string,
): Promise<
  { status: 'no_content'; runId: null } | { status: 'accepted'; runId: string; pauseId: string }
> {
  const pool = requirePool(deps);
  const receiptWithPause = async (receipt: IdleCompactReceipt) => {
    if (receipt.status === 'no_content') return receipt;
    const row = (
      await pool.query<{ id: string }>(
        `SELECT p.id FROM harness_pauses p JOIN run_attempts a ON a.id=p.attempt_id
       WHERE p.owner_id=$1 AND p.conversation_id=$2 AND p.run_id=$3
         AND p.reason='runtime' AND p.purpose='manual_compact' AND a.attempt_no=1`,
        [ownerId, conversationId, receipt.runId],
      )
    ).rows[0];
    if (!row) throw stateConflict('control pause unavailable');
    return { ...receipt, pauseId: row.id };
  };
  const runId = randomUUID();
  const inspect = async (client: PoolClient) => {
    const prior = await lockIdleCompactRequest(client, ownerId, conversationId, key);
    if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
      throw forbidden('owner authorization revoked');
    if (prior) return prior;
    await lockOwner(client, ownerId);
    const conversation = (
      await client.query<{ id: string }>(
        "SELECT id FROM conversations WHERE id=$1 AND owner_id=$2 AND status='open' FOR UPDATE",
        [conversationId, ownerId],
      )
    ).rows[0];
    if (!conversation) throw notFound('conversation unavailable');
    const active = await client.query(
      "SELECT 1 FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND status IN ('running','paused','suspended_approval') LIMIT 1",
      [ownerId, conversationId],
    );
    if (active.rowCount) throw stateConflict('conversation has an active Run');
    const view = await readCompactView(client, ownerId, conversationId);
    if (!view.uncoveredIds.length)
      return saveIdleCompactRequest(client, ownerId, conversationId, key, null);
    return null;
  };

  const initial = await withTransaction(pool, inspect);
  if (initial) return receiptWithPause(initial);
  if (!deps.runDriver || !deps.harness || !deps.modelTransport)
    throw new ApplicationError(503, 'HARNESS_UNAVAILABLE', '原生 Agent 暂不可用。');
  let ownership: RunOwnership;
  try {
    ownership = await deps.runDriver.acquire(runId);
  } catch (error) {
    const replay = await withTransaction(pool, async (client) => {
      const prior = await lockIdleCompactRequest(client, ownerId, conversationId, key);
      if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
        throw forbidden('owner authorization revoked');
      return prior;
    });
    if (replay) return receiptWithPause(replay);
    throw error;
  }
  let admitted: { receipt: IdleCompactReceipt; context: RunContext | null };
  try {
    admitted = await withRunTransaction(pool, ownership, async (client) => {
      const prior = await inspect(client);
      if (prior) return { receipt: prior, context: null };
      await ownership.assert(client, runId);
      const attemptId = randomUUID(),
        pauseId = randomUUID();
      const clock = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
        ?.now;
      if (!clock) throw new Error('database clock unavailable');
      const receivedAtUtc = utcSecondIso(clock);
      const maxIterations = deps.harness!.maxIterations,
        maxTokens = deps.harness!.maxTokens;
      const compactCompletionCap =
        deps.harness!.compactCompletionCap ?? deps.harness!.contextPolicy.completion_cap;
      const frozenContext = {
        execution_profile: 'compact-memory/1',
        execution_lifecycle: 'server-owned',
        compactControl: true,
        compactCompletionCap,
        confirmedTimezone: null,
        anchorReceivedAtUtc: receivedAtUtc,
        receivedAtUtc,
        foldChoice: 'none',
        rulesetId: deps.timeContext.ruleset_id,
        tzdbVersion: deps.timeContext.tzdb_version,
        aliasVersion: deps.timeContext.available ? deps.timeContext.aliases.version : null,
      };
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
         VALUES($1,$2,$3,$4,'chat','running',$5,$6,'harness','[]'::jsonb,$7::jsonb,NULL)`,
        [
          runId,
          ownerId,
          conversationId,
          AGENT_REVISION,
          maxIterations,
          maxTokens,
          JSON.stringify(frozenContext),
        ],
      );
      const r3Context = await freezeR3ControlContext(client, { ownerId, conversationId, runId });
      const selected = await resolveSelection(client, ownerId);
      await bindRunSelection(client, ownerId, runId, selected);
      const contextPolicy = await ensureRunContextPolicy(client, ownerId, runId, {
        ...deps.harness!.contextPolicy,
        model_binding: { ...deps.harness!.contextPolicy.model_binding, model: selected.model_id },
      });
      await insertAttempt(client, {
        attemptId,
        ownerId,
        runId,
        attemptNo: 1,
        leaseToken: ownership.token,
      });
      await client.query(
        `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
         VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','pending')`,
        [pauseId, ownerId, conversationId, runId, attemptId, randomUUID()],
      );
      await client.query(
        `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status)
         VALUES($1,$2,$3,$4,$5,'pending')`,
        [pauseId, ownerId, conversationId, runId, attemptId],
      );
      const context: RunContext = {
        ownerId,
        conversationId,
        runId,
        attemptId,
        requestId,
        ownership,
        inputText: '',
        userMessageId: null,
        compactControl: true,
        confirmedTimezone: null,
        anchorReceivedAtUtc: receivedAtUtc,
        receivedAtUtc,
        foldChoice: 'none',
        maxIterations,
        maxTokens,
        execution: 'harness',
        executionProfile: 'compact-memory/1',
        allowlist: [],
        r3Context,
        messages: r3Context.messages,
        contextPolicy,
        compactCompletionCap,
        timeContext: deps.timeContext,
      };
      buildHarnessStart(context, null, [], null);
      const receipt = await saveIdleCompactRequest(client, ownerId, conversationId, key, runId);
      return { receipt, context };
    });
  } catch (error) {
    await deps.runDriver.release(ownership);
    throw error;
  }
  if (!admitted.context) {
    await deps.runDriver.release(ownership);
    return receiptWithPause(admitted.receipt);
  }
  try {
    deps.runDriver.start(deps, admitted.context);
  } catch {
    try {
      await ownership.transaction(async (client) => {
        const locked = await lockRun(client, admitted.context!, false, false);
        await ownership.assert(client, runId, admitted.context!.attemptId);
        if (locked.run.status !== 'running' || locked.attempt.status !== 'running') return;
        await client.query(
          "UPDATE run_attempts SET status='fenced_out',ended_at=now() WHERE id=$1",
          [admitted.context!.attemptId],
        );
        await client.query(
          "UPDATE compact_operations SET status='failed',error_code='HARNESS_UNAVAILABLE',updated_at=now() WHERE owner_id=$1 AND run_id=$2 AND status='pending'",
          [ownerId, runId],
        );
        await commitTerminal(
          client,
          admitted.context!,
          'failed',
          {
            conversation_id: conversationId,
            run_id: runId,
            error: { code: 'HARNESS_UNAVAILABLE', message: '服务端执行中断。', http_status: 503 },
          },
          { preserveAttemptStatus: true },
        );
      });
    } finally {
      await deps.runDriver.release(ownership);
    }
    return receiptWithPause(admitted.receipt);
  }
  return receiptWithPause(admitted.receipt);
}

// Runs before any SSE byte is written, so validation/idempotency failures can
// still use the JSON envelope.
export async function startConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  requestId: string,
  body: unknown,
  idempotencyKeyHeader: string | null,
  sessionId: string | null = null,
): Promise<StartResult> {
  const parsed = SendMessageBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid message body');
  const input = parsed.data;
  const execution = input.execution ?? 'business';
  const text = textOf(input);
  const timezone = input.confirmed_timezone_id ?? input.confirmed_timezone ?? null;
  const key = idempotencyKeyHeader ?? input.idempotency_key ?? requestId;
  const requestHash = requestHashOf({
    conversationId: input.conversation_id,
    text,
    timezone,
    fold: input.fold_choice,
    execution,
    ...(input.model_selection !== undefined ? { modelSelection: input.model_selection } : {}),
    ...(input.authorization_revision
      ? { authorizationRevision: input.authorization_revision }
      : {}),
    ...(input.workspace_id !== undefined ? { workspaceId: input.workspace_id } : {}),
    ...(input.workspace_ids !== undefined ? { workspaceIds: input.workspace_ids } : {}),
    ...(input.clarification_of_run_id
      ? { clarificationOfRunId: input.clarification_of_run_id }
      : {}),
  });
  const pool = requirePool(deps);
  const candidateRunId = randomUUID();
  const serverOwnedEligible =
    execution === 'harness' && input.authorization_revision === 'delegation/1' && !!deps.runDriver;
  let ownership: RunOwnership | undefined;
  if (serverOwnedEligible && !(await findIdempotency(pool, ownerId, key))) {
    try {
      ownership = await deps.runDriver!.acquire(candidateRunId);
    } catch (error) {
      // A duplicate may have committed while capacity was being acquired.
      if (!(await findIdempotency(pool, ownerId, key))) throw error;
    }
  }

  let started: {
    conversationId: string;
    runId: string;
    replayRunId: string | null;
    context: RunContext | null;
  };
  try {
    started = await withRunTransaction(pool, ownership, async (client: PoolClient) => {
      if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
        throw forbidden('owner authorization revoked');
      // Serialize the owner/key before selection resolution so a concurrent
      // replay never observes a changed or deleted default before the winner.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify([ownerId, key]),
      ]);
      const existing = await findIdempotency(client, ownerId, key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw stateConflict('idempotency key reused with a different body') as ApplicationError;
        }
        return {
          conversationId: existing.conversation_id,
          runId: existing.run_id,
          replayRunId: existing.run_id,
          context: null,
        };
      }
      if (serverOwnedEligible && !ownership)
        throw stateConflict('server-owned execution capacity unavailable');
      if (ownership) await ownership.assert(client, candidateRunId);
      if (execution === 'harness' && !deps.harness)
        throw new ApplicationError(503, 'HARNESS_UNAVAILABLE', '原生 Agent 暂不可用。');
      // Model selection and idle control admission share owner -> conversation
      // lock order; resolveSelection reuses this transaction-scoped lock.
      if (execution === 'harness') await lockOwner(client, ownerId);
      const workspaceGrant =
        input.workspace_id !== undefined ? getWorkspaceGrant(ownerId, input.workspace_id) : null;
      const workspaceSummary = workspaceGrant
        ? validateWorkspaceGrant(ownerId, workspaceGrant)
        : null;
      const delegation = input.authorization_revision === 'delegation/1';
      let workspaceSet = delegation
        ? resolveWorkspaceGrants(ownerId, input.workspace_ids)
        : { grants: [], summaries: [] };
      let allowlist: readonly string[] =
        execution === 'harness'
          ? workspaceGrant
            ? TOOL_IDS
            : delegation
              ? [
                  ...DELEGATION_TOOL_IDS,
                  ...(workspaceSet.grants.length ? DELEGATION_WORKSPACE_READ_TOOL_IDS : []),
                  ...(workspaceSet.summaries.some((summary) => summary.writable_paths.length)
                    ? DELEGATION_WORKSPACE_WRITE_TOOL_IDS
                    : []),
                  ...(workspaceSet.grants.some((grant) => grant.output_directories?.length)
                    ? DELEGATION_WORKSPACE_CREATE_TOOL_IDS
                    : []),
                ]
              : HARNESS_BASE_TOOL_IDS
          : BUSINESS_TOOL_IDS;

      let conversation: ConversationRow | null = null;
      if (input.conversation_id) {
        const found = await getConversation(client, input.conversation_id);
        if (!found) throw notFound('conversation not found') as ApplicationError;
        if (found.owner_id !== ownerId)
          throw forbidden('conversation not found') as ApplicationError;
        if (found.status !== 'open') throw stateConflict('conversation closed') as ApplicationError;
        conversation = found;
      }
      const acceptedClock = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
        .rows[0]?.now;
      if (!acceptedClock) throw new Error('database clock unavailable');
      const receivedAtUtc = utcSecondIso(acceptedClock);
      if (!conversation) {
        const anchorIso = acceptedClock;
        conversation = await createConversation(client, {
          ownerId,
          anchorIso: utcSecondIso(anchorIso),
          title: text.slice(0, 40),
        });
      }
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversation.id]);
      const paused = await client.query(
        "SELECT 1 FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND status='paused' LIMIT 1",
        [ownerId, conversation.id],
      );
      if (paused.rowCount) throw stateConflict('conversation has a paused Run');

      const preferences = delegation ? await readUserPreferences(client, ownerId) : null;
      let confirmedTimezone = delegation
        ? (timezone ?? preferences?.timezone_id ?? null)
        : (timezone ?? conversation.confirmed_timezone_id);
      if (!delegation && !conversation.confirmed_timezone_id && timezone) {
        await freezeConversationTimezone(client, conversation.id, timezone);
        confirmedTimezone = timezone;
      }

      const userMessageId = await insertMessage(client, {
        ownerId,
        conversationId: conversation.id,
        role: 'user',
        content: text,
        requestId,
      });
      let targetContinuation =
        delegation &&
        execution === 'harness' &&
        input.clarification_of_run_id &&
        (allowlist as readonly string[]).includes('get_task') &&
        (allowlist as readonly string[]).includes('cancel_reminder')
          ? ((await acceptTargetContinuation(client, {
              ownerId,
              conversationId: conversation.id,
              inputMessageId: userMessageId,
              sourceRunId: input.clarification_of_run_id,
              timeContext: deps.timeContext,
            })) ??
            (await acceptTargetContinuation(client, {
              ownerId,
              conversationId: conversation.id,
              inputMessageId: userMessageId,
              sourceRunId: input.clarification_of_run_id,
              timeContext: deps.timeContext,
              kind: 'destination',
            })))
          : null;
      const reminderDate = await acceptReminderDate(
        client,
        {
          ownerId,
          conversationId: conversation.id,
          inputMessageId: userMessageId,
          text,
          receivedAtUtc,
          foldChoice: input.fold_choice,
          confirmedTimezone,
          directCreation:
            delegation && (allowlist as readonly string[]).includes('create_reminder'),
          ...(input.clarification_of_run_id
            ? { clarificationOfRunId: input.clarification_of_run_id }
            : {}),
        },
        { listReminderClarifications, readReminderTimeErrors },
      );
      if (
        !targetContinuation &&
        delegation &&
        execution === 'harness' &&
        reminderDate.source.kind === 'clarification' &&
        reminderDate.source.sourceRunId &&
        (allowlist as readonly string[]).includes('get_task') &&
        (allowlist as readonly string[]).includes('cancel_reminder')
      ) {
        const sourceInput = {
          ownerId,
          conversationId: conversation.id,
          inputMessageId: userMessageId,
          sourceRunId: reminderDate.source.sourceRunId,
          sourceInvocationId: reminderDate.source.sourceInvocationId,
          timeContext: deps.timeContext,
        };
        targetContinuation =
          (await acceptTargetContinuation(client, { ...sourceInput, kind: 'time' })) ??
          (await acceptTargetContinuation(client, { ...sourceInput, kind: 'timezone' }));
      }
      if (targetContinuation?.workspaceGrants) {
        const priorIds = new Set(
          targetContinuation.workspaceGrants.map((grant) => grant.workspace_id),
        );
        if (input.workspace_ids?.some((id) => !priorIds.has(id)))
          throw validationError('workspace selection exceeds the original goal scope');
        workspaceSet = resolveWorkspaceGrants(ownerId, input.workspace_ids ?? [...priorIds]);
        const continuedGrants = workspaceSet.grants.map((grant) => {
          const previous = targetContinuation.workspaceGrants!.find(
            (candidate) => candidate.workspace_id === grant.workspace_id,
          );
          const directories = targetContinuation.workspaceCreateAllowed
            ? grant.output_directories?.filter((directory) =>
                previous?.output_directories?.some(
                  (old) => old.path === directory.path && old.identity === directory.identity,
                ),
              )
            : undefined;
          const base = {
            workspace_id: grant.workspace_id,
            owner_id: grant.owner_id,
            registration_digest: grant.registration_digest,
            root_identity: grant.root_identity,
          };
          return directories?.length ? { ...base, output_directories: directories } : base;
        });
        workspaceSet = {
          grants: continuedGrants,
          summaries: continuedGrants.map((grant) => validateWorkspaceGrant(ownerId, grant)),
        };
        allowlist = [
          ...DELEGATION_TOOL_IDS,
          ...(workspaceSet.grants.length ? DELEGATION_WORKSPACE_READ_TOOL_IDS : []),
          ...(workspaceSet.summaries.some((summary) => summary.writable_paths.length)
            ? DELEGATION_WORKSPACE_WRITE_TOOL_IDS
            : []),
          ...(workspaceSet.grants.some((grant) => grant.output_directories?.length)
            ? DELEGATION_WORKSPACE_CREATE_TOOL_IDS
            : []),
        ];
      }
      if (execution === 'harness') allowlist = [...allowlist, ...R3_MEMORY_TOOL_IDS];
      const feishuUrl =
        delegation && execution === 'harness' && sessionId ? suppliedFeishuDocxUrl(text) : null;
      const feishuConfig = feishuUrl ? loadFeishuBotDocxConfiguration() : null;
      const feishuDocx =
        feishuConfig &&
        feishuUrl &&
        sessionId &&
        readFeishuBotObservationKey(feishuConfig) &&
        (await lockViewerAccess(client, ownerId, sessionId))
          ? await freezeFeishuBotDocxGrant(client, feishuConfig, { ownerId, sessionId }, feishuUrl)
          : null;
      if (delegation && execution === 'harness') allowlist = [...allowlist, 'learn_docs_search'];
      if (feishuDocx) {
        // Private text is model input, not authorization to publish that text via another tool.
        const privateReadTools: Partial<Record<string, true>> = {
          list_tasks: true,
          get_task: true,
          read_brief_cards: true,
          get_user_prefs: true,
          read_run_observation: true,
        };
        allowlist = [
          ...allowlist.filter((tool) => privateReadTools[tool] === true),
          'feishu_docx_read',
        ];
      }
      if (
        delegation &&
        input.clarification_of_run_id &&
        !targetContinuation &&
        reminderDate.source.kind !== 'clarification'
      )
        throw validationError(
          '无法确认这条补充对应哪个未完成的问题。请说明要处理的目标及其与前一请求的关系。',
        );
      // Resolve inherited reminders before the rules gate; a failure rolls back
      // admission without consuming the source or reserving the retry key.
      const reminderText = reminderDate.originalText ?? text;
      if (
        execution === 'business' &&
        findReminderDirective(reminderText) >= 0 &&
        !CANCEL_INTENT.test(reminderText)
      )
        requireTimeContext(deps.timeContext);
      confirmedTimezone = reminderDate.timezone ?? confirmedTimezone;
      const runId = candidateRunId;
      const attemptId = randomUUID();
      const mode =
        execution === 'harness'
          ? 'chat'
          : findReminderDirective(text) >= 0 || CANCEL_INTENT.test(text)
            ? 'task'
            : 'chat';
      const maxIterations =
        execution === 'harness' ? deps.harness!.maxIterations : BUSINESS_MAX_ITERATIONS;
      const maxTokens = execution === 'harness' ? deps.harness!.maxTokens : BUSINESS_MAX_TOKENS;
      const useR3Context = execution === 'harness' && !!ownership;
      const compactCompletionCap = useR3Context
        ? (deps.harness!.compactCompletionCap ?? deps.harness!.contextPolicy.completion_cap)
        : undefined;
      if (useR3Context) allowlist = [...allowlist, R3_MEMORY_SOURCE_TOOL_ID];
      const selected =
        execution === 'harness'
          ? await resolveSelection(client, ownerId, input.model_selection)
          : null;
      const autoCompactPolicy = useR3Context
        ? deps.harness?.autoCompactPolicy
          ? AutoCompactPolicySchema.parse(deps.harness.autoCompactPolicy)
          : (createAutoCompactPolicy(
              {
                ...deps.harness!.contextPolicy,
                model_binding: {
                  ...deps.harness!.contextPolicy.model_binding,
                  model: selected!.model_id,
                },
              },
              deps.harness!.autoCompactPlanningTokens,
            ) ?? undefined)
        : undefined;
      const messageRefs =
        execution === 'harness' && !useR3Context
          ? await listHarnessMessageRefs(client, {
              ownerId,
              conversationId: conversation.id,
              userMessageId,
            })
          : undefined;
      const trustedExecutionContext = delegation
        ? TrustedExecutionContextSchema.parse({
            version: 1,
            authorization_revision: 'delegation/1',
            execution_lifecycle: ownership ? 'server-owned' : 'request-bound',
            ...(execution === 'harness' &&
            (allowlist as readonly string[]).includes('workspace_create') &&
            (allowlist as readonly string[]).includes('workspace_read')
              ? { create_resolution_revision: 'create-resolution/2' as const }
              : {}),
            input_message_id: userMessageId,
            received_at_utc: receivedAtUtc,
            request_anchor_utc: targetContinuation?.anchor ?? reminderDate.anchor,
            continuation:
              targetContinuation?.continuation ??
              (reminderDate.source.kind === 'clarification'
                ? {
                    run_id: reminderDate.source.sourceRunId,
                    invocation_id: reminderDate.source.sourceInvocationId ?? null,
                  }
                : null),
            timezone: confirmedTimezone
              ? {
                  timezone_id: confirmedTimezone,
                  source: timezone ? 'explicit' : 'preference',
                  reference: timezone ? userMessageId : ownerId,
                }
              : null,
            time_capabilities: {
              elapsed_revision: (allowlist as readonly string[]).includes('create_reminder')
                ? 'elapsed/1'
                : null,
              wall_rules: deps.timeContext.available
                ? {
                    ruleset_id: deps.timeContext.ruleset_id,
                    tzdb_version: deps.timeContext.tzdb_version,
                    alias_version: deps.timeContext.aliases.version,
                  }
                : null,
            },
            workspaces: workspaceSet.summaries,
          })
        : undefined;
      const frozenContext = {
        ...(execution === 'harness'
          ? {
              execution_profile: useR3Context
                ? ('compact-memory/1' as const)
                : ('pause-memory/1' as const),
            }
          : {}),
        ...(autoCompactPolicy ? { autoCompactPolicy } : {}),
        ...(compactCompletionCap === undefined ? {} : { compactCompletionCap }),
        confirmedTimezone,
        anchorReceivedAtUtc: targetContinuation?.anchor ?? reminderDate.anchor,
        receivedAtUtc,
        foldChoice: input.fold_choice,
        rulesetId: deps.timeContext.ruleset_id,
        tzdbVersion: deps.timeContext.tzdb_version,
        aliasVersion: deps.timeContext.available ? deps.timeContext.aliases.version : null,
        reminderDateSource: reminderDate.source,
        ...(delegation && (allowlist as readonly string[]).includes('cancel_reminder')
          ? { cancellationScopeRevision: 'scope/1' as const }
          : {}),
        ...(messageRefs ? { messageRefs } : {}),
        ...(workspaceGrant ? { workspaceGrant, workspaceSummary } : {}),
        ...(delegation ? { workspaceGrants: workspaceSet.grants } : {}),
        ...(feishuDocx ? { feishuDocx } : {}),
        ...(delegation &&
        (!targetContinuation || targetContinuation.createdArtifactReadAllowed) &&
        workspaceSet.grants.some((grant) => (grant.output_directories?.length ?? 0) > 0)
          ? { createdArtifactReadRevision: 'owner-created/1' as const }
          : {}),
        ...(delegation &&
        (allowlist as readonly string[]).includes('workspace_create') &&
        (allowlist as readonly string[]).includes('workspace_read')
          ? { createResolutionRevision: 'create-resolution/2' as const }
          : {}),
        ...(trustedExecutionContext
          ? {
              authorization_revision: 'delegation/1' as const,
              execution_lifecycle: ownership
                ? ('server-owned' as const)
                : ('request-bound' as const),
              trustedExecutionContext,
            }
          : {}),
      };
      await insertRun(client, {
        runId,
        ownerId,
        conversationId: conversation.id,
        agentRevision: AGENT_REVISION,
        mode,
        maxIterations,
        maxTokens,
        execution,
        allowlist,
        frozenContext,
        inputMessageId: userMessageId,
      });
      const r3Context = useR3Context
        ? await freezeR3Context(client, {
            ownerId,
            conversationId: conversation.id,
            runId,
            userMessageId,
          })
        : undefined;
      if (selected) await bindRunSelection(client, ownerId, runId, selected);
      const contextPolicy =
        execution === 'harness'
          ? await ensureRunContextPolicy(client, ownerId, runId, {
              ...deps.harness!.contextPolicy,
              model_window_tokens:
                selected!.context_window_tokens ?? deps.harness!.contextPolicy.model_window_tokens,
              model_binding: {
                ...deps.harness!.contextPolicy.model_binding,
                model: selected!.model_id,
              },
            })
          : undefined;
      await insertAttempt(client, {
        attemptId,
        ownerId,
        runId,
        attemptNo: 1,
        ...(ownership ? { leaseToken: ownership.token } : {}),
      });
      const routingPolicy =
        execution === 'harness' && !feishuDocx ? routingRuntimeOf(deps).policy() : null;
      if (routingPolicy)
        await insertRoutingPolicy(
          client,
          { ownerId, runId, attemptId, userMessageId },
          routingPolicy,
        );
      await deleteExpiredIdempotency(client, ownerId, key);
      await insertIdempotency(client, {
        ownerId,
        idempotencyKey: key,
        requestHash,
        conversationId: conversation.id,
        runId,
        userMessageId,
      });
      const runContext: RunContext = {
        ownerId,
        conversationId: conversation.id,
        runId,
        attemptId,
        requestId,
        ...(ownership ? { ownership } : {}),
        inputText: text,
        ...(reminderDate.originalText ? { reminderInputText: reminderDate.originalText } : {}),
        ...(reminderDate.source.kind === 'unresolved' ? { reminderNeedsRestatement: true } : {}),
        confirmedTimezone,
        anchorReceivedAtUtc: targetContinuation?.anchor ?? reminderDate.anchor,
        receivedAtUtc,
        foldChoice: input.fold_choice,
        maxIterations,
        maxTokens,
        execution,
        ...(execution === 'harness'
          ? {
              executionProfile: useR3Context
                ? ('compact-memory/1' as const)
                : ('pause-memory/1' as const),
            }
          : {}),
        userMessageId,
        allowlist,
        ...(autoCompactPolicy ? { autoCompactPolicy } : {}),
        ...(compactCompletionCap === undefined ? {} : { compactCompletionCap }),
        ...(messageRefs ? { messageRefs } : {}),
        ...(r3Context
          ? {
              r3Context,
              messages: [
                ...r3Context.messages,
                { message_id: userMessageId, role: 'user' as const, content: text },
              ],
            }
          : {}),
        ...(contextPolicy ? { contextPolicy } : {}),
        ...(workspaceGrant ? { workspaceGrant } : {}),
        ...(delegation ? { workspaceGrants: workspaceSet.grants } : {}),
        ...(feishuDocx ? { feishuDocx } : {}),
        ...(trustedExecutionContext
          ? { authorizationRevision: 'delegation/1' as const, trustedExecutionContext }
          : {}),
        timeContext: deps.timeContext,
      };
      if (r3Context)
        buildHarnessStart(
          runContext,
          null,
          [],
          null,
          routingPolicy,
          !feishuDocx &&
            !trustedExecutionContext?.continuation &&
            !r3Context.summary &&
            routingPolicy?.mode !== 'off'
            ? 'fresh_first_step'
            : 'disabled',
        );
      return { conversationId: conversation.id, runId, replayRunId: null, context: runContext };
    });
  } catch (err) {
    if (ownership) await deps.runDriver!.release(ownership);
    const pgError = pgErrorOf(err);
    if (pgError?.code === '23505' && pgError.constraint === 'conversation_idempotency_pkey') {
      const existing = await withTransaction(pool, async (client) => {
        if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
          throw forbidden('owner authorization revoked');
        return findIdempotency(client, ownerId, key);
      });
      if (!existing) throw err;
      if (existing.request_hash !== requestHash) {
        throw stateConflict('idempotency key reused with a different body') as ApplicationError;
      }
      started = {
        conversationId: existing.conversation_id,
        runId: existing.run_id,
        replayRunId: existing.run_id,
        context: null,
      };
    } else {
      throw err;
    }
  }

  if (started.replayRunId && ownership) await deps.runDriver!.release(ownership);
  if (started.replayRunId) {
    const replay = await listRunEvents(pool, ownerId, started.replayRunId);
    return {
      conversationId: started.conversationId,
      runId: started.runId,
      replay,
      context: null,
    };
  }
  if (!started.context) throw new Error('run context missing');
  if (ownership) {
    try {
      deps.runDriver!.start(deps, started.context);
    } catch (error) {
      await deps.runDriver!.release(ownership);
      throw error;
    }
    return {
      conversationId: started.conversationId,
      runId: started.runId,
      replay: null,
      context: null,
      serverOwned: true,
      afterSeq: null,
    };
  }
  return {
    conversationId: started.conversationId,
    runId: started.runId,
    replay: null,
    context: started.context,
  };
}
