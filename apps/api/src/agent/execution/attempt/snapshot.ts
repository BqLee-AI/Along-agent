import type { PoolClient } from 'pg';
import {
  HarnessR3SnapshotSchema,
  HistoricalHarnessSnapshotSchema,
  type HarnessSnapshot,
  type HarnessPauseSnapshot,
  type HarnessR3Snapshot,
} from '@along/contracts';
import { stateConflict } from '../../../platform/errors.js';
import { readLatestRunSnapshotPayload } from '../../../features/conversations/public.js';
import { readRunInvocationStates } from '../../tools/invocations/run-state.js';
import {
  readRunContextObservations,
  readRunContextSource,
} from '../../tools/invocations/context-query.js';
import type { RunContext } from '../contracts.js';
import { buildHarnessStart } from './context.js';
import { readRunApprovalDecision } from '../load-approval-decision.js';
import {
  routingIdentity,
  type RoutingDecisionPayload,
  type RoutingRecord,
} from '../../routing/routing-checkpoints.js';
import { validateR3SnapshotContext } from '../../../features/conversations/public.js';

interface SnapshotState {
  readonly modelStarted: boolean;
  readonly cumulative: { iterations: number; tokens: number | null };
  readonly modelToolCount: number;
  readonly delivered: Set<string>;
  readonly latestModelMessage: unknown;
  readonly routingDecision: RoutingRecord<RoutingDecisionPayload> | null;
  readonly lastSnapshot: HarnessSnapshot | HarnessPauseSnapshot | HarnessR3Snapshot | null;
}

export function createSnapshotValidator(context: RunContext, state: SnapshotState) {
  async function validateSnapshot(
    client: PoolClient,
    snapshot: HarnessSnapshot | HarnessR3Snapshot,
    states?: Awaited<ReturnType<typeof readRunInvocationStates>>,
  ) {
    if (
      (state.modelStarted || snapshot.version === 4) &&
      (snapshot.usage.iterations !== state.cumulative.iterations ||
        snapshot.usage.tokens !== state.cumulative.tokens)
    )
      throw stateConflict('snapshot usage must match accepted model steps');
    if (snapshot.version === 4) {
      if (
        context.executionProfile !== 'compact-memory/1' ||
        routingIdentity(snapshot.context) !== routingIdentity(context.r3Context)
      )
        throw stateConflict('snapshot context differs from trusted execution view');
      await validateR3SnapshotContext(client, context, snapshot);
    } else {
      const frozenRefs = context.messageRefs ?? [context.userMessageId];
      if (
        snapshot.message_refs.length !== frozenRefs.length ||
        snapshot.message_refs.some((ref, index) => ref !== frozenRefs[index])
      )
        throw stateConflict('snapshot message reference conflict');
    }
    if (new Set(snapshot.tool_refs).size !== snapshot.tool_refs.length)
      throw stateConflict('duplicate snapshot tool reference');
    states ??= await readRunInvocationStates(client, context);
    const accepted = states.filter((row) => row.state === 'completed');
    if (
      accepted.length !== snapshot.tool_refs.length ||
      accepted.some((row) => !snapshot.tool_refs.includes(row.invocation_id))
    )
      throw stateConflict('snapshot must retain accepted Run invocations');
    const observations = await readRunContextObservations(client, context, snapshot.tool_refs, {
      project: context.allowlist.includes('read_run_observation'),
    });
    if (snapshot.version === 4) {
      if (snapshot.native_state.units.length !== snapshot.tool_refs.length)
        throw stateConflict('snapshot must retain each accepted observation');
      for (let i = 0; i < snapshot.native_state.units.length; i++) {
        const unit = snapshot.native_state.units[i]!;
        if (unit.observation.invocation_id !== snapshot.tool_refs[i])
          throw stateConflict('snapshot observation order conflict');
        const source = await readRunContextSource(
          client,
          context,
          unit.observation.invocation_id,
          unit.observation.view,
        );
        if (routingIdentity(source) !== routingIdentity(unit.observation))
          throw stateConflict('snapshot observation differs from accepted result');
      }
      if (
        snapshot.native_state.pending_model &&
        (state.modelToolCount !== state.delivered.size ||
          routingIdentity(snapshot.native_state.pending_model) !==
            routingIdentity(state.latestModelMessage))
      )
        throw stateConflict('snapshot pending model differs from accepted response');
    }
    const next = accepted.reduce((max, row) => {
      const match = /^harness\/([1-9]\d*)$/.exec(row.call_key);
      if (!match) throw stateConflict('invalid harness invocation slot');
      return Math.max(max, Number(match[1]) + 1);
    }, 1);
    if (snapshot.next_call_no !== next || snapshot.usage.iterations > context.maxIterations)
      throw stateConflict('snapshot usage or call counter conflict');
    if (
      state.routingDecision?.payload.decision === 'direct' &&
      (snapshot.usage.iterations !== 0 ||
        snapshot.usage.tokens !== 0 ||
        snapshot.waiting ||
        snapshot.tool_refs.length !== 1 ||
        accepted.length !== 1)
    )
      throw stateConflict('routing snapshot must retain unique result and zero model usage');
    const previous = await readLatestRunSnapshotPayload(client, context);
    const baseline = previous
      ? context.executionProfile === 'compact-memory/1'
        ? HarnessR3SnapshotSchema.parse(previous.payload)
        : HistoricalHarnessSnapshotSchema.parse(previous.payload)
      : state.lastSnapshot;
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
      if (!row || !state.delivered.has(row.invocation_id))
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
    return { states, observations };
  }
  return validateSnapshot;
}
