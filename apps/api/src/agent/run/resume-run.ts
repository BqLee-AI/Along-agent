import { listRunEvents, requirePool, type LockedRun } from '../../features/conversations/public.js';
import type { PoolClient } from 'pg';
import { executeRuntimeCompact } from '../compact/runtime-compact.js';
import { unavailable, withLatest } from '../execution/attempt/context.js';
import type { ConversationDeps, StartResult } from '../execution/contracts.js';
import type { RunOwnership } from '../execution/driver/ownership.js';
import { stateConflict } from '../../platform/errors.js';

/** Acquire before the locked transaction and hand off only after it commits. */
export async function resumeRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  key: string,
  point: { kind: 'pause' | 'approval'; id: string },
  resume: (client: PoolClient, locked: LockedRun, ownership?: RunOwnership) => Promise<StartResult>,
): Promise<StartResult> {
  const pause = point.kind === 'pause';
  const receipt = pause ? 'harness_pause_resumes' : 'harness_resumes';
  const column = pause ? 'pause_id' : 'checkpoint_id';
  const { rows } = await requirePool(deps).query<{ lifecycle: string | null; prior: boolean }>(
    `SELECT frozen_context->>'execution_lifecycle' AS lifecycle,
       EXISTS(SELECT 1 FROM ${receipt} WHERE owner_id=$1 AND idempotency_key=$4) AS prior
     FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2 AND id=$3`,
    [ownerId, conversationId, runId, key],
  );
  let ownership: RunOwnership | undefined;
  if (rows[0]?.lifecycle === 'server-owned' && !rows[0].prior) {
    if (!deps.runDriver) throw unavailable();
    ownership = await deps.runDriver.acquire(runId, true);
  }
  try {
    const result = await withLatest(
      deps,
      ownerId,
      conversationId,
      runId,
      async (client, locked) => {
        const { rows } = await client.query<{
          run_id: string;
          point_id: string;
          attempt_id: string;
          status: string | null;
        }>(
          `SELECT receipt.run_id, receipt.${column} AS point_id, receipt.attempt_id,
                  ${pause ? 'NULL' : 'attempt.status'} AS status
           FROM ${receipt} receipt
           ${pause ? '' : 'LEFT JOIN run_attempts attempt ON attempt.id=receipt.attempt_id'}
           WHERE receipt.owner_id=$1 AND receipt.idempotency_key=$2`,
          [ownerId, key],
        );
        const prior = rows[0];
        if (!prior) {
          if (locked.run.frozen_context?.execution_lifecycle === 'server-owned' && !ownership)
            throw stateConflict('Run ownership required');
          return resume(client, locked, ownership);
        }
        if (prior.run_id !== runId || prior.point_id !== point.id)
          throw stateConflict(
            pause ? 'continue idempotency key conflict' : 'resume idempotency key conflict',
          );
        if (!pause && prior.status === 'running')
          throw stateConflict('resumed Run still running', {
            status: 'running',
            run_id: runId,
            attempt_id: prior.attempt_id,
          });
        return {
          conversationId,
          runId,
          context: null,
          replay: await listRunEvents(client, ownerId, runId, prior.attempt_id),
        };
      },
      true,
      ownership,
    );
    if (!ownership || !result.context) return result;
    deps.runDriver!.start(deps, result.context, executeRuntimeCompact);
    ownership = undefined;
    return {
      conversationId,
      runId,
      context: null,
      replay: null,
      serverOwned: true,
      afterSeq: result.afterSeq ?? null,
    };
  } finally {
    if (ownership) await deps.runDriver!.release(ownership);
  }
}
