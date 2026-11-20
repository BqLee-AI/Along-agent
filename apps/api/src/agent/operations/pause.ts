import { randomUUID } from 'node:crypto';
import { HarnessPauseSnapshotSchema, HarnessR3SnapshotSchema } from '@along/contracts';
import { ApplicationError, stateConflict, validationError } from '../../platform/errors.js';
import { readRunContextObservations } from '../tools/invocations/context-query.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import type { ConversationDeps, StartResult } from '../runtime/contracts.js';
import {
  ActionKeySchema,
  ContinueRunBodySchema,
  PauseRunBodySchema,
  decodeRunSnapshot,
  insertAttempt,
  listRunEvents,
} from '../../features/conversations/public.js';
import type { RunOwnership } from '../runtime/run-ownership.js';
import { validateR3SnapshotContext } from '../runtime/compact-continuation.js';
import {
  buildHarnessStart,
  contextOf,
  poolOf,
  toolContext,
  unavailable,
  withLatest,
} from '../runtime/context.js';

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
        const payload = await decodeRunSnapshot(
          client,
          {
            ownerId,
            conversationId,
            runId,
            attemptId: pause.attempt_id,
            kind: 'pause',
            id: pauseId,
          },
          pause.snapshot,
        );
        const snapshot =
          locked.run.frozen_context?.execution_profile === 'compact-memory/1'
            ? HarnessR3SnapshotSchema.parse(payload)
            : HarnessPauseSnapshotSchema.parse(payload);
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
          throw new ApplicationError(429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
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
