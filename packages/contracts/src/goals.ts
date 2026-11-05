import { z } from 'zod';
import { workspaceSummarySchema } from './workspaces.js';

const uuid = z.string().uuid();
const text = z.string().min(1).max(8192);
export const ElapsedTimeBasisSchema = z
  .object({
    kind: z.literal('elapsed'),
    anchor_utc: z.string().datetime({ precision: 0 }),
    duration_seconds: z.number().int().positive().safe(),
    source_message_id: uuid,
    revision: z.literal('elapsed/1'),
  })
  .strict();
export type ElapsedTimeBasis = z.infer<typeof ElapsedTimeBasisSchema>;

export const GoalResultSchema = z
  .object({
    status: z.enum(['completed', 'partial', 'blocked', 'cancelled', 'unknown']),
    outcomes: z
      .array(
        z
          .object({
            description: text,
            status: z.enum(['achieved', 'not_done', 'blocked', 'unknown']),
            receipt_refs: z
              .array(uuid)
              .max(64)
              .refine((refs) => new Set(refs).size === refs.length),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    clarification: z
      .object({
        kind: z.enum(['time', 'timezone', 'target_selection', 'destination']),
        question: text,
      })
      .strict()
      .nullable(),
    answer: text,
  })
  .strict()
  .superRefine((goal, ctx) => {
    const achieved = goal.outcomes.some((item) => item.status === 'achieved');
    const unknown = goal.outcomes.some((item) => item.status === 'unknown');
    if (
      (goal.status === 'completed' &&
        (goal.outcomes.some((item) => item.status !== 'achieved') ||
          goal.clarification !== null)) ||
      (goal.status === 'partial' &&
        (!achieved || unknown || goal.outcomes.every((item) => item.status === 'achieved'))) ||
      (goal.status === 'blocked' && (achieved || unknown)) ||
      (unknown && goal.status !== 'unknown' && goal.status !== 'cancelled')
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'goal status contradicts its outcomes',
      });
    if (
      (goal.status === 'unknown' && !unknown) ||
      (goal.clarification !== null && goal.status !== 'partial' && goal.status !== 'blocked')
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'goal clarification or unknown status contradicts outcomes',
      });
  });
const continuationResultSchema = z
  .object({
    invocation_id: uuid,
    tool_id: z.string().min(1).max(128),
    result: z.record(z.unknown()),
  })
  .strict();

export const TrustedExecutionContextSchema = z
  .object({
    version: z.literal(1),
    authorization_revision: z.literal('delegation/1'),
    execution_lifecycle: z.literal('request-bound'),
    input_message_id: uuid,
    received_at_utc: z.string().datetime({ precision: 0 }),
    request_anchor_utc: z.string().datetime({ precision: 0 }),
    continuation: z
      .union([
        z.object({ run_id: uuid, invocation_id: uuid.nullable() }).strict(),
        z
          .object({
            run_id: uuid,
            invocation_id: uuid.nullable(),
            original_input_message_id: uuid,
            original_text: z.string().min(1).max(20000),
            goal_result: GoalResultSchema.nullable(),
            receipts: z.array(continuationResultSchema).max(4096),
            source_result: continuationResultSchema.nullable(),
          })
          .strict(),
      ])
      .nullable(),
    timezone: z
      .object({
        timezone_id: z.string().min(1).max(512),
        source: z.enum(['explicit', 'preference']),
        reference: z.string().min(1).max(128),
      })
      .strict()
      .nullable(),
    time_capabilities: z
      .object({
        elapsed_revision: z.literal('elapsed/1').nullable(),
        wall_rules: z
          .object({
            ruleset_id: z.string().min(1).max(128),
            tzdb_version: z.string().min(1).max(128),
            alias_version: z.string().min(1).max(128),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    workspaces: z.array(workspaceSummarySchema),
  })
  .strict();
export type GoalResult = z.infer<typeof GoalResultSchema>;
export type TrustedExecutionContext = z.infer<typeof TrustedExecutionContextSchema>;
