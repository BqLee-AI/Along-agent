import { describe, expect, it } from 'bun:test';
import {
  DelegationThreadEventSchema,
  LegacyThreadEventSchema,
  ThreadEventSchema,
} from '../src/index.js';

const conversationId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const binding = { conversation_id: conversationId, run_id: runId };
const goal = {
  status: 'completed',
  outcomes: [{ description: '保存默认时区', status: 'achieved', receipt_refs: [receiptId] }],
  clarification: null,
  answer: '默认时区已保存。',
};

function event(type: string, payload: Record<string, unknown>) {
  return { protocol_version: 'v2', seq: 1, type, payload, request_id: 'delegation-stream-test' };
}

const started = event('thread.started', {
  ...binding,
  stream_protocol_version: 'v2',
  ruleset_id: 'FIXTURE_V1',
  tzdb_version: 'fixture-v1',
  authorization_revision: 'delegation/1',
  execution_lifecycle: 'request-bound',
});
const terminals = [
  event('thread.completed', { ...binding, approval_id: null, goal_result: goal }),
  event('thread.failed', {
    ...binding,
    error: { code: 'TOOL_ERROR', message: '执行失败', http_status: 500 },
    goal_result: { ...goal, status: 'partial' },
  }),
  event('thread.cancelled', {
    ...binding,
    reason: 'user_requested',
    goal_result: { ...goal, status: 'cancelled' },
  }),
];
const events = [
  started,
  event('message.delta', { ...binding, delta: '正在处理' }),
  event('card.proposed', {
    ...binding,
    card_id: 'card-1',
    schema_version: 'v1',
    wall_time: '2026-11-02 09:20',
    timezone_id: 'Asia/Shanghai',
    original_text: '提醒事项',
  }),
  event('approval_required', {
    ...binding,
    approval_id: receiptId,
    card_id: 'card-1',
    presentation_hash: 'frozen-presentation',
  }),
  ...terminals,
];

