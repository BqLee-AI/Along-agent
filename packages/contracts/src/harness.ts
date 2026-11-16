import { z } from 'zod';
import { workspaceSummarySchema, workspaceResultSchema } from './workspaces.js';
import {
  DocumentApprovalDecisionSchema,
  DocumentApprovalReceiptSchema,
} from './document-approvals.js';
import { RoutingPolicySchema, RoutingIntentSchema } from './routing.js';
import {
  ExecutionLifecycleSchema,
  ElapsedTimeBasisSchema,
  GoalResultSchema,
  TrustedExecutionContextSchema,
} from './goals.js';

export const HARNESS_PROTOCOL_VERSION = 'harness/v6' as const;
export const HARNESS_R3_PROTOCOL_VERSION = 'harness/v7' as const;
export const HARNESS_MAX_FRAME_BYTES = 1024 * 1024;

const uuid = z.string().uuid();
const reference = z.string().min(1).max(128);
const text = z.string().max(HARNESS_MAX_FRAME_BYTES);
const args = z.record(z.unknown());
const safe = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const meterQuality = z.enum(['verified', 'estimated', 'unavailable']);
const failure = z.object({ code: reference, message: z.string().max(8192) }).strict();
export const ContextPolicySchema = z
  .object({
    revision: z.literal('r2a/1'),
    completion_cap: positive,
    model_window_tokens: positive.nullable(),
    input_meter: meterQuality,
    meter_revision: z.string().min(1),
    reserve_tokens: safe,
    model_binding: z
      .object({ model: z.string().min(1), adapter_revision: z.string().min(1) })
      .strict(),
  })
  .strict()
  .refine(
    (policy) => policy.input_meter === 'unavailable' || policy.meter_revision !== 'unavailable/1',
    {
      message: 'a usable input meter requires its capability revision',
    },
  );
export const HarnessContextMeasurementSchema = z
  .object({
    wire_bytes: safe,
    http_bytes: safe,
    input_meter: z
      .object({
        quality: meterQuality,
        input_tokens: safe.nullable(),
        meter_revision: z.string().min(1),
      })
      .strict()
      .refine((meter) =>
        meter.quality === 'unavailable' ? meter.input_tokens === null : meter.input_tokens !== null,
      ),
    output_ceiling: safe,
    limit_reason: z.enum(['budget', 'context']).nullable(),
  })
  .strict();

