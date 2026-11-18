// Owner-visible conversation facts; reading never starts an execution.
import type { ConversationDeps } from '../contracts.js';
import type { ThreadEvent } from '@along/stream-protocol';
import { requirePool } from '../run/run-input.js';
import { ConversationEventsQuerySchema } from '../schemas.js';
import { forbidden, notFound, validationError } from '../../../platform/errors.js';
import { getConversation, listConversationEvents } from '../run/repository.js';
import { requireHistoryRun } from '../history/history-repository.js';

export interface ConversationDetail {
  conversation_id: string;
  status: string;
  confirmed_timezone_id: string | null;
  anchor_received_at_utc: string | null;
  events: ThreadEvent[];
  next_after_seq: number | null;
}

export async function getConversationDetail(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  query: Record<string, string | string[] | undefined>,
): Promise<ConversationDetail> {
  const pool = requirePool(deps);
  const parsed = ConversationEventsQuerySchema.safeParse(query);
  if (!parsed.success) throw validationError('invalid events query');
  const conversation = await getConversation(pool, conversationId);
  if (!conversation) throw notFound('conversation not found');
  if (conversation.owner_id !== ownerId) throw forbidden('conversation not found');
  if (
    parsed.data.run_id &&
    !(await requireHistoryRun(pool, ownerId, conversationId, parsed.data.run_id))
  ) {
    throw notFound('Run not found');
  }
  const events = await listConversationEvents(pool, {
    ownerId,
    conversationId,
    afterSeq: parsed.data.after_seq ?? null,
    limit: parsed.data.limit,
    runId: parsed.data.run_id,
  });
  const last = events.at(-1);
  return {
    conversation_id: conversation.id,
    status: conversation.status,
    confirmed_timezone_id: conversation.confirmed_timezone_id,
    anchor_received_at_utc: conversation.anchor_received_at_utc?.toISOString() ?? null,
    events,
    next_after_seq: last ? last.seq : null,
  };
}
