import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_R3_PROTOCOL_VERSION,
  HarnessRequestSchema,
  HarnessStartSchema,
  RunViewSchema,
} from '@along/contracts';
import { createContextPolicy } from '../../src/features/conversations/public.js';

const messageId = randomUUID();
const snapshot = {
  version: 3,
  message_refs: [messageId],
  tool_refs: [],
  next_call_no: 1,
  usage: { iterations: 0, tokens: 0 },
  waiting: null,
  native_state: {
    protected_messages: [],
    units: [],
    hard_denied: '',
    closing_goal: false,
    pending_model: null,
  },
};

test('pause frames and version 3 snapshots require the v7 protocol', () => {
  const probe = {
    protocol: HARNESS_R3_PROTOCOL_VERSION,
    request_ref: randomUUID(),
    type: 'pause_probe',
  };
  const point = { ...probe, type: 'pause_point', context: snapshot };
  expect(HarnessRequestSchema.safeParse(probe).success).toBe(true);
  expect(HarnessRequestSchema.safeParse(point).success).toBe(true);
  expect(
    HarnessRequestSchema.safeParse({ ...probe, protocol: HARNESS_PROTOCOL_VERSION }).success,
  ).toBe(false);
  expect(
    HarnessRequestSchema.safeParse({ ...point, protocol: HARNESS_PROTOCOL_VERSION }).success,
  ).toBe(false);
  expect(
    HarnessRequestSchema.safeParse({
      ...point,
      context: { ...snapshot, waiting: { invocation_id: randomUUID(), approval_id: randomUUID() } },
    }).success,
  ).toBe(false);
  expect(HarnessRequestSchema.safeParse({ ...point, unexpected: true }).success).toBe(false);
  const start = {
    protocol: HARNESS_R3_PROTOCOL_VERSION,
    type: 'start',
    trusted_context: null,
    messages: [{ message_id: messageId, role: 'user', content: 'Pause safely.' }],
    tools: [],
    context_policy: createContextPolicy({ completionCap: 32, model: 'pause-contract' }),
    routing_policy: { revision: 'r2b/1', mode: 'off' },
    eligible_phase: 'disabled',
    budget: { max_iterations: 4, max_tokens: 100 },
    snapshot,
    observations: [],
    approval: null,
  };
  expect(HarnessStartSchema.safeParse(start).success).toBe(true);
  expect(
    HarnessStartSchema.safeParse({ ...start, protocol: HARNESS_PROTOCOL_VERSION }).success,
  ).toBe(false);
  expect(
    HarnessStartSchema.safeParse({ ...start, snapshot: { ...snapshot, extra: true } }).success,
  ).toBe(false);
});

test('run views expose strict user pause state without conflating approval resume', () => {
  const pause = { pause_id: randomUUID(), reason: 'user', purpose: 'none', status: 'paused' };
  const view = {
    run_id: randomUUID(),
    conversation_id: randomUUID(),
    execution: 'harness',
    model_selection: { state: 'not_applicable' },
    status: 'paused',
    attempt_id: randomUUID(),
    attempt_no: 1,
    waiting: null,
    pause,
    can_pause: false,
    can_resume: false,
  };
  expect(RunViewSchema.safeParse(view).success).toBe(true);
  expect(RunViewSchema.safeParse({ ...view, pause: { ...pause, extra: true } }).success).toBe(
    false,
  );
  expect(
    RunViewSchema.safeParse({ ...view, pause: { ...pause, status: 'consumed' } }).success,
  ).toBe(false);
});