// Shared accepted-result validation: the tool ledger and native observations
// consume exactly the same closed payload union, never a synthetic summary kind.
const small = z.string().max(512);
const payloadText = z.string().max(8192);
const toolFailure = z.object({ code: small, message: payloadText }).strict();
const timeFailure = z
  .object({
    code: z.enum([
      'NONEXISTENT_LOCAL_TIME',
      'AMBIGUOUS_LOCAL_TIME',
      'TZDB_UNAVAILABLE',
      'UNKNOWN_TIMEZONE',
    ]),
    message: payloadText,
    http_status: z.union([z.literal(422), z.literal(503)]),
    details: z
      .object({
        wall_time: small,
        timezone_id: small,
        ruleset_id: small,
        candidates: z
          .array(
            z
              .object({
                fold_choice: z.enum(['first', 'second']),
                offset_seconds: z.number().int(),
                fire_at_utc: small,
              })
              .strict(),
          )
          .max(2)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const taskCreatedSchema = z
  .object({
    kind: z.literal('task_created'),
    task_id: uuid,
    state: z.literal('saved'),
    wall_time: small,
    timezone_id: small,
    fold: z.union([z.literal(0), z.literal(1)]),
    resolved_utc_offset_seconds: z.number().int(),
    tzdb_version: small.nullable(),
    fire_at_utc: small,
    original_note: payloadText.nullable(),
    time_basis: ElapsedTimeBasisSchema.optional(),
    display_version: z.literal('elapsed/1').optional(),
  })
  .strict()
  .refine((task) =>
    task.time_basis
      ? task.display_version === 'elapsed/1' &&
        (task.tzdb_version !== null ||
          (task.timezone_id === 'UTC' && task.fold === 0 && task.resolved_utc_offset_seconds === 0))
      : task.display_version === undefined && task.tzdb_version !== null,
  );

export const HarnessToolPayloadSchema = z.union([
  z
    .object({
      kind: z.literal('approval'),
      approval: z
        .object({
          approvalId: uuid,
          originalText: payloadText,
          presentationHash: small,
          presentationVersion: small,
          expiresAt: small,
          wallTime: small,
          timezoneId: small,
          fold: z.union([z.literal(0), z.literal(1)]),
          offsetSeconds: z.number().int(),
          fireAtUtc: small,
        })
        .strict(),
      echo_text: payloadText,
      card_id: small,
      original_text: payloadText,
    })
    .strict(),
  z
    .object({ kind: z.literal('clarify'), reason: small, phrase_key: small, text: payloadText })
    .strict(),
  z.object({ kind: z.literal('time_error'), error: timeFailure }).strict(),
  z
    .object({
      kind: z.literal('list_tasks'),
      tasks: z
        .array(
          z
            .object({
              task_id: uuid,
              note_preview: z.string().max(30),
              fire_at_local_text: small,
              timezone_id: small,
              state: small,
            })
            .strict(),
        )
        .max(50),
      has_more: z.boolean(),
      next_cursor: uuid.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_detail'),
      task: z
        .object({
          task_id: uuid,
          note: payloadText.nullable(),
          fire_at_local_text: small,
          timezone_id: small,
          state: small,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reminder_cancelled'),
      task_id: uuid,
      state: z.enum(['cancel_pending', 'cancelled']),
      duplicate: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('brief'),
      brief_id: small,
      date: small,
      timezone_id: small.optional(),
      cards: z
        .array(
          z
            .object({
              card_id: small,
              kind: small,
              title: z.string().max(30),
              body_text: payloadText,
              source_refs: z.array(small).max(10),
              presentation_version: small,
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prefs'),
      timezone_id: small.nullable(),
      alias_version: small,
      quiet_hours: z.null(),
      locale: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('timezone_setting'),
      timezone_id: small.nullable(),
      previous_timezone_id: small.nullable(),
      alias_version: small,
    })
    .strict(),
  taskCreatedSchema,
  z.object({ kind: z.literal('effect_evidence'), evidence_ref: small }).strict(),
  z
    .object({ kind: z.literal('document_approval'), approval: DocumentApprovalReceiptSchema })
    .strict(),
  workspaceResultSchema,
]);
export const HarnessToolResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), result: HarnessToolPayloadSchema }).strict(),
  z.object({ status: z.literal('denied'), error: toolFailure }).strict(),
  z.object({ status: z.literal('failed'), error: toolFailure }).strict(),
  z.object({ status: z.literal('unknown'), error: toolFailure }).strict(),
]);
const source = {
  result_version: z.literal(1),
  omitted: z.literal(true),
  workspace_id: z.string().min(1).optional(),
};
const sourceVersion = z.string().regex(/^[a-f0-9]{64}$/);
const projectedSource = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...source,
        kind: z.literal('read'),
        path: z.string(),
        version: sourceVersion,
        byte_length: safe,
        content_total: safe,
      })
      .strict(),
    z
      .object({
        ...source,
        kind: z.literal('list'),
        path: z.string(),
        entries_total: safe,
        failures_total: safe,
      })
      .strict(),
    z
      .object({
        ...source,
        kind: z.literal('search'),
        path: z.string(),
        matches_total: safe,
        failures_total: safe,
      })
      .strict(),
    z
      .object({
        ...source,
        kind: z.literal('context_slice'),
        source_invocation_id: uuid,
        source_tool_id: reference,
        source_result_version: z.literal(1),
        source_kind: z.enum(['read', 'list', 'search']),
        field: z.enum(['content', 'matches', 'entries', 'failures']),
        unit: z.enum(['unicode_scalar', 'items']),
        offset: safe,
        end: safe,
        total: safe,
        has_more: z.boolean(),
        path: z.string().optional(),
        version: sourceVersion.optional(),
        byte_length: safe.optional(),
      })
      .strict(),
  ])
  .refine(
    (value) => {
      if (value.kind !== 'context_slice') return true;
      const read = value.source_kind === 'read';
      const metadata = read
        ? value.path !== undefined && value.version !== undefined && value.byte_length !== undefined
        : value.path === undefined &&
          value.version === undefined &&
          value.byte_length === undefined;
      const fieldValid = read
        ? value.field === 'content'
        : value.source_kind === 'search'
          ? value.field === 'matches' || value.field === 'failures'
          : value.field === 'entries' || value.field === 'failures';
      return (
        metadata &&
        fieldValid &&
        value.unit === (read ? 'unicode_scalar' : 'items') &&
        value.end >= value.offset &&
        (value.offset >= value.total ? value.end === value.offset : value.end <= value.total) &&
        value.has_more === value.end < value.total
      );
    },
    { message: 'invalid projected source range or provenance' },
  );
