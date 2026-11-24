import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  HarnessContextMeasurementSchema,
  HarnessR3SnapshotSchema,
  type HarnessRequest,
  type HarnessSnapshot,
  type HarnessR3Snapshot,
} from '@along/contracts';
import { stateConflict } from '../../platform/errors.js';
import {
  hasBlockingInvocationFailure,
  readRunInvocationStates,
} from '../tools/invocations/run-state.js';
import {
  readRunContextObservations,
  readRunContextSource,
} from '../tools/invocations/context-query.js';
import type { RunContext } from './contracts.js';
import {
  decodeRunSnapshot,
  encodeRunSnapshot,
  type LockedRun,
  shouldAutoCompact,
} from '../../features/conversations/public.js';
import { buildHarnessStart, toolContext } from './context.js';
import { routingIdentity } from '../routing/routing-checkpoints.js';

interface PauseState {
  lastMeasurement: {
    measurement: ReturnType<typeof HarnessContextMeasurementSchema.parse>;
    remaining: number | null;
    output: number;
  } | null;
  nextPermit: boolean;
  readonly cumulative: { iterations: number; tokens: number | null };
  readonly modelToolCount: number;
  readonly delivered: Set<string>;
  readonly latestModelMessage: unknown;
  stopped: boolean;
}

export function createPauseHandlers(
  context: RunContext,
  state: PauseState,
  guarded: <T>(action: (client: PoolClient, locked: LockedRun) => Promise<T>) => Promise<T>,
  assertActionAuthority: (client: PoolClient) => Promise<void>,
  validateSnapshot: (
    client: PoolClient,
    snapshot: HarnessSnapshot | HarnessR3Snapshot,
  ) => Promise<void>,
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
      const measured = state.lastMeasurement;
      state.lastMeasurement = null;
      if (
        !pending &&
        request.after_measurement &&
        state.nextPermit &&
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
          compactOutputTokens: context.compactCompletionCap ?? context.contextPolicy.completion_cap,
          iterationsRemaining: context.maxIterations - state.cumulative.iterations,
          uncoveredMessageCount: context.r3Context.messages.length,
        })
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
      const states = await readRunInvocationStates(client, toolContext(context));
      if (states.some((row) => row.state !== 'completed' || hasBlockingInvocationFailure(row)))
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
