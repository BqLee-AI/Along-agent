import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  findReminderDirective,
  reminderDateExpression,
  reminderTimezoneReply,
} from '@along/time-core';
import { listReminderClarifications } from '../tools/reminder-source.js';

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
  },
): Promise<{
  anchor: string;
  source: ReminderDateSource;
  originalText?: string;
  timezone?: string;
}> {
  const fresh = {
    anchor: input.receivedAtUtc,
    source: {
      version: 1 as const,
      kind: 'new' as const,
      inputMessageId: input.inputMessageId,
    },
  };
  const unresolved = { ...fresh, source: { ...fresh.source, kind: 'unresolved' as const } };
  // The predecessor only scopes the search. Its input, actual single tool
  // outcome, terminal state and versioned date source must all prove the relation.
  const { rows } = await client.query<{
    id: string | null;
    status: string | null;
    content: string;
    frozen_context: { anchorReceivedAtUtc?: string; reminderDateSource?: unknown } | null;
  }>(
    `WITH predecessor AS (
       SELECT id,content FROM messages WHERE owner_id=$1 AND conversation_id=$2 AND role='user' AND id<>$3
       ORDER BY created_at DESC,id DESC LIMIT 1
     ) SELECT r.id,r.status,r.frozen_context,m.content FROM predecessor m
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
): Promise<{ source: ReminderDateSource; originalText: string } | null> {
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
  return { source, originalText: message.content };
}