export const HarnessObservationSchema = z.discriminatedUnion('view', [
  z
    .object({
      view: z.literal('full'),
      invocation_id: uuid,
      tool_id: reference,
      result: HarnessToolResultSchema,
    })
    .strict(),
  z
    .object({
      view: z.literal('projected'),
      invocation_id: uuid,
      tool_id: reference,
      outcome: z.literal('ok'),
      source: projectedSource,
    })
    .strict(),
]);
export const ExecutionKindSchema = z.enum(['business', 'harness']);
export const RunStatusSchema = z.enum([
  'running',
  'paused',
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
const snapshotFields = {
  message_refs: z.array(uuid).max(64),
  tool_refs: z.array(uuid).max(64),
  next_call_no: z.number().int().positive(),
  usage: HarnessUsageSchema,
  waiting: z.object({ invocation_id: uuid, approval_id: uuid }).strict().nullable(),
};
export const HarnessSnapshotSchema = z
  .object({ version: z.literal(2), ...snapshotFields })
  .strict();

// Historical approval snapshots use v2 for execution. The caller must verify
// legacy references are task receipts before bootstrapping.
export const HistoricalHarnessSnapshotSchema = z.union([
  HarnessSnapshotSchema,
  z.object({ version: z.literal(1), ...snapshotFields }).strict(),
]);
export const HarnessToolSchema = z
  .object({
    name: reference,
    description: z.string().max(8192),
    parameters: args,
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();
const modelToolCallSchema = z
  .object({
    id: reference,
    type: z.literal('function'),
    function: z.object({ name: reference, arguments: text }).strict(),
  })
  .strict();
export const HarnessModelMessageSchema = z.union([
  z.object({ role: z.enum(['system', 'user', 'assistant']), content: text }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: text,
      tool_calls: z.array(modelToolCallSchema).length(1),
    })
    .strict(),
  z.object({ role: z.literal('tool'), tool_call_id: reference, content: text }).strict(),
]);
export const HarnessPauseSnapshotSchema = z
  .object({
    version: z.literal(3),
    ...snapshotFields,
    waiting: z.null(),
    native_state: z
      .object({
        protected_messages: z.array(HarnessModelMessageSchema).max(256),
        units: z
          .array(
            z
              .object({
                entries: z.array(HarnessModelMessageSchema).max(256),
                observation: HarnessObservationSchema,
                seen: z.boolean(),
                projected: z.boolean(),
              })
              .strict(),
          )
          .max(64),
        hard_denied: z.string().max(128),
        closing_goal: z.boolean(),
        pending_model: z
          .object({
            content: text.nullable(),
            tool_calls: z.array(modelToolCallSchema).max(1),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export const HarnessModelReplySchema = z
  .object({
    message: z
      .object({
        content: text.nullable(),
        tool_calls: z.array(modelToolCallSchema).max(64),
      })
      .strict(),
    usage: z.object({ total_tokens: z.number().int().nonnegative() }).strict().nullable(),
  })
  .strict();
export const HarnessModelStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), delta: z.string().min(1).max(4000) }).strict(),
  z.object({ type: z.literal('complete'), reply: HarnessModelReplySchema }).strict(),
  z
    .object({
      type: z.literal('failed'),
      error: failure,
      usage: z.object({ total_tokens: safe }).strict().nullable(),
    })
    .strict(),
]);
const request = {
  protocol: z.enum([HARNESS_PROTOCOL_VERSION, HARNESS_R3_PROTOCOL_VERSION]),
  request_ref: reference,
};
export const HarnessRequestSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...request,
        type: z.literal('route_probe'),
        stage: z.enum(['facts', 'embedding']),
        facts_ref: uuid.nullable(),
      })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal('route_decide'),
        decision: z.enum(['direct', 'fallback']),
        facts_ref: uuid,
        candidate_intent: RoutingIntentSchema.nullable(),
        reason: reference,
      })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal('render_route_result'),
        decision_ref: uuid,
        invocation_ref: uuid,
        template_revision: reference,
      })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal('model'),
        messages: z.array(HarnessModelMessageSchema).min(1).max(256),
        remaining_tokens: safe.nullable(),
        max_output_tokens: positive,
      })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal('measure_context'),
        messages: z.array(HarnessModelMessageSchema).min(1).max(256),
        remaining_tokens: safe.nullable(),
        max_output_tokens: positive,
      })
      .strict(),
    z.object({ ...request, type: z.literal('model_next'), model_ref: reference }).strict(),
    z
      .object({
        ...request,
        type: z.literal('context_source'),
        invocation_id: uuid,
        view: z.enum(['full', 'projected']),
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
    z.object({ ...request, type: z.literal('pause_probe') }).strict(),
    z
      .object({ ...request, type: z.literal('pause_point'), context: HarnessPauseSnapshotSchema })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal('suspend'),
        checkpoint_ref: uuid,
        invocation_id: uuid,
        approval_id: uuid,
      })
      .strict(),
    z
      .object({ ...request, type: z.literal('answer'), delta: z.string().min(1).max(4000) })
      .strict(),
    z
      .object({
        ...request,
        type: z.literal('finish_goal'),
        goal_result: GoalResultSchema,
        usage: HarnessUsageSchema,
      })
      .strict(),
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
  ])
  .superRefine((value, context) => {
    if (
      (value.type === 'pause_point' || value.type === 'pause_probe') &&
      value.protocol === HARNESS_PROTOCOL_VERSION
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'pause requires harness/v7' });
    }
    if (value.type === 'route_probe' && (value.stage === 'facts') !== (value.facts_ref === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'probe stage requires its exact facts reference',
      });
    }
    if (
      value.type === 'route_decide' &&
      (value.decision === 'direct') !== (value.candidate_intent !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only direct may authorize a candidate intent',
      });
    }
  });
