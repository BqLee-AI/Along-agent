import { expect, test } from 'bun:test';
import {
  HarnessStartSchema,
  HarnessRequestSchema,
  HarnessToolPayloadSchema,
} from '../src/harness.js';
import {
  workspaceGrantSchema,
  workspaceResultSchema,
  workspaceSummarySchema,
} from '../src/workspaces.js';
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

test('creation resolution is optional, strict and requires unique nonempty collision references', () => {
  const resolution = {
    source_message_id: id,
    source_quote: '创建报告',
    zero_write_invocation_ids: [id],
    created_invocation_id: '00000000-0000-4000-8000-000000000002',
    read_invocation_id: '00000000-0000-4000-8000-000000000003',
  };
  const request = {
    protocol: 'harness/v6',
    type: 'finish_goal',
    request_ref: 'finish',
    usage: { iterations: 1, tokens: 1 },
    goal_result: {
      status: 'completed',
      outcomes: [
        {
          description: '创建报告',
          status: 'achieved',
          receipt_refs: [],
          create_resolution: resolution,
        },
      ],
      clarification: null,
      answer: '已创建。',
    },
  };
  expect(HarnessRequestSchema.safeParse(request).success).toBe(true);
  for (const patch of [
    { zero_write_invocation_ids: [] },
    { zero_write_invocation_ids: [id, id] },
    { zero_write_invocation_ids: ['invalid'] },
    { source_quote: '' },
    { extra: true },
  ]) {
    const outcome = {
      ...request.goal_result.outcomes[0],
      create_resolution: { ...resolution, ...patch },
    };
    expect(
      HarnessRequestSchema.safeParse({
        ...request,
        goal_result: { ...request.goal_result, outcomes: [outcome] },
      }).success,
    ).toBe(false);
  }
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: { ...trusted, create_resolution_revision: 'create-resolution/1' },
    }).success,
  ).toBe(true);
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      trusted_context: { ...trusted, create_resolution_revision: 'future/1' },
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

test('output grants remain private and creation receipts have closed shapes', () => {
  const summary = {
    workspace_id: 'w',
    label: 'W',
    readable_paths: [],
    writable_paths: [],
    output_directories: [''],
  };
  expect(workspaceSummarySchema.safeParse(summary).success).toBe(true);
  expect(workspaceSummarySchema.safeParse({ ...summary, root: '/private' }).success).toBe(false);
  expect(
    workspaceGrantSchema.safeParse({
      workspace_id: 'w',
      owner_id: 'owner',
      registration_digest: 'a'.repeat(64),
      root_identity: '1:2',
      output_directories: [{ path: '', identity: '1:2' }],
    }).success,
  ).toBe(true);
  const identity = { workspace_id: 'w', path: 'new.txt', invocation_id: id, args_hash: 'hash' };
  expect(
    workspaceResultSchema.safeParse({
      ...identity,
      kind: 'create_applied',
      version: 'v',
      byte_length: 0,
      evidence_ref: 'e',
    }).success,
  ).toBe(true);
  expect(
    workspaceResultSchema.safeParse({
      ...identity,
      kind: 'create_conflict',
      reason: 'already_exists',
      zero_write: true,
    }).success,
  ).toBe(true);
  expect(
    workspaceResultSchema.safeParse({
      ...identity,
      kind: 'create_failed',
      reason: 'unavailable',
      zero_write: true,
    }).success,
  ).toBe(true);
  expect(
    workspaceResultSchema.safeParse({
      ...identity,
      kind: 'create_conflict',
      reason: 'already_exists',
      zero_write: false,
    }).success,
  ).toBe(false);
});
