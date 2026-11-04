import { expect, test } from 'bun:test';
import {
  HarnessStartSchema,
  HarnessRequestSchema,
  HarnessToolPayloadSchema,
} from '../src/harness.js';
const id = '00000000-0000-4000-8000-000000000001';
const trusted = {
  version: 1,
  authorization_revision: 'delegation/1',
  execution_lifecycle: 'request-bound',
  input_message_id: id,
  received_at_utc: '2026-11-02T12:00:00Z',
  request_anchor_utc: '2026-11-02T12:00:00Z',
  continuation: null,
  timezone: null,
  time_capabilities: { elapsed_revision: null, wall_rules: null },
  workspaces: [],
};
const start = {
  protocol: 'harness/v6',
  type: 'start',
  trusted_context: trusted,
  messages: [{ message_id: id, role: 'user', content: '记住上海时区' }],
  tools: [],
  context_policy: {
    revision: 'r2a/1',
    completion_cap: 256,
    model_window_tokens: null,
    input_meter: 'unavailable',
    meter_revision: 'unavailable/1',
    reserve_tokens: 0,
    model_binding: { model: 'fixture', adapter_revision: 'openai-chat/v1' },
  },
  routing_policy: { revision: 'r2b/1', mode: 'off' },
  eligible_phase: 'disabled',
  budget: { max_iterations: 8, max_tokens: 8000 },
  snapshot: null,
  observations: [],
  approval: null,
};
test('v6 accepts trusted request-bound facts but rejects v5, invented elapsed and resources', () => {
  expect(HarnessStartSchema.safeParse(start).success).toBe(true);
  expect(HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v5' }).success).toBe(false);
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: {
        ...trusted,
        time_capabilities: { elapsed_revision: 'future/1', wall_rules: null },
      },
    }).success,
  ).toBe(false);
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: { ...trusted, workspaces: [{ root: '/' }] },
    }).success,
  ).toBe(false);
});
test('v6 accepts the delivered elapsed revision without granting unknown revisions', () => {
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: {
        ...trusted,
        time_capabilities: { elapsed_revision: 'elapsed/1', wall_rules: null },
      },
    }).success,
  ).toBe(true);
});
test('finish_goal carries outcomes and receipts, not a plain Run done', () => {
  const request = {
    protocol: 'harness/v6',
    type: 'finish_goal',
    request_ref: 'finish',
    usage: { iterations: 2, tokens: 500 },
    goal_result: {
      status: 'completed',
      outcomes: [{ description: '保存时区', status: 'achieved', receipt_refs: [id] }],
      clarification: null,
      answer: '已保存。',
    },
  };
  expect(HarnessRequestSchema.safeParse(request).success).toBe(true);
  expect(
    HarnessRequestSchema.safeParse({
      ...request,
      goal_result: { ...request.goal_result, status: 'done' },
    }).success,
  ).toBe(false);
  expect(
    HarnessRequestSchema.safeParse({
      ...request,
      goal_result: {
        ...request.goal_result,
        outcomes: [{ description: '保存时区', status: 'achieved', receipt_refs: ['invented'] }],
      },
    }).success,
  ).toBe(false);
});

test('task observations preserve complete pagination and actual cancellation state', () => {
  expect(
    HarnessToolPayloadSchema.safeParse({
      kind: 'list_tasks',
      tasks: [],
      has_more: true,
      next_cursor: id,
    }).success,
  ).toBe(true);
  expect(
    HarnessToolPayloadSchema.safeParse({
      kind: 'task_detail',
      task: {
        task_id: id,
        note: '完整提醒',
        fire_at_local_text: '2035-01-01 09:00',
        timezone_id: 'Asia/Shanghai',
        state: 'scheduled',
      },
    }).success,
  ).toBe(true);
  expect(
    HarnessToolPayloadSchema.safeParse({
      kind: 'reminder_cancelled',
      task_id: id,
      state: 'cancel_pending',
      duplicate: false,
    }).success,
  ).toBe(true);
  expect(
    HarnessToolPayloadSchema.safeParse({
      kind: 'reminder_cancelled',
      task_id: id,
      state: 'scheduled',
      duplicate: false,
    }).success,
  ).toBe(false);
});

test('trusted continuation retains a structured unresolved goal without fabricating an invocation', () => {
  const continuation = {
    run_id: id,
    invocation_id: null,
    original_input_message_id: id,
    original_text: '取消喝水提醒',
    goal_result: {
      status: 'blocked',
      outcomes: [{ description: '取消提醒', status: 'not_done', receipt_refs: [] }],
      clarification: { kind: 'target_selection', question: '请选择提醒' },
      answer: '需要确认目标。',
    },
    receipts: [],
    source_result: null,
  };
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: { ...trusted, continuation },
    }).success,
  ).toBe(true);
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: {
        ...trusted,
        continuation: {
          ...continuation,
          invocation_id: id,
          goal_result: null,
          receipts: [],
          source_result: {
            invocation_id: id,
            tool_id: 'list_tasks',
            result: {
              status: 'ok',
              result: { kind: 'clarify', reason: 'TARGET', phrase_key: 'TARGET', text: '请选择' },
            },
          },
        },
      },
    }).success,
  ).toBe(true);
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: { ...trusted, continuation: { ...continuation, original_text: undefined } },
    }).success,
  ).toBe(false);
});
