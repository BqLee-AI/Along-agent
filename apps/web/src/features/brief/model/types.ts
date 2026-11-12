import { ElapsedTimeBasisSchema } from '@along/contracts';
import { z } from 'zod';

// Accept future card kinds and versions so presentation can retain a safe title
// without interpreting unsupported structured fields.
export const BriefCardSchema = z
  .object({
    card_id: z.string().min(1).max(200),
    kind: z.string().min(1),
    schema_version: z.number().int().positive(),
    title: z.string().max(200),
    status: z.string().min(1).max(40).optional(),
    fire_at_local: z.string().min(1).max(60).optional(),
    timezone_id: z.string().min(1).max(100).optional(),
    time_basis: ElapsedTimeBasisSchema.nullable().optional(),
    display_version: z.literal('elapsed/1').nullable().optional(),
    ref: z
      .object({
        task_id: z.string().uuid().optional(),
        approval_id: z.string().uuid().optional(),
      })
      .optional(),
  })
  .superRefine((card, context) => {
    if (card.schema_version !== 1) return;
    if (card.kind === 'task' && (!card.status || !card.fire_at_local || !card.ref?.task_id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '提醒卡片缺少可核验的记录字段。' });
    }
    if (card.kind === 'approval' && (card.status !== 'pending' || !card.ref?.approval_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '待确认卡片缺少可核验的记录字段。',
      });
    }
  });
export type BriefCard = z.infer<typeof BriefCardSchema>;

export const BriefSchema = z.object({
  date: z.string().date(),
  timezone_id: z.string().min(1).max(100),
  summary: z.object({
    pending_count: z.number().int().nonnegative(),
    fired_count: z.number().int().nonnegative(),
  }),
  cards: z.array(BriefCardSchema),
  meta: z.object({
    brief_state: z.enum(['empty', 'day-in-progress', 'stale']),
    stale_reason: z.string().max(200).nullable().optional(),
    timezone_note: z.string().max(200).nullable(),
  }),
});
export type Brief = z.infer<typeof BriefSchema>;
