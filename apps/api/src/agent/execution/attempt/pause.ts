import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HarnessR3SnapshotSchema, type HarnessRequest } from '@along/contracts';
import { stateConflict } from '../../../platform/errors.js';
import {
  hasBlockingInvocationFailure,
  readRunInvocationStates,
} from '../../tools/invocations/run-state.js';
import { readRunContextSource } from '../../tools/invocations/context-query.js';
import type { RunContext } from '../contracts.js';
import {
  decodeRunSnapshot,
  encodeRunSnapshot,
  insertCompactPause,
  type LockedRun,
} from '../../../features/conversations/public.js';
import { buildHarnessStart } from './context.js';
import { routingIdentity } from '../../routing/routing-checkpoints.js';
import type { createSnapshotValidator } from './snapshot.js';

interface PauseState {
  measuredForCompact: boolean;
  nextPermit: boolean;
  readonly cumulative: { iterations: number; tokens: number | null };
  readonly modelToolCount: number;
  readonly delivered: Set<string>;
  readonly latestModelMessage: unknown;
  stopped: boolean;
}

export function createPauseHandlers(
  context: RunContext,
  automaticCompactEnabled: boolean,
  state: PauseState,
  guarded: <T>(action: (client: PoolClient, locked: LockedRun) => Promise<T>) => Promise<T>,
  assertActionAuthority: (client: PoolClient) => Promise<void>,
  validateSnapshot: ReturnType<typeof createSnapshotValidator>,
) {
  async function pauseProbe(request: Extract<HarnessRequest, { type: 'pause_probe' }>) {
    return guarded(async (client) => {
      await assertActionAuthority(client);
      let pending =
        (
          await client.query(
            `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
            [context.ownerId, context.runId, context.attemptId],
          )
        ).rowCount !== 0;
      const measured = state.measuredForCompact;
      state.measuredForCompact = false;
      if (
        !pending &&
        request.auto_compact &&
        state.nextPermit &&
        automaticCompactEnabled &&
        measured &&
        context.r3Context
      ) {
        const prior = await client.query<{ id: string; attempt_id: string; snapshot: unknown }>(
          `SELECT id,attempt_id,snapshot FROM harness_pauses
           WHERE owner_id=$1 AND run_id=$2 AND conversation_id=$3 AND purpose='automatic_compact'
             AND snapshot IS NOT NULL
             AND (snapshot->'context'=$4::jsonb OR snapshot ? 'encoding')`,
          [
            context.ownerId,
            context.runId,
            context.conversationId,
            JSON.stringify(context.r3Context),
          ],
        );
        // A plaintext row matched the original coverage predicate in PostgreSQL.
        // Only encrypted rows need to be opened to compare their context.
        let alreadyCompacted = false;
        for (const row of prior.rows) {
          if (row.snapshot && typeof row.snapshot === 'object' && !('encoding' in row.snapshot)) {
            alreadyCompacted = true;
            break;
          }
          const previous = HarnessR3SnapshotSchema.parse(
            await decodeRunSnapshot(
              client,
              {
                ...context,
                kind: 'pause',
                id: row.id,
                attemptId: row.attempt_id,
              },
              row.snapshot,
            ),
          );
          if (routingIdentity(previous.context) === routingIdentity(context.r3Context)) {
            alreadyCompacted = true;
            break;
          }
        }
        const live = await client.query(
          `SELECT 1 FROM harness_pauses WHERE run_id=$1 AND state IN ('pending','paused')`,
          [context.runId],
        );
        if (!alreadyCompacted && !live.rowCount) {
          await insertCompactPause(
            client,
            { ...context, pauseId: randomUUID() },
            'automatic_compact',
          );
          pending = true;
        }
      }
      state.nextPermit = !pending;
      return { pending };
    });
  }

  async function pausePoint(request: Extract<HarnessRequest, { type: 'pause_point' }>) {
    const paused = await guarded(async (client) => {
      const pending = (
        await client.query<{ id: string }>(
          `SELECT id FROM harness_pauses WHERE owner_id=$1 AND run_id=$2
           AND attempt_id=$3 AND state='pending' FOR UPDATE`,
          [context.ownerId, context.runId, context.attemptId],
        )
      ).rows[0];
      if (!pending) {
        state.nextPermit = true;
        return false;
      }
      await assertActionAuthority(client);
      const snapshot = request.context;
      if (snapshot.version === 4 && snapshot.waiting)
        throw stateConflict('pause cannot consume approval waiting');
      if (
        snapshot.native_state.pending_model &&
        (state.modelToolCount !== state.delivered.size ||
          routingIdentity(snapshot.native_state.pending_model) !==
            routingIdentity(state.latestModelMessage))
      )
        throw stateConflict('pause pending model call differs from accepted response');
      if (
        snapshot.usage.iterations !== state.cumulative.iterations ||
        snapshot.usage.tokens !== state.cumulative.tokens
      )
        throw stateConflict('pause usage differs from accepted model steps');
      const states = await readRunInvocationStates(client, context);
      if (states.some((row) => row.state !== 'completed' || hasBlockingInvocationFailure(row)))
        throw stateConflict('pause requires all tool effects to be resolved');
      const { observations } = await validateSnapshot(
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
        states,
      );
      if (snapshot.version === 3) {
        if (snapshot.native_state.units.length !== snapshot.tool_refs.length)
          throw stateConflict('pause must retain each accepted observation');
        for (let i = 0; i < snapshot.native_state.units.length; i++) {
          const unit = snapshot.native_state.units[i]!;
          if (unit.observation.invocation_id !== snapshot.tool_refs[i])
            throw stateConflict('pause observation order differs from accepted tools');
          const authoritative = await readRunContextSource(
            client,
            context,
            unit.observation.invocation_id,
            unit.observation.view,
          );
          if (routingIdentity(authoritative) !== routingIdentity(unit.observation))
            throw stateConflict('pause observation differs from accepted result');
        }
        buildHarnessStart(context, snapshot, observations, null);
      }
      const storedSnapshot = await encodeRunSnapshot(
        client,
        {
          ...context,
          kind: 'pause',
          id: pending.id,
        },
        snapshot,
      );
      await client.query(
        `UPDATE harness_pauses SET state='paused',snapshot=$2::jsonb WHERE id=$1`,
        [pending.id, storedSnapshot],
      );
      await client.query(`UPDATE agent_runs SET status='paused' WHERE id=$1`, [context.runId]);
      await client.query(`UPDATE run_attempts SET status='done',ended_at=now() WHERE id=$1`, [
        context.attemptId,
      ]);
      return true;
    });
    if (paused) state.stopped = true;
    return { paused };
  }

  return { pauseProbe, pausePoint };
}
