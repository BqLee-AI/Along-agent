import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  HARNESS_CONTEXT_PROTOCOL_VERSION,
  HARNESS_MAX_FRAME_BYTES,
  HarnessContextMeasurementSchema,
  HarnessR3SnapshotSchema,
} from '@along/contracts';
import { withTransaction } from '../../db/transaction.js';
import {
  ApplicationError,
  notFound,
  stateConflict,
  validationError,
} from '../../platform/errors.js';
import { readRunContextObservations } from '../tools/invocations/context-query.js';
import { assertContextSourcesAuthorized } from '../tools/invocations/context-source.js';
import {
  hasBlockingInvocationFailure,
  readRunInvocationStates,
} from '../tools/invocations/run-state.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import { resolveRunSelection } from '../../features/model-providers/public.js';
import type { ConversationDeps, RunContext } from '../runtime/contracts.js';
import {
  ActionKeySchema,
  insertAttempt,
  lockRun,
  assertCompactEligibility,
  decodeRunSnapshot,
  encodeRunSnapshot,
  failCompact,
  recordCompactUsage,
} from '../../features/conversations/public.js';
import { withRunTransaction, type RunOwnership } from '../runtime/run-ownership.js';
import { commitTerminal } from './finish.js';
import { readRunApprovalDecision } from './run-approval-decision.js';
import {
  readCompactContinuation,
  validateR3SnapshotContext,
} from '../runtime/compact-continuation.js';
import { executeCompact } from './compact-execution.js';
import { GOAL_CONTROL_TOOL } from '../tools/goal-control.js';
import { runNativeHarness, type NativeHandoff } from '../harness/harness-process.js';
import { active } from './run.js';
import {
  buildHarnessStart,
  contextOf,
  poolOf,
  toolContext,
  withLatest,
} from '../runtime/context.js';

function eventPayload(context: RunContext) {
  return { conversation_id: context.conversationId, run_id: context.runId };
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
      const continuation = { ownerId, conversationId, runId, attemptId, id: pauseId };
      const storedSnapshot = await encodeRunSnapshot(
        client,
        {
          ...continuation,
          kind: 'compact-snapshot',
        },
        restored.snapshot,
      );
      const storedContext = await encodeRunSnapshot(
        client,
        {
          ...continuation,
          kind: 'compact-context',
        },
        restored.context,
      );
      await client.query(
        `INSERT INTO compact_continuations(pause_id,attempt_id,snapshot,context) VALUES($1,$2,$3::jsonb,$4::jsonb)`,
        [pauseId, attemptId, storedSnapshot, storedContext],
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
    const snapshot = HarnessR3SnapshotSchema.parse(
      await decodeRunSnapshot(
        client,
        {
          ...context,
          kind: 'pause',
          id: row.id,
        },
        row.snapshot,
      ),
    );
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
        WHERE p.id=$1 AND p.owner_id=$2 AND p.run_id=$3 AND p.attempt_id=$4 AND p.conversation_id=$5`,
        [pauseId, context.ownerId, context.runId, context.attemptId, context.conversationId],
      )
    ).rows[0];
    if (
      !row ||
      JSON.stringify(
        HarnessR3SnapshotSchema.parse(
          await decodeRunSnapshot(
            client,
            {
              ...context,
              kind: 'pause',
              id: pauseId,
            },
            row.snapshot,
          ),
        ),
      ) !== JSON.stringify(snapshot) ||
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
      if (state.state !== 'completed' || hasBlockingInvocationFailure(state))
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
      snapshot.usage.iterations + 1 >= context.maxIterations ||
      !snapshot.context.messages.length
    ) {
      await reject(
        snapshot.context.messages.length
          ? 'COMPACT_CONTINUATION_UNAVAILABLE'
          : 'COMPACT_NO_CONTENT',
      );
    } else {
      const transport = await deps.modelTransport(prepared.selected, {
        runId: context.runId,
        attemptId: context.attemptId,
        operation: 'compact',
      });
      const compactCompletionCap =
        context.compactCompletionCap ?? context.contextPolicy.completion_cap;
      await executeCompact({
        pool,
        binding,
        messageIds: snapshot.context.messages.map((message) => message.message_id),
        promptRevision: 'compact/1',
        policy: { ...context.contextPolicy, completion_cap: compactCompletionCap },
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
          maxOutputTokens: compactCompletionCap,
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
          const guardPreview: NativeHandoff = (enqueue) =>
            tx((client) =>
              assertCompactEligibility(client, binding, async (current) => {
                await guard(current, frozen.coverageMessageIds);
                await assertContextSourcesAuthorized(
                  current,
                  { ...toolContext(context), signal },
                  snapshot.tool_refs,
                );
                signal.throwIfAborted();
                enqueue();
              }),
            );
          let seen = false;
          await runNativeHarness({
            services: deps.harness!,
            start: { ...start, mode: 'measure_only' },
            signal,
            guardStart: guardPreview,
            guardReply: (_request, _result, enqueue) => guardPreview(enqueue),
            detachOnAbort: true,
            handleRequest: async (request) => {
              if (
                seen ||
                request.type !== 'context_preview' ||
                request.pending_model !== (snapshot.native_state.pending_model !== null) ||
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
        error instanceof ApplicationError ? error.errorCode : 'COMPACT_RUNTIME_FAILED',
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