export const HarnessTaskApprovalDecisionSchema = z
  .object({
    kind: z.literal('task'),
    approval_id: uuid,
    status: z.enum(['pending', 'consumed', 'rejected', 'expired', 'superseded']),
    task_id: uuid.nullable(),
    successor_id: uuid.nullable(),
  })
  .strict()
  .refine((decision) => decision.status !== 'consumed' || decision.task_id !== null, {
    message: 'consumed task approval requires its real task result',
    path: ['task_id'],
  });
export const HarnessDocumentApprovalDecisionSchema = DocumentApprovalDecisionSchema.omit({
  run_id: true,
});
export const HarnessApprovalDecisionSchema = z.union([
  HarnessTaskApprovalDecisionSchema,
  HarnessDocumentApprovalDecisionSchema,
]);
export const HarnessStartSchema = z
  .object({
    protocol: z.enum([HARNESS_PROTOCOL_VERSION, HARNESS_R3_PROTOCOL_VERSION]),
    type: z.literal('start'),
    trusted_context: TrustedExecutionContextSchema.nullable(),
    messages: z
      .array(
        z.object({ message_id: uuid, role: z.enum(['user', 'assistant']), content: text }).strict(),
      )
      .min(1)
      .max(64),
    tools: z.array(HarnessToolSchema).max(64),
    context_policy: ContextPolicySchema,
    routing_policy: RoutingPolicySchema.nullable(),
    eligible_phase: z.enum(['fresh_first_step', 'disabled']),
    budget: z
      .object({
        max_iterations: z.number().int().positive(),
        max_tokens: z.number().int().positive(),
      })
      .strict(),
    snapshot: z.union([HarnessSnapshotSchema, HarnessPauseSnapshotSchema]).nullable(),
    observations: z.array(HarnessObservationSchema).max(64),
    approval: HarnessApprovalDecisionSchema.nullable(),
    workspace: workspaceSummarySchema.nullable().optional(),
  })
  .strict()
  .refine(
    (start) => start.protocol === HARNESS_R3_PROTOCOL_VERSION || start.snapshot?.version !== 3,
    { message: 'pause snapshot requires harness/v7' },
  );
