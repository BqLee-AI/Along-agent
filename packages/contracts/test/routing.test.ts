import { expect, test } from 'bun:test';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessRequestSchema,
  HarnessStartSchema,
  RoutingPolicySchema,
  RoutingSourceSchema,
  RoutingFactsSchema,
  RoutingEmbeddingSchema,
  RoutingDecisionReplySchema,
  RoutingRenderReplySchema,
  type HarnessStart,
  type HarnessRequest,
  type RoutingPolicy,
  type RoutingFacts,
  type RoutingSource,
  type RoutingEmbedding,
  type RoutingDecisionReply,
} from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const intent = 'prefs_timezone_read';
const threshold = { tau_intent: 0.8, tau_gap: 0.1 };
const policy: RoutingPolicy = {
  revision: 'r2b/1',
  mode: 'enforce',
  bundle_sha256: 'a'.repeat(64),
  encoding_sha256: 'b'.repeat(64),
  candidate_intents: [intent],
  direct_intents: [intent],
  competition: [intent, 'other_query'],
  thresholds: {
    task_list_bounded: threshold,
    prefs_timezone_read: threshold,
    brief_cards_read: threshold,
  },
  deadline_ms: 1000,
  max_inflight: 2,
  guard_revision: 'guard/1',
  parser_revision: 'parser/1',
  handler_revision: 'handler/1',
  renderer_revision: 'renderer/1',
  scorer_revision: 'scorer/1',
};
const request = { protocol: HARNESS_PROTOCOL_VERSION, request_ref: 'r1' };
const facts: RoutingFacts = {
  facts_ref: id,
  input_sha256: 'c'.repeat(64),
  bundle_sha256: policy.bundle_sha256,
  eligible: true,
  reason: null,
  rule_intent: intent,
  candidates: [{ intent, tool_id: 'get_user_prefs', args: {}, sources: [] }],
};
test('v5 has no old wire shim and requires both routing start fields', () => {
  const start: HarnessStart = {
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'start',
    messages: [{ message_id: id, role: 'user', content: '时区' }],
    tools: [],
    budget: { max_iterations: 1, max_tokens: 100 },
    observations: [],
    approval: null,
    snapshot: null,
    context_policy: {
      revision: 'r2a/1',
      completion_cap: 10,
      model_window_tokens: null,
      input_meter: 'unavailable',
      meter_revision: 'unavailable/1',
      reserve_tokens: 0,
      model_binding: { model: 'fixture', adapter_revision: 'fixture/1' },
    },
    routing_policy: null,
    eligible_phase: 'disabled',
  };
  expect(HARNESS_PROTOCOL_VERSION).toBe('harness/v5');
  expect(HarnessStartSchema.parse(start)).toEqual(start);
  expect(HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v4' }).success).toBe(false);
  const missingPolicy: Partial<typeof start> = { ...start };
  delete missingPolicy.routing_policy;
  const missingPhase: Partial<typeof start> = { ...start };
  delete missingPhase.eligible_phase;
  expect(HarnessStartSchema.safeParse(missingPolicy).success).toBe(false);
  expect(HarnessStartSchema.safeParse(missingPhase).success).toBe(false);
});
test('off needs no assets while enabled policy binds strict sets, thresholds and budgets', () => {
  expect(RoutingPolicySchema.parse({ revision: 'r2b/1', mode: 'off' })).toEqual({
    revision: 'r2b/1',
    mode: 'off',
  });
  expect(RoutingPolicySchema.parse(policy)).toEqual(policy);
  expect(RoutingPolicySchema.parse({ ...policy, mode: 'shadow', direct_intents: [] }).mode).toBe(
    'shadow',
  );
  for (const invalid of [
    { ...policy, mode: 'off' },
    { ...policy, mode: 'shadow' },
    { ...policy, deadline_ms: 999 },
    { ...policy, max_inflight: 3 },
    { ...policy, bundle_sha256: 'unknown' },
    { ...policy, competition: [intent, intent] },
    { ...policy, candidate_intents: [] },
    { ...policy, direct_intents: [intent, intent] },
    { ...policy, encoder_url: 'http://private' },
    {
      ...policy,
      thresholds: { ...policy.thresholds, prefs_timezone_read: { tau_intent: NaN, tau_gap: 0.1 } },
    },
  ])
    expect(RoutingPolicySchema.safeParse(invalid).success).toBe(false);
});
test('probes cannot change input or identity and stage references are exact', () => {
  const probe: Extract<HarnessRequest, { type: 'route_probe' }> = {
    ...request,
    type: 'route_probe',
    stage: 'facts',
    facts_ref: null,
  };
  expect(HarnessRequestSchema.parse(probe)).toEqual(probe);
  expect(HarnessRequestSchema.parse({ ...probe, stage: 'embedding', facts_ref: id })).toMatchObject(
    { facts_ref: id },
  );
  for (const invalid of [
    { ...probe, facts_ref: id },
    { ...probe, stage: 'embedding' },
    { ...probe, stage: 'other' },
    { ...probe, text: 'replacement' },
    { ...probe, owner_id: id },
    { ...probe, args: {} },
  ])
    expect(HarnessRequestSchema.safeParse(invalid).success).toBe(false);
});
test('decisions and renderer requests accept references, never arbitrary arguments or answer text', () => {
  const decision: Extract<HarnessRequest, { type: 'route_decide' }> = {
    ...request,
    type: 'route_decide',
    decision: 'direct',
    facts_ref: id,
    candidate_intent: intent,
    reason: 'RULE_MATCH',
  };
  expect(HarnessRequestSchema.parse(decision)).toEqual(decision);
  expect(HarnessRequestSchema.safeParse({ ...decision, candidate_intent: null }).success).toBe(
    false,
  );
  expect(HarnessRequestSchema.safeParse({ ...decision, args: { owner_id: id } }).success).toBe(
    false,
  );
  const render: Extract<HarnessRequest, { type: 'render_route_result' }> = {
    ...request,
    type: 'render_route_result',
    decision_ref: id,
    invocation_ref: id,
    template_revision: 'renderer/1',
  };
  expect(HarnessRequestSchema.parse(render)).toEqual(render);
  expect(HarnessRequestSchema.safeParse({ ...render, delta: 'forged answer' }).success).toBe(false);
  expect(RoutingRenderReplySchema.parse({ rendered: true })).toEqual({ rendered: true });
  expect(RoutingRenderReplySchema.safeParse({ rendered: false }).success).toBe(false);
  const receipt: RoutingDecisionReply = {
    decision_ref: id,
    decision: 'direct',
    intent,
    tool_id: 'get_user_prefs',
    args: {},
  };
  expect(RoutingDecisionReplySchema.parse(receipt)).toEqual(receipt);
  expect(RoutingDecisionReplySchema.safeParse({ ...receipt, args: null }).success).toBe(false);
  expect(RoutingDecisionReplySchema.safeParse({ ...receipt, decision: 'fallback' }).success).toBe(
    false,
  );
});
test('source ranges are Unicode scalar half-open spans or explicit defaults', () => {
  const source: Extract<RoutingSource, { source: 'message' }> = {
    field: 'date',
    source: 'message',
    message_id: id,
    raw: '😀日期',
    start: 2,
    end: 5,
    parser_revision: 'parser/1',
  };
  expect(RoutingSourceSchema.parse(source)).toEqual(source);
  expect(RoutingSourceSchema.safeParse({ ...source, end: 6 }).success).toBe(false);
  expect(RoutingSourceSchema.safeParse({ ...source, start: 6 }).success).toBe(false);
  expect(
    RoutingSourceSchema.parse({
      field: 'limit',
      source: 'contract_default',
      parser_revision: 'parser/1',
    }),
  ).toMatchObject({ source: 'contract_default' });
});
test('facts and full competition scores stay closed, finite and unambiguous', () => {
  expect(RoutingFactsSchema.parse(facts)).toEqual(facts);
  expect(RoutingFactsSchema.safeParse({ ...facts, eligible: false }).success).toBe(false);
  expect(
    RoutingFactsSchema.safeParse({
      ...facts,
      candidates: [...facts.candidates, ...facts.candidates],
    }).success,
  ).toBe(false);
  const embedding: RoutingEmbedding = {
    facts_ref: id,
    input_sha256: facts.input_sha256,
    bundle_sha256: facts.bundle_sha256,
    reason: null,
    scores: [
      { intent, score: 0.92, exclusion_score: 0.3 },
      { intent: 'other_query', score: 0.4, exclusion_score: null },
    ],
  };
  expect(RoutingEmbeddingSchema.parse(embedding)).toEqual(embedding);
  expect(
    RoutingEmbeddingSchema.safeParse({
      ...embedding,
      scores: [...embedding.scores, embedding.scores[0]],
    }).success,
  ).toBe(false);
  for (const score of [NaN, Infinity, -Infinity])
    expect(
      RoutingEmbeddingSchema.safeParse({
        ...embedding,
        scores: [{ intent, score, exclusion_score: null }],
      }).success,
    ).toBe(false);
});
