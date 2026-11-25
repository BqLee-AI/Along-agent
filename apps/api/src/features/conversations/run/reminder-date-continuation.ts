import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  findReminderDirective,
  reminderDateExpression,
  reminderTimezoneReply,
} from '@along/time-core';
import { GoalResultSchema, type RunView } from '@along/contracts';
import { AmbiguousTimeDetailsSchema } from '@along/stream-protocol';

const dateSourceSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['new', 'clarification', 'unresolved']),
    inputMessageId: z.string().uuid(),
    sourceRunId: z.string().uuid().optional(),
    sourceInvocationId: z.string().uuid().optional(),
  })
  .strict();
export type ReminderDateSource = z.infer<typeof dateSourceSchema>;

/** Accepted tool evidence is supplied by the orchestration caller, on this client. */
export interface ReminderDateEvidence {
  listReminderClarifications(
    client: PoolClient,
    ownerId: string,
    conversationId: string,
  ): Promise<
    Array<{ runId: string; invocationId: string; kind: 'timezone' | 'fold'; timezone?: string }>
  >;
  readReminderTimeErrors(
    client: PoolClient,
    binding: { ownerId: string; conversationId: string; runId: string },
  ): Promise<NonNullable<RunView['reminder_time_errors']>>;
}

export async function acceptReminderDate(
  client: PoolClient,
  input: {
    ownerId: string;
    conversationId: string;
    inputMessageId: string;
    text: string;
    receivedAtUtc: string;
    foldChoice: 'first' | 'second' | 'none';
    clarificationOfRunId?: string;
    confirmedTimezone: string | null;
    directCreation?: boolean;
  },
  evidence: ReminderDateEvidence,
): Promise<{
  anchor: string;
  source: ReminderDateSource;
  originalText?: string;
  timezone?: string;
}> {
  const { listReminderClarifications, readReminderTimeErrors } = evidence;
  const fresh = {
    anchor: input.receivedAtUtc,
    source: {
      version: 1 as const,
      kind: 'new' as const,
      inputMessageId: input.inputMessageId,
    },
  };
  const unresolved = { ...fresh, source: { ...fresh.source, kind: 'unresolved' as const } };
  // New delegation messages are independent unless the sender explicitly
  // references a clarification. Legacy date follow-ups retain #103 behavior.
  if (input.directCreation && !input.clarificationOfRunId) return fresh;
  // The predecessor only scopes the search. Its input, actual single tool
  // outcome, terminal state and versioned date source must all prove the relation.
  const { rows } = await client.query<{
    id: string | null;
    status: string | null;
    content: string;
    frozen_context: { anchorReceivedAtUtc?: string; reminderDateSource?: unknown } | null;
    goal_result: unknown;
    tools_allowlist: string[];
  }>(
    `WITH predecessor AS (
       SELECT id,content FROM messages WHERE owner_id=$1 AND conversation_id=$2 AND role='user' AND id<>$3
       ORDER BY created_at DESC,id DESC LIMIT 1
     ) SELECT r.id,r.status,r.frozen_context,r.goal_result,r.tools_allowlist,m.content FROM predecessor m
       LEFT JOIN agent_runs r ON r.input_message_id=m.id AND r.owner_id=$1 AND r.conversation_id=$2`,
    [input.ownerId, input.conversationId, input.inputMessageId],
  );
  const prior = rows.length === 1 ? rows[0] : undefined;
  const timezone = reminderTimezoneReply(input.text);
  if (!prior?.id || !['done', 'failed'].includes(prior.status ?? ''))
    return input.clarificationOfRunId || timezone ? unresolved : fresh;
  if (
    !input.clarificationOfRunId &&
    input.foldChoice === 'none' &&
    input.text !== prior.content &&
    reminderDateExpression(input.text) &&
    findReminderDirective(input.text) >= 0
  )
    return fresh;
  if (
    input.directCreation &&
    input.clarificationOfRunId === prior.id &&
    prior.tools_allowlist.includes('create_reminder')
  ) {
    const goal = GoalResultSchema.safeParse(prior.goal_result);
    const source = dateSourceSchema.safeParse(prior.frozen_context?.reminderDateSource);
    const eligible = await client.query<{ id: string }>(
      `SELECT r.id FROM agent_runs r WHERE r.owner_id=$1 AND r.conversation_id=$2
       AND r.status='done' AND r.tools_allowlist ? 'create_reminder'
       AND r.goal_result->>'status' IN ('blocked','partial')
       AND r.goal_result->'clarification'->>'kind' IN ('time','timezone')
       AND NOT EXISTS (SELECT 1 FROM agent_runs next WHERE next.owner_id=$1
         AND next.conversation_id=$2
         AND next.frozen_context->'reminderDateSource'->>'sourceRunId'=r.id::text)`,
      [input.ownerId, input.conversationId],
    );
    if (
      !goal.success ||
      !goal.data.clarification ||
      !['time', 'timezone'].includes(goal.data.clarification.kind) ||
      !['blocked', 'partial'].includes(goal.data.status) ||
      !source.success ||
      source.data.kind === 'unresolved' ||
      eligible.rows.length !== 1 ||
      eligible.rows[0]!.id !== prior.id
    )
      return unresolved;
    const original = (
      await client.query<{ content: string }>(
        `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
        [source.data.inputMessageId, input.ownerId, input.conversationId],
      )
    ).rows[0]?.content;
    const anchor = prior.frozen_context?.anchorReceivedAtUtc;
    if (!original || !anchor) return unresolved;
    let sourceInvocationId: string | undefined;
    if (input.foldChoice !== 'none') {
      if (input.text !== prior.content) return unresolved;
      const errors = await readReminderTimeErrors(client, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        runId: prior.id,
      });
      const ambiguities = errors
        .filter((item) => item.error.code === 'AMBIGUOUS_LOCAL_TIME')
        .map((item) => ({
          invocationId: item.invocation_id,
          details: AmbiguousTimeDetailsSchema.safeParse(item.error.details),
        }));
      const first = ambiguities[0];
      if (
        !first?.details.success ||
        input.confirmedTimezone !== first.details.data.timezone_id ||
        ambiguities.some((item) => !item.details.success) ||
        new Set(ambiguities.map((item) => JSON.stringify(item.details))).size !== 1
      )
        return unresolved;
      sourceInvocationId = first.invocationId;
    }
    return {
      anchor,
      source: {
        version: 1,
        kind: 'clarification',
        inputMessageId: source.data.inputMessageId,
        sourceRunId: prior.id,
        ...(sourceInvocationId ? { sourceInvocationId } : {}),
      },
      originalText: original,
      ...(timezone ? { timezone } : {}),
    };
  }
  const parsed = dateSourceSchema.safeParse(prior.frozen_context?.reminderDateSource);
  const candidates = await listReminderClarifications(client, input.ownerId, input.conversationId);
  const eligible = candidates.length
    ? (
        await client.query<{ id: string }>(
          `SELECT r.id FROM agent_runs r WHERE r.owner_id=$1 AND r.conversation_id=$2
       AND r.id=ANY($3::uuid[]) AND r.status IN ('done','failed')
       AND NOT EXISTS (SELECT 1 FROM agent_runs next WHERE next.owner_id=$1 AND next.conversation_id=$2
         AND next.frozen_context->'reminderDateSource'->>'sourceRunId'=r.id::text)`,
          [input.ownerId, input.conversationId, candidates.map((candidate) => candidate.runId)],
        )
      ).rows
    : [];
  const outcome =
    eligible.length === 1 && eligible[0].id === prior.id
      ? candidates.find((candidate) => candidate.runId === prior.id)
      : undefined;
  if (!parsed.success || parsed.data.kind === 'unresolved' || !outcome)
    return input.clarificationOfRunId ||
      timezone ||
      (candidates.some((candidate) => candidate.runId === prior.id) &&
        reminderDateExpression(prior.content) &&
        reminderDateExpression(input.text))
      ? unresolved
      : fresh;
  const original = (
    await client.query<{ content: string }>(
      `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
      [parsed.data.inputMessageId, input.ownerId, input.conversationId],
    )
  ).rows[0]?.content;
  const anchor = prior.frozen_context?.anchorReceivedAtUtc;
  if (!original || !anchor) return unresolved;
  if (!reminderDateExpression(original))
    return !input.clarificationOfRunId && reminderDateExpression(input.text) ? fresh : unresolved;
  const requestedSource = input.clarificationOfRunId;
  const sameText = input.text === original;
  const sameRequest = requestedSource === undefined || requestedSource === prior.id;
  const valid =
    sameRequest &&
    ((outcome.kind === 'timezone' && timezone !== null && input.foldChoice === 'none') ||
      (outcome.kind === 'fold' &&
        requestedSource === prior.id &&
        sameText &&
        input.foldChoice !== 'none' &&
        input.confirmedTimezone === outcome.timezone));
  if (!valid)
    return requestedSource ||
      input.foldChoice !== 'none' ||
      timezone ||
      sameText ||
      reminderDateExpression(input.text)
      ? unresolved
      : fresh;
  return {
    anchor,
    source: {
      version: 1,
      kind: 'clarification',
      inputMessageId: parsed.data.inputMessageId,
      sourceRunId: prior.id,
      sourceInvocationId: outcome.invocationId,
    },
    originalText: original,
    ...(timezone ? { timezone } : {}),
  };
}

// Tool consumers and recovery read the accepted Run's source, never current
// conversation history or the wall clock. Legacy Runs retain their old contract.
export async function readReminderDateInput(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string },
): Promise<{
  source: ReminderDateSource;
  originalText: string;
  clarificationText?: string;
} | null> {
  const row = (
    await client.query<{ source: unknown }>(
      `SELECT frozen_context->'reminderDateSource' AS source FROM agent_runs
     WHERE id=$1 AND owner_id=$2 AND conversation_id=$3`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!row) throw new Error('reminder Run missing');
  if (row.source === null) return null;
  const source = dateSourceSchema.parse(row.source);
  const message = (
    await client.query<{ content: string }>(
      `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
      [source.inputMessageId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!message) throw new Error('frozen reminder input missing');
  if (source.kind === 'clarification') {
    const inputs = await client.query<{ content: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id,input_message_id,frozen_context,ARRAY[id] AS visited FROM agent_runs
         WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
         UNION ALL
         SELECT prior.id,prior.input_message_id,prior.frozen_context,chain.visited || prior.id
         FROM chain JOIN agent_runs prior
           ON prior.id::text=chain.frozen_context->'reminderDateSource'->>'sourceRunId'
         WHERE prior.owner_id=$2 AND prior.conversation_id=$3 AND NOT prior.id=ANY(chain.visited)
       ) SELECT m.content FROM chain JOIN messages m ON m.id=chain.input_message_id
         WHERE m.owner_id=$2 AND m.conversation_id=$3 AND m.role='user'
         ORDER BY cardinality(chain.visited) DESC`,
      [binding.runId, binding.ownerId, binding.conversationId],
    );
    return {
      source,
      originalText: message.content,
      clarificationText: inputs.rows.map((input) => input.content).join('\n'),
    };
  }
  return { source, originalText: message.content };
}
