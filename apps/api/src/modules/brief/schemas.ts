// Brief HTTP/domain contracts (issue #10).
// Source: docs/api/brief/brief_routes.md. v0 is a read-only projection of
// tasks + approvals; there is no briefs/cards table and no LLM generation.
import { z } from 'zod';

const DateTextSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const probe = new Date(Date.UTC(year, month - 1, day));
    return (
      probe.getUTCFullYear() === year &&
      probe.getUTCMonth() === month - 1 &&
      probe.getUTCDate() === day
    );
  }, 'date is not a calendar day');

export const BriefQuerySchema = z
  .object({
    date: DateTextSchema.optional(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .strict();

export type BriefQuery = z.infer<typeof BriefQuerySchema>;

const CardBase = {
  card_id: z.string().min(1).max(200),
  schema_version: z.literal(1),
  title: z.string().max(200),
};

export const TaskCardSchema = z
  .object({
    ...CardBase,
    kind: z.literal('task'),
    status: z.string().min(1).max(40),
    fire_at_local: z.string().min(1).max(60),
    ref: z.object({ task_id: z.string().uuid() }).strict(),
  })
  .strict();

export const ApprovalCardSchema = z
  .object({
    ...CardBase,
    kind: z.literal('approval'),
    status: z.literal('pending'),
    ref: z.object({ approval_id: z.string().uuid() }).strict(),
  })
  .strict();

// Degraded local card for an entry that failed validation. Never carries the
// unvalidated payload; the title is a fixed safe string.
export const TextCardSchema = z
  .object({
    ...CardBase,
    kind: z.literal('text'),
  })
  .strict();

export const BriefCardSchema = z.discriminatedUnion('kind', [
  TaskCardSchema,
  ApprovalCardSchema,
  TextCardSchema,
]);

export type BriefCard = z.infer<typeof BriefCardSchema>;
export type TaskCard = z.infer<typeof TaskCardSchema>;
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>;

export const BriefResponseSchema = z
  .object({
    date: DateTextSchema,
    timezone_id: z.string().min(1).max(100),
    summary: z
      .object({
        pending_count: z.number().int().nonnegative(),
        fired_count: z.number().int().nonnegative(),
      })
      .strict(),
    cards: z.array(BriefCardSchema),
    meta: z
      .object({
        brief_state: z.enum(['empty', 'day-in-progress', 'stale']),
        stale_reason: z.string().max(200).nullable().optional(),
        timezone_note: z.string().max(200).nullable(),
      })
      .strict(),
  })
  .strict();

export type BriefResponse = z.infer<typeof BriefResponseSchema>;
