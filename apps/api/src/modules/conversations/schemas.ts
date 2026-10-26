// Conversation HTTP contracts (issue #9): docs/api/conversations.
import { z } from 'zod';
import { workspaceSummarySchema } from '@along/contracts';

export const SendMessageBodySchema = z
  .object({
    conversation_id: z.string().uuid().optional(),
    execution: z.enum(['business', 'harness']).optional(),
    workspace_id: workspaceSummarySchema.shape.workspace_id.optional(),
    raw_text: z.string().min(1).max(20000),
    card_ref: z.string().min(1).max(200).optional(),
    confirmed_timezone_id: z.string().min(1).max(100).nullable().optional(),
    confirmed_timezone: z.string().min(1).max(100).nullable().optional(),
    fold_choice: z.enum(['first', 'second', 'none']).default('none'),
    idempotency_key: z.string().uuid().optional(),
    client_sent_at: z.string().max(100).optional(),
  })
  .strict()
  .refine((input) => input.workspace_id === undefined || input.execution === 'harness', {
    message: 'workspace_id requires harness execution',
    path: ['workspace_id'],
  });

export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;

export const ConversationEventsQuerySchema = z.object({
  after_seq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const CancelRunBodySchema = z
  .object({
    idempotency_key: z.string().uuid(),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

export const ResumeRunBodySchema = z
  .object({
    checkpoint_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
  })
  .strict();
