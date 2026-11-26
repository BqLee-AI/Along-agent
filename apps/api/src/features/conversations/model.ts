import { z } from 'zod';
import { ThreadEventSchema } from '@along/stream-protocol';
export {
  ConversationListPageSchema,
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
  RunViewSchema,
} from '@along/contracts';
export {
  SendMessageBodySchema,
  CancelRunBodySchema,
  ResumeRunBodySchema,
  PauseRunBodySchema,
  ContinueRunBodySchema,
  CompactRunBodySchema,
} from './schemas.js';
export const ConversationBotSchema = z.object({ bot_id: z.string().uuid() }).strict();
export const ConversationDetailSchema = z.object({
  conversation_id: z.string(),
  status: z.string(),
  confirmed_timezone_id: z.string().nullable(),
  anchor_received_at_utc: z.string().nullable(),
  events: z.array(ThreadEventSchema),
  next_after_seq: z.number().nullable(),
});
export const CompactReceiptSchema = z.object({
  status: z.string(),
  run_id: z.string(),
  pause_id: z.string(),
  candidate_status: z.string(),
  error_code: z.string().nullable().optional(),
  candidate_error_code: z.string().optional(),
});
export const IdleCompactResultSchema = z.union([
  CompactReceiptSchema,
  z.object({ status: z.literal('no_content'), run_id: z.null(), pause_id: z.null() }),
]);
export const PauseResultSchema = z.object({
  status: z.enum(['pending', 'paused']),
  pause_id: z.string(),
});
