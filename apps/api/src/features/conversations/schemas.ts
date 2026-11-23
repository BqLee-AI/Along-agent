// Conversation HTTP contracts (issue #9): docs/api/conversations.
import { z } from 'zod';
import {
  LearnDocsQuerySchema,
  ModelSelectionSchema,
  workspaceSummarySchema,
} from '@along/contracts';

export const SendMessageBodySchema = z
  .object({
    conversation_id: z.string().uuid().optional(),
    execution: z.enum(['business', 'harness']).optional(),
    model_selection: ModelSelectionSchema.optional(),
    authorization_revision: z.literal('delegation/1').optional(),
    workspace_id: workspaceSummarySchema.shape.workspace_id.optional(),
    workspace_ids: z
      .array(workspaceSummarySchema.shape.workspace_id)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    raw_text: z.string().min(1).max(20000),
    microsoft_learn_query: LearnDocsQuerySchema.optional(),
    card_ref: z.string().min(1).max(200).optional(),
    confirmed_timezone_id: z.string().min(1).max(100).nullable().optional(),
    confirmed_timezone: z.string().min(1).max(100).nullable().optional(),
    fold_choice: z.enum(['first', 'second', 'none']).default('none'),
    clarification_of_run_id: z.string().uuid().optional(),
    idempotency_key: z.string().uuid().optional(),
    client_sent_at: z.string().max(100).optional(),
  })
  .strict()
  .refine((input) => input.model_selection === undefined || input.execution === 'harness', {
    message: 'model_selection requires harness execution',
    path: ['model_selection'],
  })
  .refine((input) => input.workspace_id === undefined || input.execution === 'harness', {
    message: 'workspace_id requires harness execution',
    path: ['workspace_id'],
  })
  .refine(
    (input) =>
      input.authorization_revision === undefined ||
      (input.execution === 'harness' && input.workspace_id === undefined),
    {
      message: 'delegation/1 currently requires non-workspace harness execution',
      path: ['authorization_revision'],
    },
  )
  .refine(
    (input) =>
      input.workspace_ids === undefined ||
      (input.execution === 'harness' &&
        input.authorization_revision === 'delegation/1' &&
        input.workspace_id === undefined),
    { message: 'workspace_ids requires delegation harness execution', path: ['workspace_ids'] },
  )
  .refine(
    (input) =>
      input.microsoft_learn_query === undefined ||
      (input.execution === 'harness' &&
        input.authorization_revision === 'delegation/1' &&
        input.microsoft_learn_query === input.raw_text &&
        input.workspace_id === undefined &&
        input.workspace_ids === undefined &&
        input.card_ref === undefined &&
        input.clarification_of_run_id === undefined),
    {
      message: 'Microsoft Learn requires an explicit standalone query matching raw_text',
      path: ['microsoft_learn_query'],
    },
  );

export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;

export const ConversationEventsQuerySchema = z
  .object({
    after_seq: z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative().safe())
      .optional(),
    limit: z
      .string()
      .regex(/^[0-9]+$/)
      .default('200')
      .transform(Number)
      .pipe(z.number().int().min(1).max(500)),
    run_id: z.string().uuid().optional(),
  })
  .strict();

export const HistoryCursorSchema = z
  .object({
    v: z.literal('1'),
    kind: z.enum(['conversations', 'messages', 'runs']),
    owner: z.string().uuid(),
    parent: z.union([z.string().uuid(), z.literal('')]),
    upper_at: z.string().datetime({ precision: 6 }),
    upper_id: z.string().uuid(),
    last_at: z.string().datetime({ precision: 6 }),
    last_id: z.string().uuid(),
  })
  .strict()
  .refine(
    (cursor) =>
      (cursor.kind === 'conversations') === (cursor.parent === '') &&
      (cursor.last_at < cursor.upper_at ||
        (cursor.last_at === cursor.upper_at &&
          cursor.last_id.toLowerCase() <= cursor.upper_id.toLowerCase())),
    { message: 'invalid cursor boundary' },
  );
export type HistoryCursor = z.infer<typeof HistoryCursorSchema>;

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

export const PauseRunBodySchema = z
  .object({
    reason: z.literal('user'),
    purpose: z.literal('none'),
  })
  .strict();
export const ContinueRunBodySchema = z.object({ pause_id: z.string().uuid() }).strict();
export const ActionKeySchema = z.string().uuid();
export const CompactRunBodySchema = z.object({}).strict();
