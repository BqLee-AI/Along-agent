import { z } from 'zod';
import { ExecutionKindSchema, RunModelSelectionSchema, RunStatusSchema } from './harness.js';

// PostgreSQL timestamps are rendered in UTC at their stored microsecond
// precision. Keep them as strings: Date would discard the keyset's last digits.
const utcMicrosecond = z.string().datetime({ precision: 6 });
const uuid = z.string().uuid();
const cursor = z.string().min(1).max(2000);
const limit = z
  .string()
  .regex(/^[0-9]+$/)
  .default('20')
  .transform(Number)
  .pipe(z.number().int().min(1).max(50));
const pageQuery = { cursor: cursor.optional(), limit };

export const ConversationListQuerySchema = z.object(pageQuery).strict();
export const ConversationMessagesQuerySchema = z.object(pageQuery).strict();
export const ConversationRunsQuerySchema = z
  .object({ ...pageQuery, run_id: uuid.optional() })
  .strict()
  .refine((query) => query.run_id === undefined || query.cursor === undefined, {
    message: 'run_id and cursor are mutually exclusive',
  });
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;
export type ConversationMessagesQuery = z.infer<typeof ConversationMessagesQuerySchema>;
export type ConversationRunsQuery = z.infer<typeof ConversationRunsQuerySchema>;

export const ConversationListItemSchema = z
  .object({
    conversation_id: uuid,
    status: z.enum(['open', 'closed']),
    title: z.string(),
    title_message_id: uuid.nullable(),
    created_at: utcMicrosecond,
    last_activity_at: utcMicrosecond.nullable(),
  })
  .strict();
export const MessageHistoryItemSchema = z
  .object({
    message_id: uuid,
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    created_at: utcMicrosecond,
    source_run_id: uuid.optional(),
  })
  .strict();
const originalMessage = z
  .object({ message_id: uuid, content: z.string(), created_at: utcMicrosecond })
  .strict();
export const ConversationRunHistoryItemSchema = z
  .object({
    run_id: uuid,
    conversation_id: uuid,
    execution: ExecutionKindSchema,
    model_selection: RunModelSelectionSchema,
    status: RunStatusSchema,
    created_at: utcMicrosecond,
    ended_at: utcMicrosecond.nullable(),
    original: z.discriminatedUnion('state', [
      z
        .object({
          state: z.literal('available'),
          message: originalMessage,
          source: z.enum(['input_message', 'idempotency_reference']),
        })
        .strict(),
      z.object({ state: z.literal('legacy_unavailable') }).strict(),
      z.object({ state: z.literal('invalid_reference') }).strict(),
    ]),
  })
  .strict();
export const ConversationListPageSchema = z
  .object({ items: z.array(ConversationListItemSchema).max(50), next_cursor: cursor.nullable() })
  .strict();
export const ConversationMessagePageSchema = z
  .object({ items: z.array(MessageHistoryItemSchema).max(50), next_cursor: cursor.nullable() })
  .strict();
export const ConversationRunPageSchema = z
  .object({
    items: z.array(ConversationRunHistoryItemSchema).max(50),
    next_cursor: cursor.nullable(),
  })
  .strict();
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;
export type MessageHistoryItem = z.infer<typeof MessageHistoryItemSchema>;
export type ConversationRunHistoryItem = z.infer<typeof ConversationRunHistoryItemSchema>;
export type ConversationListPage = z.infer<typeof ConversationListPageSchema>;
export type ConversationMessagePage = z.infer<typeof ConversationMessagePageSchema>;
export type ConversationRunPage = z.infer<typeof ConversationRunPageSchema>;
