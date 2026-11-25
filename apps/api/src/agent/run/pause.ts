import { randomUUID } from 'node:crypto';
import { HarnessPauseSnapshotSchema, HarnessR3SnapshotSchema } from '@along/contracts';
import { ApplicationError, stateConflict, validationError } from '../../platform/errors.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import type { ConversationDeps, StartResult } from '../execution/contracts.js';
import {
  ActionKeySchema,
  ContinueRunBodySchema,
  PauseRunBodySchema,
  decodeRunSnapshot,
  insertPauseSuccessor,
  activatePauseSuccessor,
  readRunEventCursor,
} from '../../features/conversations/public.js';
import {
  buildHarnessStart,
  contextOf,
  readSnapshotObservations,
  restoreSnapshotContext,
  withLatest,
} from '../execution/attempt/context.js';
import { resumeRun } from './resume-run.js';

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
  const parsedKey = ActionKeySchema.safeParse(key);
  if (!parsed.success || !parsedKey.success) throw validationError('invalid continue request');
  const pauseId = parsed.data.pause_id;
  return resumeRun(
    deps,
    ownerId,
    conversationId,
    runId,
    parsedKey.data,
    { kind: 'pause', id: pauseId },
    async (client, locked, ownership) => {
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
          (snapshot.usage.tokens !== null && snapshot.usage.tokens >= locked.run.budget_max_tokens))
      )
        throw new ApplicationError(429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
      for (const grant of locked.run.frozen_context.workspaceGrants ?? [])
        validateWorkspaceGrant(ownerId, grant);
      const attemptId = randomUUID();
      const context = await contextOf(client, deps, locked.run, attemptId, requestId);
      if (ownership) context.ownership = ownership;
      await restoreSnapshotContext(client, context, snapshot);
      const observations = await readSnapshotObservations(client, context, snapshot);
      buildHarnessStart(context, snapshot, observations, null);
      const afterSeq = ownership ? await readRunEventCursor(client, runId) : null;
      await insertPauseSuccessor(client, {
        attemptId,
        ownerId,
        runId,
        pauseId,
        source: 'user',
        key: parsedKey.data,
        attemptNo: locked.attempt.attempt_no + 1,
        ...(ownership ? { leaseToken: ownership.token } : {}),
      });
      await activatePauseSuccessor(client, pauseId, runId);
      return { conversationId, runId, context, replay: null, ...(ownership ? { afterSeq } : {}) };
    },
  );
}
