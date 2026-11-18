import { z } from 'zod';
export const CorrectionSchema = z
  .object({
    content: z.string().min(1).max(12000),
    conversationId: z.string().uuid(),
    messageIds: z.array(z.string().uuid()).min(1).max(128),
    expectedRevision: z.number().int().positive().safe(),
    expiresAt: z.string().nullable().optional(),
  })
  .strict();
export const StopSchema = z
  .object({ expectedRevision: z.number().int().positive().safe() })
  .strict();
export const MemorySchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  conversationId: z.string(),
  messageIds: z.array(z.string()),
  content: z.string(),
  sourceKind: z.enum(['explicit', 'compact']),
  summaryId: z.string().nullable(),
  revision: z.number(),
  status: z.enum(['active', 'stopped']),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const MemoryListSchema = z.object({
  items: z.array(MemorySchema),
  nextCursor: z.string().nullable(),
});
export const StoppedSchema = z.object({ id: z.string(), status: z.literal('stopped') });
