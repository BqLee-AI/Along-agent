import { z } from 'zod';

export const HARNESS_PROTOCOL_VERSION = 'harness/v1' as const;
export const HARNESS_MAX_FRAME_BYTES = 1024 * 1024;

const uuid = z.string().uuid();
const reference = z.string().min(1).max(128);
const text = z.string().max(HARNESS_MAX_FRAME_BYTES);
const args = z.record(z.unknown());
export const ExecutionKindSchema = z.enum(['business', 'harness']);
export const RunStatusSchema = z.enum([
  'running',
  'suspended_approval',
  'done',
  'failed',
  'cancelled',
]);
export const HarnessUsageSchema = z
  .object({
    iterations: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const HarnessSnapshotSchema = z
  .object({
    version: z.literal(1),
    message_refs: z.array(uuid).max(64),
    tool_refs: z.array(uuid).max(64),
    next_call_no: z.number().int().positive(),
    usage: HarnessUsageSchema,
    waiting: z.object({ invocation_id: uuid, approval_id: uuid }).strict().nullable(),
  })
  .strict();
export const HarnessToolSchema = z
  .object({
    name: reference,
    description: z.string().max(8192),
    parameters: args,
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export const HarnessModelMessageSchema = z
  .object({ role: z.enum(['system', 'user', 'assistant']), content: text })
  .strict();
export const HarnessModelReplySchema = z
  .object({
    message: z
      .object({
        content: text.nullable(),
        tool_calls: z
          .array(
            z
              .object({
                id: reference,
                type: z.literal('function'),
                function: z.object({ name: reference, arguments: text }).strict(),
              })
              .strict(),
          )
          .max(1),
      })
      .strict(),
    usage: z.object({ total_tokens: z.number().int().nonnegative() }).strict().nullable(),
  })
  .strict();
const request = {
  protocol: z.literal(HARNESS_PROTOCOL_VERSION),
  request_ref: reference,
};
export const HarnessRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...request,
      type: z.literal('model'),
      messages: z.array(HarnessModelMessageSchema).min(1).max(256),
      remaining_tokens: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...request,
      type: z.literal('reserve'),
      call_key: reference,
      tool_id: reference,
      args,
    })
    .strict(),
  z
    .object({
      ...request,
      type: z.literal('invoke'),
      invocation_id: uuid,
      tool_id: reference,
      args,
    })
    .strict(),
  z.object({ ...request, type: z.literal('snapshot'), context: HarnessSnapshotSchema }).strict(),
  z
    .object({
      ...request,
      type: z.literal('suspend'),
      checkpoint_ref: uuid,
      invocation_id: uuid,
      approval_id: uuid,
    })
    .strict(),
  z.object({ ...request, type: z.literal('answer'), delta: text }).strict(),
  z
    .object({
      ...request,
      type: z.literal('finish'),
      outcome: z.enum(['done', 'failed', 'cancelled']),
      usage: HarnessUsageSchema,
      error: z
        .object({ code: reference, message: z.string().max(8192) })
        .strict()
        .optional(),
    })
    .strict(),
]);
export const HarnessApprovalDecisionSchema = z
  .object({
    approval_id: uuid,
    status: z.enum(['pending', 'consumed', 'rejected', 'expired', 'superseded']),
    task_id: uuid.nullable(),
    successor_id: uuid.nullable(),
  })
  .strict();
export const HarnessStartSchema = z
  .object({
    protocol: z.literal(HARNESS_PROTOCOL_VERSION),
    type: z.literal('start'),
    messages: z
      .array(
        z.object({ message_id: uuid, role: z.enum(['user', 'assistant']), content: text }).strict(),
      )
      .min(1)
      .max(64),
    tools: z.array(HarnessToolSchema).max(64),
    budget: z
      .object({
        max_iterations: z.number().int().positive(),
        max_tokens: z.number().int().positive(),
      })
      .strict(),
    snapshot: HarnessSnapshotSchema.nullable(),
    observations: z
      .array(z.object({ invocation_id: uuid, tool_id: reference, result: z.unknown() }).strict())
      .max(64),
    approval: HarnessApprovalDecisionSchema.nullable(),
  })
  .strict();
export const HarnessReplySchema = z.union([
  z
    .object({
      protocol: z.literal(HARNESS_PROTOCOL_VERSION),
      type: z.literal('reply'),
      reply_to: reference,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(HARNESS_PROTOCOL_VERSION),
      type: z.literal('reply'),
      reply_to: reference,
      error: z.object({ code: reference, message: z.string().max(8192) }).strict(),
    })
    .strict(),
]);
export const HarnessCancelSchema = z
  .object({
    protocol: z.literal(HARNESS_PROTOCOL_VERSION),
    type: z.literal('cancel'),
    reason: z.string().max(512),
  })
  .strict();
export const RunViewSchema = z
  .object({
    run_id: uuid,
    conversation_id: uuid,
    execution: ExecutionKindSchema,
    status: RunStatusSchema,
    attempt_id: uuid,
    attempt_no: z.number().int().positive(),
    waiting: z
      .object({ checkpoint_id: uuid, invocation_id: uuid, approval_id: uuid })
      .strict()
      .nullable(),
    can_resume: z.boolean(),
  })
  .strict();

export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;
export type HarnessUsage = z.infer<typeof HarnessUsageSchema>;
export type HarnessSnapshot = z.infer<typeof HarnessSnapshotSchema>;
export type HarnessTool = z.infer<typeof HarnessToolSchema>;
export type HarnessModelReply = z.infer<typeof HarnessModelReplySchema>;
export type HarnessRequest = z.infer<typeof HarnessRequestSchema>;
export type HarnessStart = z.infer<typeof HarnessStartSchema>;
export type HarnessReply = z.infer<typeof HarnessReplySchema>;
export type HarnessApprovalDecision = z.infer<typeof HarnessApprovalDecisionSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
