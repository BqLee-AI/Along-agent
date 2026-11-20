import type { Pool } from 'pg';
import {
  HarnessPauseSnapshotSchema,
  HarnessR3SnapshotSchema,
  type HarnessSnapshot,
  type HarnessPauseSnapshot,
  type HarnessR3Snapshot,
  type HarnessStart,
  type HarnessApprovalDecision,
  type HarnessR3Context,
} from '@along/contracts';
import {
  type RoutingRecord,
  type RoutingPolicyPayload,
  readRoutingPolicy,
  readRoutingRecord,
  type RoutingDecisionPayload,
} from '../routing/routing-checkpoints.js';
import { stateConflict } from '../../platform/errors.js';
import { readRunInvocationStates } from '../tools/invocations/run-state.js';
import { readRunContextObservations } from '../tools/invocations/context-query.js';
import { assertContextSourcesAuthorized } from '../tools/invocations/context-source.js';
import type { NativeHandoff } from '../harness/harness-process.js';
import type { ConversationDeps, RunContext } from './contracts.js';
import { withRunTransaction } from './run-ownership.js';
import { decodeRunSnapshot, lockRun } from '../../features/conversations/public.js';
import { readSnapshot } from './run-snapshot.js';
import { readRunApprovalDecision } from '../operations/run-approval-decision.js';
import {
  readConsumedCompactContinuation,
  validateR3SnapshotContext,
} from './compact-continuation.js';
import { contextOf, toolContext } from './context.js';

export interface LoadedAttempt {
  context: RunContext;
  snapshot: HarnessSnapshot | HarnessPauseSnapshot | HarnessR3Snapshot | null;
  observations: HarnessStart['observations'];
  approval: HarnessApprovalDecision | null;
  policy: RoutingRecord<RoutingPolicyPayload> | null;
  eligible: boolean;
  decision: RoutingRecord<RoutingDecisionPayload> | null;
  compact: { snapshot: HarnessR3Snapshot; context: HarnessR3Context } | null;
}

export async function guardHarnessStart(
  pool: Pool,
  context: RunContext,
  snapshot: LoadedAttempt['snapshot'],
  signal: AbortSignal,
  enqueue: Parameters<NativeHandoff>[0],
): Promise<void> {
  await withRunTransaction(pool, context.ownership, async (client) => {
    await lockRun(client, context);
    await assertContextSourcesAuthorized(
      client,
      { ...toolContext(context), signal },
      snapshot?.tool_refs ?? [],
    );
    signal.throwIfAborted();
    enqueue();
  });
}

export async function loadHarnessSession(
  pool: Pool,
  deps: ConversationDeps,
  supplied: RunContext,
): Promise<LoadedAttempt> {
  return await withRunTransaction(pool, supplied.ownership, async (client) => {
    const locked = await lockRun(client, supplied);
    if (locked.run.execution !== 'harness') throw stateConflict('not a harness Run');
    const feishu = locked.run.frozen_context?.feishuDocx;
    if (feishu && !('kind' in feishu)) throw stateConflict('legacy Feishu Run cannot be restored');
    const resume = (
      await client.query<{ checkpoint_id: string }>(
        'SELECT checkpoint_id FROM harness_resumes WHERE attempt_id=$1 AND run_id=$2 AND owner_id=$3',
        [supplied.attemptId, supplied.runId, supplied.ownerId],
      )
    ).rows[0];
    const pausedResume = (
      await client.query<{ id: string; attempt_id: string; snapshot: unknown; source: string }>(
        `SELECT p.id,p.attempt_id,p.snapshot,r.source
       FROM harness_pause_resumes r JOIN harness_pauses p ON p.id=r.pause_id
       WHERE r.attempt_id=$1 AND r.run_id=$2 AND r.owner_id=$3 AND p.state='consumed'
         AND p.run_id=r.run_id AND p.owner_id=r.owner_id AND p.conversation_id=$4`,
        [supplied.attemptId, supplied.runId, supplied.ownerId, supplied.conversationId],
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
    const pausedPayload =
      pausedResume && !compact
        ? await decodeRunSnapshot(
            client,
            {
              ...context,
              kind: 'pause',
              id: pausedResume.id,
              attemptId: pausedResume.attempt_id,
            },
            pausedResume.snapshot,
          )
        : null;
    const snapshot =
      compact?.snapshot ??
      (pausedResume
        ? locked.run.frozen_context?.execution_profile === 'compact-memory/1'
          ? HarnessR3SnapshotSchema.parse(pausedPayload)
          : HarnessPauseSnapshotSchema.parse(pausedPayload)
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
}
