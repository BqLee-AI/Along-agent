// Thread-event envelope contract (issue #9): docs/design/09 AgentEvent -> SSE
// projection, docs/design/10 §1 (S0 #14 frozen, seven words).
// Every event object is .strict(): unknown fields are rejected, so the wire
// shape can never silently widen. protocol_version is frozen at "v1".
import { z } from 'zod';

export const THREAD_PROTOCOL_VERSION = 'v1' as const;
export const DELEGATION_THREAD_PROTOCOL_VERSION = 'v2' as const;

// Frozen SSE vocabulary: exactly these seven words, no more.
export const THREAD_EVENT_TYPES = [
  'thread.started',
  'message.delta',
  'card.proposed',
  'approval_required',
  'thread.completed',
  'thread.failed',
  'thread.cancelled',
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

const uuidSchema = z.string().uuid();
const requestIdSchema = z.string().min(1).max(200);

export const ThreadStartedPayloadSchema = z
  .object({
    conversation_id: uuidSchema,
    run_id: uuidSchema,
    stream_protocol_version: z.literal('v1'),
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
    schema_version: z.literal('v1'),
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

export const AmbiguousTimeDetailsSchema = z
  .object({
    wall_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
    timezone_id: z.string().min(1).max(100),
    ruleset_id: z.string().min(1).max(200),
    candidates: z.tuple([
      z
        .object({
          fold_choice: z.literal('first'),
          offset_seconds: z.number().int().min(-86400).max(86400),
          fire_at_utc: z.string().datetime({ precision: 0 }),
        })
        .strict(),
      z
        .object({
          fold_choice: z.literal('second'),
          offset_seconds: z.number().int().min(-86400).max(86400),
          fire_at_utc: z.string().datetime({ precision: 0 }),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((details) => details.candidates[0].fire_at_utc < details.candidates[1].fire_at_utc, {
    message: 'candidates must be in strictly ascending UTC order',
    path: ['candidates'],
  });

export const ThreadFailedErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    http_status: z.number().int().min(400).max(599),
    details: z.unknown().optional(),
  })
  .strict()
  .superRefine((error, ctx) => {
    if (error.code === 'AMBIGUOUS_LOCAL_TIME') {
      const details = AmbiguousTimeDetailsSchema.safeParse(error.details);
      if (!details.success) {
        for (const issue of details.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: issue.message,
            path: ['details', ...issue.path],
          });
        }
      }
    }
    const expectedStatus =
      error.code === 'TZDB_UNAVAILABLE'
        ? 503
        : ['AMBIGUOUS_LOCAL_TIME', 'NONEXISTENT_LOCAL_TIME', 'UNKNOWN_TIMEZONE'].includes(
              error.code,
            )
          ? 422
          : null;
    if (expectedStatus !== null && error.http_status !== expectedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'incorrect time error HTTP status',
        path: ['http_status'],
      });
    }
  });

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

export const LegacyThreadEventSchema = z.discriminatedUnion('type', [
  envelopeOf('thread.started', ThreadStartedPayloadSchema),
  envelopeOf('message.delta', MessageDeltaPayloadSchema),
  envelopeOf('card.proposed', CardProposedPayloadSchema),
  envelopeOf('approval_required', ApprovalRequiredPayloadSchema),
  envelopeOf('thread.completed', ThreadCompletedPayloadSchema),
  envelopeOf('thread.failed', ThreadFailedPayloadSchema),
  envelopeOf('thread.cancelled', ThreadCancelledPayloadSchema),
]);

// Independent SSE consumer validates the goal wire shape without importing
// application/domain code. Domain evidence is verified before publication.
const goalText = z.string().min(1).max(8192);
const goalResult = z
  .object({
    status: z.enum(['completed', 'partial', 'blocked', 'cancelled', 'unknown']),
    outcomes: z
      .array(
        z
          .object({
            description: goalText,
            status: z.enum(['achieved', 'not_done', 'blocked', 'unknown']),
            receipt_refs: z.array(uuidSchema).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    clarification: z
      .object({
        kind: z.enum(['time', 'timezone', 'target_selection', 'destination']),
        question: goalText,
      })
      .strict()
      .nullable(),
    answer: goalText,
  })
  .strict();
function delegationEnvelope<T extends ThreadEventType, P extends z.ZodTypeAny>(
  type: z.ZodLiteral<T>,
  payload: P,
) {
  return z
    .object({
      protocol_version: z.literal(DELEGATION_THREAD_PROTOCOL_VERSION),
      seq: z.number().int().positive(),
      type,
      payload,
      request_id: requestIdSchema,
    })
    .strict();
}
export const DelegationThreadEventSchema = z.discriminatedUnion('type', [
  delegationEnvelope(
    z.literal('thread.started'),
    ThreadStartedPayloadSchema.extend({
      stream_protocol_version: z.literal('v2'),
      authorization_revision: z.literal('delegation/1'),
      execution_lifecycle: z.literal('request-bound'),
    }),
  ),
  delegationEnvelope(z.literal('message.delta'), MessageDeltaPayloadSchema),
  delegationEnvelope(z.literal('card.proposed'), CardProposedPayloadSchema),
  delegationEnvelope(z.literal('approval_required'), ApprovalRequiredPayloadSchema),
  delegationEnvelope(
    z.literal('thread.completed'),
    ThreadCompletedPayloadSchema.extend({ goal_result: goalResult }),
  ),
  delegationEnvelope(
    z.literal('thread.failed'),
    ThreadFailedPayloadSchema.extend({ goal_result: goalResult }),
  ),
  delegationEnvelope(
    z.literal('thread.cancelled'),
    ThreadCancelledPayloadSchema.extend({ goal_result: goalResult }),
  ),
]);
export const ThreadEventSchema = z.union([LegacyThreadEventSchema, DelegationThreadEventSchema]);

export type ThreadEvent = z.infer<typeof ThreadEventSchema>;
export type ThreadStartedEvent = Extract<ThreadEvent, { type: 'thread.started' }>;
export type MessageDeltaEvent = Extract<ThreadEvent, { type: 'message.delta' }>;
export type CardProposedEvent = Extract<ThreadEvent, { type: 'card.proposed' }>;
export type ApprovalRequiredEvent = Extract<ThreadEvent, { type: 'approval_required' }>;
export type ThreadCompletedEvent = Extract<ThreadEvent, { type: 'thread.completed' }>;
export type ThreadFailedEvent = Extract<ThreadEvent, { type: 'thread.failed' }>;
export type ThreadCancelledEvent = Extract<ThreadEvent, { type: 'thread.cancelled' }>;