describe('explicit delegation stream decoding', () => {
  it.each(events)('decodes the v2 $type shape without changing its accepted payload', (input) => {
    const wire: unknown = JSON.parse(JSON.stringify(input));
    expect<unknown>(DelegationThreadEventSchema.parse(wire)).toEqual(input);
    expect<unknown>(ThreadEventSchema.parse(wire)).toEqual(input);
    expect(LegacyThreadEventSchema.safeParse(wire).success).toBe(false);
  });

  it('requires the trusted start revision and an explicit known lifecycle', () => {
    for (const field of ['authorization_revision', 'execution_lifecycle']) {
      const payload = { ...started.payload };
      delete payload[field];
      expect(DelegationThreadEventSchema.safeParse({ ...started, payload }).success).toBe(false);
    }
    for (const patch of [
      { authorization_revision: 'legacy' },
      { execution_lifecycle: 'unknown' },
      { stream_protocol_version: 'v1' },
      { injected_authority: true },
    ]) {
      expect(
        ThreadEventSchema.safeParse({ ...started, payload: { ...started.payload, ...patch } })
          .success,
      ).toBe(false);
    }
  });

  it('preserves the server-owned lifecycle in v2 without accepting it in v1', () => {
    const input = {
      ...started,
      payload: { ...started.payload, execution_lifecycle: 'server-owned' },
    };
    expect<unknown>(ThreadEventSchema.parse(input)).toEqual(input);
    expect(LegacyThreadEventSchema.safeParse(input).success).toBe(false);
  });

  it('keeps old-v1 decoding strict for new start fields, new terminal results and new versions', () => {
    const legacyStart = {
      protocol_version: 'v1',
      seq: 1,
      type: 'thread.started',
      request_id: 'historical-request',
      payload: {
        ...binding,
        stream_protocol_version: 'v1',
        ruleset_id: 'FIXTURE_V1',
        tzdb_version: 'fixture-v1',
      },
    };
    expect<unknown>(LegacyThreadEventSchema.parse(legacyStart)).toEqual(legacyStart);
    expect<unknown>(ThreadEventSchema.parse(legacyStart)).toEqual(legacyStart);
    expect(
      LegacyThreadEventSchema.safeParse({ ...legacyStart, protocol_version: 'v2' }).success,
    ).toBe(false);
    expect(ThreadEventSchema.safeParse({ ...legacyStart, protocol_version: 'v2' }).success).toBe(
      false,
    );
    for (const patch of [
      { authorization_revision: 'delegation/1' },
      { execution_lifecycle: 'request-bound' },
      { execution_lifecycle: 'server-owned' },
    ]) {
      expect(
        ThreadEventSchema.safeParse({
          ...legacyStart,
          payload: { ...legacyStart.payload, ...patch },
        }).success,
      ).toBe(false);
    }
    for (const terminal of terminals) {
      expect(ThreadEventSchema.safeParse({ ...terminal, protocol_version: 'v1' }).success).toBe(
        false,
      );
    }
  });

  it.each(terminals)(
    'requires a goal result on v2 $type and rejects envelope extensions',
    (terminal) => {
      const payload = { ...terminal.payload };
      delete payload.goal_result;
      expect(ThreadEventSchema.safeParse({ ...terminal, payload }).success).toBe(false);
      expect(ThreadEventSchema.safeParse({ ...terminal, extra: true }).success).toBe(false);
      expect(ThreadEventSchema.safeParse({ ...terminal, protocol_version: 'v3' }).success).toBe(
        false,
      );
    },
  );

  it('preserves explicit creation resolutions and rejects malformed collision references', () => {
    const resolution = {
      source_message_id: conversationId,
      source_quote: '创建报告',
      zero_write_invocation_ids: [runId],
      created_invocation_id: receiptId,
      read_invocation_id: conversationId,
    };
    const completed = terminals[0]!;
    const withResolution = (value: unknown) => ({
      ...completed,
      payload: {
        ...completed.payload,
        goal_result: { ...goal, outcomes: [{ ...goal.outcomes[0], create_resolution: value }] },
      },
    });
    expect(ThreadEventSchema.safeParse(withResolution(resolution)).success).toBe(true);
    for (const patch of [
      { zero_write_invocation_ids: [] },
      { zero_write_invocation_ids: [runId, runId] },
      { zero_write_invocation_ids: ['invalid'] },
      { source_quote: '' },
      { extra: true },
    ]) {
      expect(ThreadEventSchema.safeParse(withResolution({ ...resolution, ...patch })).success).toBe(
        false,
      );
    }
  });

  it.each(terminals)('decodes a complete bounded answer in $type', (terminal) => {
    for (const length of [8193, 1024 * 1024]) {
      const answer = 'x'.repeat(length);
      const input = {
        ...terminal,
        payload: { ...terminal.payload, goal_result: { ...goal, answer } },
      };
      const wire: unknown = JSON.parse(JSON.stringify(input));
      expect<unknown>(ThreadEventSchema.parse(wire)).toEqual(input);
    }
  });

  it('rejects malformed receipt references and bounded or unknown goal fields', () => {
    const completed = terminals[0]!;
    for (const receipt_refs of [
      ['not-a-uuid'],
      [runId, 'not-a-uuid'],
      [42],
      [null],
      Array(65).fill(receiptId),
    ]) {
      const invalidGoal = { ...goal, outcomes: [{ ...goal.outcomes[0], receipt_refs }] };
      expect(
        ThreadEventSchema.safeParse({
          ...completed,
          payload: { ...completed.payload, goal_result: invalidGoal },
        }).success,
      ).toBe(false);
    }
    for (const invalidGoal of [
      { ...goal, outcomes: [] },
      { ...goal, outcomes: Array(65).fill(goal.outcomes[0]) },
      { ...goal, answer: '' },
      { ...goal, answer: 'x'.repeat(1024 * 1024 + 1) },
      { ...goal, outcomes: [{ ...goal.outcomes[0], description: 'x'.repeat(8193) }] },
      { ...goal, status: 'done' },
      { ...goal, extra: true },
      { ...goal, outcomes: [{ ...goal.outcomes[0], extra: true }] },
      { ...goal, clarification: { kind: 'owner', question: '请选择' } },
      { ...goal, clarification: { kind: 'timezone', question: '请选择', extra: true } },
    ]) {
      expect(
        ThreadEventSchema.safeParse({
          ...completed,
          payload: { ...completed.payload, goal_result: invalidGoal },
        }).success,
      ).toBe(false);
    }
  });

  it('consumes typed clarification and structural receipts without duplicating producer aggregate validation', () => {
    const completed = terminals[0]!;
    const structuralGoal = {
      ...goal,
      status: 'partial',
      outcomes: [{ description: '待澄清目标', status: 'not_done', receipt_refs: [] }],
      clarification: { kind: 'timezone', question: '需要哪个时区？' },
    };
    expect(
      ThreadEventSchema.parse({
        ...completed,
        payload: { ...completed.payload, goal_result: structuralGoal },
      }),
    ).toMatchObject({ payload: { goal_result: structuralGoal } });
    // UUID shape is a consumer contract; receipt existence/owner/effect belongs
    // to producer-side domain validation before this event can be published.
    expect(ThreadEventSchema.safeParse(completed).success).toBe(true);
  });
});
