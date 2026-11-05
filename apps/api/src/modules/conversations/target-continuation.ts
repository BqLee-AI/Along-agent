import type { PoolClient } from 'pg';
import { GoalResultSchema } from '@along/contracts';
import type { TimeContext } from '../time/context.js';
import type { ToolContext } from '../tools/contracts.js';
import {
  readInvocationSnapshots,
  readRunInvocationStates,
  type InvocationSnapshot,
} from '../tools/invocations.js';
import { stateConflict } from '../../http/errors.js';
import {
  readShownCancellationCandidates,
  type CancellationCandidate,
} from '../tools/reminder-cancel-scope.js';

type Binding = { ownerId: string; conversationId: string };
type Frozen = {
  authorization_revision?: 'delegation/1';
  anchorReceivedAtUtc?: string;
  receivedAtUtc?: string;
  confirmedTimezone?: string | null;
  foldChoice?: 'first' | 'second' | 'none';
  reminderDateSource?: { inputMessageId?: string };
  trustedExecutionContext?: { continuation?: { run_id: string } | null };
};

// The caller holds the conversation admission lock. Only immutable, completed
// predecessor results are read; no Run lock is taken out of attempt order.
export async function acceptTargetContinuation(
  client: PoolClient,
  input: Binding & {
    sourceRunId: string;
    inputMessageId: string;
    timeContext: TimeContext;
    kind?: 'target_selection' | 'time' | 'timezone';
    sourceInvocationId?: string;
  },
) {
  const prior = (
    await client.query<{
      id: string;
      status: string;
      input_message_id: string;
      goal_result: unknown;
      frozen_context: Frozen;
      tools_allowlist: string[];
    }>(
      `WITH previous AS (
      SELECT id FROM messages WHERE owner_id=$1 AND conversation_id=$2 AND role='user' AND id<>$3
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) SELECT r.id,r.status,r.input_message_id,r.goal_result,r.frozen_context,r.tools_allowlist
      FROM previous p JOIN agent_runs r ON r.input_message_id=p.id
      WHERE r.owner_id=$1 AND r.conversation_id=$2`,
      [input.ownerId, input.conversationId, input.inputMessageId],
    )
  ).rows;
  if (prior.length !== 1 || prior[0]!.id !== input.sourceRunId) return null;
  const run = prior[0]!;
  const goal = GoalResultSchema.safeParse(run.goal_result);
  if (
    run.status !== 'done' ||
    run.frozen_context?.authorization_revision !== 'delegation/1' ||
    !run.tools_allowlist.includes('get_task') ||
    !run.tools_allowlist.includes('cancel_reminder') ||
    !goal.success ||
    !['blocked', 'partial'].includes(goal.data.status) ||
    goal.data.clarification?.kind !== (input.kind ?? 'target_selection')
  )
    return null;
  const candidates = await client.query<{ id: string }>(
    `SELECT r.id FROM agent_runs r
    WHERE r.owner_id=$1 AND r.conversation_id=$2 AND r.status='done'
      AND r.frozen_context->>'authorization_revision'='delegation/1'
      AND r.tools_allowlist ? 'get_task' AND r.tools_allowlist ? 'cancel_reminder'
      AND r.goal_result->>'status' IN ('blocked','partial')
      AND r.goal_result->'clarification'->>'kind'=$3
      AND NOT EXISTS (SELECT 1 FROM agent_runs n WHERE n.owner_id=$1 AND n.conversation_id=$2
        AND (n.frozen_context->'trustedExecutionContext'->'continuation'->>'run_id'=r.id::text
          OR n.frozen_context->'reminderDateSource'->>'sourceRunId'=r.id::text))`,
    [input.ownerId, input.conversationId, input.kind ?? 'target_selection'],
  );
  if (candidates.rows.length !== 1 || candidates.rows[0]!.id !== run.id) return null;
  const previousContinuation = run.frozen_context.trustedExecutionContext?.continuation;
  const originalId =
    previousContinuation && 'original_input_message_id' in previousContinuation
      ? String(previousContinuation.original_input_message_id)
      : run.frozen_context.reminderDateSource?.inputMessageId;
  if (!originalId) return null;
  const original = (
    await client.query<{ content: string }>(
      `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
      [originalId, input.ownerId, input.conversationId],
    )
  ).rows[0];
  if (!original) return null;
  const achieved = new Set(
    goal.data.outcomes.filter((o) => o.status === 'achieved').flatMap((o) => o.receipt_refs),
  );
  const refs = [...new Set(goal.data.outcomes.flatMap((o) => o.receipt_refs))];
  const snapshots = await readContinuationReceipts(client, input, run.id, refs, input.timeContext);
  const receipts = snapshots.filter(
    (snapshot) =>
      achieved.has(snapshot.invocation_id) ||
      (snapshot.tool_id === 'cancel_reminder' &&
        snapshot.result.status === 'ok' &&
        snapshot.result.result.kind === 'reminder_cancelled'),
  );
  const sourceResult = input.sourceInvocationId
    ? ((
        await readContinuationReceipts(
          client,
          input,
          run.id,
          [input.sourceInvocationId],
          input.timeContext,
        )
      )[0] ?? null)
    : null;
  return {
    continuation: {
      run_id: run.id,
      invocation_id: input.sourceInvocationId ?? null,
      original_input_message_id: originalId,
      original_text: original.content,
      goal_result: goal.data,
      receipts,
      source_result: sourceResult,
    },
    anchor: run.frozen_context.anchorReceivedAtUtc,
  };
}

// Read only the admitted user input and server-frozen predecessor, never a
// model-provided quote. The predecessor text does not itself select a target.
export async function readCancellationScopeInput(
  client: PoolClient,
  binding: Binding & { runId: string },
): Promise<{
  current: string;
  original: string | null;
  revision: string | null;
  shownCandidates: CancellationCandidate[];
}> {
  const row = (
    await client.query<{
      current: string;
      original: string | null;
      revision: string | null;
      goal: unknown;
      snapshot_original: string | null;
      snapshot_question: string | null;
    }>(
      `SELECT m.content AS current,
        r.frozen_context->'trustedExecutionContext'->'continuation'->>'original_text' AS original,
        r.frozen_context->>'cancellationScopeRevision' AS revision,
        r.frozen_context->'trustedExecutionContext'->'continuation'->'goal_result' AS goal,
        source.cancellation_scope_candidates->>'original' AS snapshot_original,
        source.cancellation_scope_candidates->>'question' AS snapshot_question
       FROM agent_runs r JOIN messages m ON m.id=r.input_message_id
       LEFT JOIN agent_runs source ON source.id::text=r.frozen_context->'trustedExecutionContext'->'continuation'->>'run_id'
         AND source.owner_id=r.owner_id AND source.conversation_id=r.conversation_id
       WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3
         AND m.owner_id=$2 AND m.conversation_id=$3 AND m.role='user'`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!row) throw stateConflict('cancellation input missing');
  const goal = GoalResultSchema.safeParse(row.goal);
  const shownCandidates =
    row.original &&
    row.original === row.snapshot_original &&
    row.snapshot_question &&
    goal.success &&
    goal.data.clarification?.kind === 'target_selection' &&
    goal.data.answer === row.snapshot_question
      ? readShownCancellationCandidates(row.snapshot_question)
      : [];
  return { current: row.current, original: row.original, revision: row.revision, shownCandidates };
}

// Walk only the frozen, already-admitted predecessor chain. Historical receipts
// remain historical facts and are never supplied as this Run's observations.
export async function readContinuationReceipts(
  client: PoolClient,
  binding: Binding,
  runId: string,
  refs: readonly string[],
  timeContext: TimeContext,
): Promise<InvocationSnapshot[]> {
  if (refs.length > 4096) throw stateConflict('too many continuation receipts');
  const remaining = new Set(refs);
  const receipts: InvocationSnapshot[] = [];
  const visited = new Set<string>();
  let current: string | undefined = runId;
  while (current && remaining.size) {
    if (visited.has(current)) throw stateConflict('invalid continuation chain');
    visited.add(current);
    const row: { frozen_context: Frozen; tools_allowlist: string[] } | undefined = (
      await client.query<{ frozen_context: Frozen; tools_allowlist: string[] }>(
        `SELECT frozen_context,tools_allowlist FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3`,
        [current, binding.ownerId, binding.conversationId],
      )
    ).rows[0];
    if (!row || row.frozen_context?.authorization_revision !== 'delegation/1')
      throw stateConflict('invalid continuation receipt source');
    const own = (await readRunInvocationStates(client, { ...binding, runId: current }))
      .filter((r) => remaining.has(r.invocation_id))
      .map((r) => r.invocation_id);
    if (own.length) {
      const f = row.frozen_context;
      const ctx: ToolContext = {
        ...binding,
        runId: current,
        attemptId: '',
        requestId: '',
        allowlist: row.tools_allowlist,
        authorizationRevision: 'delegation/1',
        confirmedTimezone: f.confirmedTimezone ?? null,
        anchorReceivedAtUtc: f.anchorReceivedAtUtc ?? '',
        receivedAtUtc: f.receivedAtUtc ?? '',
        foldChoice: f.foldChoice ?? 'none',
        timeContext,
      };
      const found = await readInvocationSnapshots(client, ctx, own);
      if (found.some((r) => r.result.status !== 'ok'))
        throw stateConflict('continuation receipt unsuccessful');
      for (const receipt of found) {
        receipts.push(receipt);
        remaining.delete(receipt.invocation_id);
      }
    }
    current = row.frozen_context.trustedExecutionContext?.continuation?.run_id;
  }
  if (remaining.size) throw stateConflict('continuation receipt missing');
  return receipts;
}
