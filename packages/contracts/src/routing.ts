import { z } from 'zod';

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().min(1).max(128);
const scalarOffset = z.number().int().nonnegative().safe();
const score = z.number().finite().min(-1).max(1);
export const RoutingIntentSchema = z.enum([
  'task_list_bounded',
  'prefs_timezone_read',
  'brief_cards_read',
]);
const intents = z.array(RoutingIntentSchema).max(3);
const enabledPolicy = z
  .object({
    revision: z.literal('r2b/1'),
    mode: z.enum(['shadow', 'enforce']),
    bundle_sha256: sha256,
    encoding_sha256: sha256,
    candidate_intents: intents,
    direct_intents: intents,
    thresholds: z
      .object({
        task_list_bounded: z
          .object({ tau_intent: score, tau_gap: z.number().finite().min(0).max(2) })
          .strict(),
        prefs_timezone_read: z
          .object({ tau_intent: score, tau_gap: z.number().finite().min(0).max(2) })
          .strict(),
        brief_cards_read: z
          .object({ tau_intent: score, tau_gap: z.number().finite().min(0).max(2) })
          .strict(),
      })
      .strict(),
    competition: z.array(revision).min(2),
    deadline_ms: z.literal(1000),
    max_inflight: z.literal(2),
    guard_revision: revision,
    parser_revision: revision,
    handler_revision: revision,
    renderer_revision: revision,
    scorer_revision: revision,
  })
  .strict();
export const RoutingPolicySchema = z
  .union([
    z.object({ revision: z.literal('r2b/1'), mode: z.literal('off') }).strict(),
    enabledPolicy,
  ])
  .superRefine((policy, context) => {
    if (policy.mode === 'off') return;
    if (
      new Set(policy.candidate_intents).size !== policy.candidate_intents.length ||
      new Set(policy.direct_intents).size !== policy.direct_intents.length ||
      new Set(policy.competition).size !== policy.competition.length ||
      policy.candidate_intents.some((intent) => !policy.competition.includes(intent)) ||
      policy.direct_intents.some((intent) => !policy.candidate_intents.includes(intent)) ||
      (policy.mode === 'shadow' && policy.direct_intents.length !== 0)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inconsistent routing intent sets',
      });
  });
export const RoutingSourceSchema = z.union([
  z
    .object({
      field: revision,
      source: z.literal('message'),
      message_id: uuid,
      raw: z.string(),
      start: scalarOffset,
      end: scalarOffset,
      parser_revision: revision,
    })
    .strict()
    .refine(
      (source) =>
        source.end >= source.start && Array.from(source.raw).length === source.end - source.start,
      { message: 'source range must match Unicode scalar length' },
    ),
  z
    .object({ field: revision, source: z.literal('contract_default'), parser_revision: revision })
    .strict(),
]);
export const RoutingCandidateSchema = z
  .object({
    intent: RoutingIntentSchema,
    tool_id: revision,
    args: z.record(z.unknown()),
    sources: z.array(RoutingSourceSchema),
  })
  .strict();
export const RoutingFactsSchema = z
  .object({
    facts_ref: uuid,
    input_sha256: sha256,
    bundle_sha256: sha256,
    eligible: z.boolean(),
    reason: revision.nullable(),
    rule_intent: RoutingIntentSchema.nullable(),
    candidates: z.array(RoutingCandidateSchema).max(3),
  })
  .strict()
  .refine(
    (facts) =>
      new Set(facts.candidates.map((candidate) => candidate.intent)).size ===
        facts.candidates.length &&
      (facts.rule_intent === null ||
        (facts.eligible &&
          facts.candidates.some((candidate) => candidate.intent === facts.rule_intent))),
    { message: 'inconsistent routing facts' },
  );
export const RoutingEmbeddingSchema = z
  .object({
    facts_ref: uuid,
    input_sha256: sha256,
    bundle_sha256: sha256,
    reason: revision.nullable(),
    scores: z.array(
      z.object({ intent: revision, score, exclusion_score: score.nullable() }).strict(),
    ),
  })
  .strict()
  .refine(
    (embedding) =>
      new Set(embedding.scores.map((entry) => entry.intent)).size === embedding.scores.length,
    { message: 'duplicate competition score' },
  );
export const RoutingDecisionReplySchema = z
  .object({
    decision_ref: uuid,
    decision: z.enum(['direct', 'fallback']),
    intent: RoutingIntentSchema.nullable(),
    tool_id: revision.nullable(),
    args: z.record(z.unknown()).nullable(),
  })
  .strict()
  .refine(
    (reply) =>
      reply.decision === 'direct'
        ? reply.intent !== null && reply.tool_id !== null && reply.args !== null
        : reply.intent === null && reply.tool_id === null && reply.args === null,
    { message: 'inconsistent routing decision receipt' },
  );
export const RoutingRenderReplySchema = z.object({ rendered: z.literal(true) }).strict();

export type RoutingIntent = z.infer<typeof RoutingIntentSchema>;
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
export type RoutingSource = z.infer<typeof RoutingSourceSchema>;
export type RoutingCandidate = z.infer<typeof RoutingCandidateSchema>;
export type RoutingFacts = z.infer<typeof RoutingFactsSchema>;
export type RoutingEmbedding = z.infer<typeof RoutingEmbeddingSchema>;
export type RoutingDecisionReply = z.infer<typeof RoutingDecisionReplySchema>;
export type RoutingRenderReply = z.infer<typeof RoutingRenderReplySchema>;
