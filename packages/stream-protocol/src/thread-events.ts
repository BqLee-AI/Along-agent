// Thread-event envelope contract (issue #9): docs/design/09 AgentEvent -> SSE
// projection, docs/design/10 §1 (S0 #14 frozen, seven words).
// Every event object is .strict(): unknown fields are rejected, so the wire
// shape can never silently widen. protocol_version is frozen at "v1".
import { z } from "zod";

export const THREAD_PROTOCOL_VERSION = "v1" as const;

// Frozen SSE vocabulary: exactly these seven words, no more.
export const THREAD_EVENT_TYPES = [
  "thread.started",
  "message.delta",
  "card.proposed",
  "approval_required",
  "thread.completed",
  "thread.failed",
  "thread.cancelled",
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

const uuidSchema = z.string().uuid();
const requestIdSchema = z.string().min(1).max(200);

export const ThreadStartedPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    stream_protocol_version: z.literal("v1"),
    ruleset_id: z.string().min(1).max(200),
    tzdb_version: z.string().min(1).max(100),
  })
  .strict();

export const MessageDeltaPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    delta: z.string().min(1).max(4000),
  })
  .strict();

export const CardProposedPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    card_id: z.string().min(1).max(200),
    schema_version: z.literal("v1"),
    wall_time: z.string().min(1).max(100),
    timezone_id: z.string().min(1).max(100),
    original_text: z.string().min(1).max(1000),
  })
  .strict();

export const ApprovalRequiredPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    approval_id: uuidSchema,
    card_id: z.string().min(1).max(200),
    presentation_hash: z.string().min(1).max(200),
  })
  .strict();

export const ThreadCompletedPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    approval_id: uuidSchema.nullable(),
  })
  .strict();

export const ThreadFailedErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    http_status: z.number().int().min(400).max(599),
    details: z.unknown().optional(),
  })
  .strict();

export const ThreadFailedPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    error: ThreadFailedErrorSchema,
  })
  .strict();

export const ThreadCancelledPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

function envelopeOf<TType extends ThreadEventType, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) {
  return z
    .object({
      protocol_version: z.literal(THREAD_PROTOCOL_VERSION),
      seq: z.number().int().positive(),
      type: z.literal(type),
      payload,
      request_id: requestIdSchema,
    })
    .strict();
}

export const ThreadEventSchema = z.discriminatedUnion("type", [
  envelopeOf("thread.started", ThreadStartedPayloadSchema),
  envelopeOf("message.delta", MessageDeltaPayloadSchema),
  envelopeOf("card.proposed", CardProposedPayloadSchema),
  envelopeOf("approval_required", ApprovalRequiredPayloadSchema),
  envelopeOf("thread.completed", ThreadCompletedPayloadSchema),
  envelopeOf("thread.failed", ThreadFailedPayloadSchema),
  envelopeOf("thread.cancelled", ThreadCancelledPayloadSchema),
]);

export type ThreadEvent = z.infer<typeof ThreadEventSchema>;
export type ThreadStartedEvent = Extract<ThreadEvent, { type: "thread.started" }>;
export type MessageDeltaEvent = Extract<ThreadEvent, { type: "message.delta" }>;
export type CardProposedEvent = Extract<ThreadEvent, { type: "card.proposed" }>;
export type ApprovalRequiredEvent = Extract<ThreadEvent, { type: "approval_required" }>;
export type ThreadCompletedEvent = Extract<ThreadEvent, { type: "thread.completed" }>;
export type ThreadFailedEvent = Extract<ThreadEvent, { type: "thread.failed" }>;
export type ThreadCancelledEvent = Extract<ThreadEvent, { type: "thread.cancelled" }>;
