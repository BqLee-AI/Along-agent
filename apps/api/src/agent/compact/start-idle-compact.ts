import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ConversationDeps, RunContext } from '../execution/contracts.js';
import { buildHarnessStart } from '../execution/attempt/context.js';
import {
  freezeR3ControlContext,
  readCompactView,
  lockIdleCompactRequest,
  saveIdleCompactRequest,
  type IdleCompactReceipt,
  insertAttempt,
  insertCompactPause,
  lockRun,
  requirePool,
} from '../../features/conversations/public.js';
import { commitTerminal } from '../execution/result/commit.js';
import { executeRuntimeCompact } from './runtime-compact.js';
import { withTransaction } from '../../db/transaction.js';
import { forbidden, notFound, stateConflict, ApplicationError } from '../../platform/errors.js';
import { ensureRunContextPolicy } from '../../features/conversations/public.js';
import { isActiveOwner } from '../../features/identity/public.js';
import { withRunTransaction, type RunOwnership } from '../execution/driver/ownership.js';
import {
  resolveSelection,
  bindRunSelection,
  lockOwner,
} from '../../features/model-providers/public.js';
import { AGENT_REVISION } from '../execution/attempt/context.js';
import { utcSecondIso } from '../../features/time/public.js';

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
      await insertCompactPause(
        client,
        { pauseId, ownerId, conversationId, runId, attemptId },
        'manual_compact',
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
    deps.runDriver.start(deps, admitted.context, executeRuntimeCompact);
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