export const HarnessReplySchema = z.union([
  z
    .object({
      protocol: z.enum([HARNESS_PROTOCOL_VERSION, HARNESS_R3_PROTOCOL_VERSION]),
      type: z.literal('reply'),
      reply_to: reference,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      protocol: z.enum([HARNESS_PROTOCOL_VERSION, HARNESS_R3_PROTOCOL_VERSION]),
      type: z.literal('reply'),
      reply_to: reference,
      error: z.object({ code: reference, message: z.string().max(8192) }).strict(),
    })
    .strict(),
]);
export const HarnessCancelSchema = z
  .object({
    protocol: z.enum([HARNESS_PROTOCOL_VERSION, HARNESS_R3_PROTOCOL_VERSION]),
    type: z.literal('cancel'),
    reason: z.string().max(512),
  })
  .strict();
export const RunModelSelectionSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('available'),
      provider_id: uuid,
      provider_name: z.string(),
      model_id: z.string().min(1),
    })
    .strict(),
  z.object({ state: z.literal('legacy_unavailable') }).strict(),
  z.object({ state: z.literal('not_applicable') }).strict(),
]);

export const RunViewSchema = z
  .object({
    run_id: uuid,
    conversation_id: uuid,
    execution: ExecutionKindSchema,
    model_selection: RunModelSelectionSchema,
    status: RunStatusSchema,
    attempt_id: uuid,
    attempt_no: z.number().int().positive(),
    waiting: z
      .union([
        z.object({ checkpoint_id: uuid, invocation_id: uuid, approval_id: uuid }).strict(),
        z
          .object({
            checkpoint_id: uuid,
            invocation_id: uuid,
            approval_id: uuid,
            approval_kind: z.literal('document'),
          })
          .strict(),
      ])
      .nullable(),
    pause: z
      .object({
        pause_id: uuid,
        reason: z.literal('user'),
        purpose: z.literal('none'),
        status: z.enum(['pending', 'paused']),
      })
      .strict()
      .nullable()
      .optional(),
    can_pause: z.boolean().optional(),
    workspace: workspaceSummarySchema.optional(),
    workspaces: z.array(workspaceSummarySchema).optional(),
    can_resume: z.boolean(),
    authorization_revision: z.literal('delegation/1').optional(),
    execution_lifecycle: ExecutionLifecycleSchema.optional(),
    goal_result: GoalResultSchema.nullable().optional(),
    document_effects: z
      .array(
        z
          .object({
            workspace_id: z.string().min(1),
            path: z.string(),
            invocation_id: uuid,
            read_invocation_id: uuid.nullable(),
            version: z.string().nullable(),
            operation: z.enum(['create', 'replace']).optional(),
            status: z.enum(['applied', 'verified', 'conflict', 'failed', 'unknown']),
          })
          .strict(),
      )
      .optional(),
    created_reminders: z
      .array(
        taskCreatedSchema
          .innerType()
          .extend({ invocation_id: uuid })
          .refine((task) =>
            task.time_basis
              ? task.display_version === 'elapsed/1' &&
                (task.tzdb_version !== null ||
                  (task.timezone_id === 'UTC' &&
                    task.fold === 0 &&
                    task.resolved_utc_offset_seconds === 0))
              : task.display_version === undefined && task.tzdb_version !== null,
          ),
      )
      .max(64)
      .optional(),
    reminder_time_errors: z
      .array(z.object({ invocation_id: uuid, error: timeFailure }).strict())
      .max(64)
      .optional(),
  })
  .strict();

export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;
export type HarnessUsage = z.infer<typeof HarnessUsageSchema>;
export type HarnessSnapshot = z.infer<typeof HarnessSnapshotSchema>;
export type HarnessPauseSnapshot = z.infer<typeof HarnessPauseSnapshotSchema>;
export type HarnessTool = z.infer<typeof HarnessToolSchema>;
export type HarnessModelReply = z.infer<typeof HarnessModelReplySchema>;
export type HarnessRequest = z.infer<typeof HarnessRequestSchema>;
export type HarnessStart = z.infer<typeof HarnessStartSchema>;
export type HarnessReply = z.infer<typeof HarnessReplySchema>;
export type HarnessApprovalDecision = z.infer<typeof HarnessApprovalDecisionSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;
export type HarnessContextMeasurement = z.infer<typeof HarnessContextMeasurementSchema>;
export type HarnessModelStep = z.infer<typeof HarnessModelStepSchema>;
export type HarnessObservation = z.infer<typeof HarnessObservationSchema>;
