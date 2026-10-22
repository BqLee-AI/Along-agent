// Thread-event envelope unit tests (issue #9): strictness, version pin,
// frozen seven-word vocabulary, and EVENT_TYPES untouched.
import { describe, expect, it } from 'bun:test';
import {
  EVENT_TYPES,
  THREAD_EVENT_TYPES,
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
} from '../src/index.js';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';

function base(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    protocol_version: 'v1',
    seq: 1,
    type,
    payload,
    request_id: 'req-1',
    ...extra,
  };
}

describe('thread-events', () => {
  it('pins protocol version to v1', () => {
    expect(THREAD_PROTOCOL_VERSION).toBe('v1');
    const bad = base('thread.started', {
      conversation_id: CONVERSATION_ID,
      run_id: RUN_ID,
      stream_protocol_version: 'v1',
      ruleset_id: 'rs',
      tzdb_version: '2024a',
    });
    bad.protocol_version = 'v2';
    expect(ThreadEventSchema.safeParse(bad).success).toBe(false);
  });

  it('holds exactly the seven frozen thread words', () => {
    expect<readonly string[]>([...THREAD_EVENT_TYPES].sort()).toEqual(
      [
        'approval_required',
        'card.proposed',
        'message.delta',
        'thread.cancelled',
        'thread.completed',
        'thread.failed',
        'thread.started',
      ].sort(),
    );
  });

  it('parses the happy-path event sequence', () => {
    const events: Array<[string, Record<string, unknown>]> = [
      [
        'thread.started',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          stream_protocol_version: 'v1',
          ruleset_id: 'rs',
          tzdb_version: '2024a',
        },
      ],
      ['message.delta', { conversation_id: CONVERSATION_ID, run_id: RUN_ID, delta: '收到' }],
      [
        'card.proposed',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          card_id: 'card_1',
          schema_version: 'v1',
          wall_time: '2026-10-17 09:20',
          timezone_id: 'Asia/Shanghai',
          original_text: '明天 9:20 喝水',
        },
      ],
      [
        'approval_required',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          approval_id: APPROVAL_ID,
          card_id: 'card_1',
          presentation_hash: 'ph_abc',
        },
      ],
      [
        'thread.completed',
        { conversation_id: CONVERSATION_ID, run_id: RUN_ID, approval_id: APPROVAL_ID },
      ],
    ];
    events.forEach(([type, payload], i) => {
      const parsed = ThreadEventSchema.safeParse(base(type, payload, { seq: i + 1 }));
      expect(parsed.success).toBe(true);
    });
  });

  it('rejects extra fields on every event', () => {
    const payloads: Array<[string, Record<string, unknown>]> = [
      [
        'thread.started',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          stream_protocol_version: 'v1',
          ruleset_id: 'rs',
          tzdb_version: '2024a',
          extra: 1,
        },
      ],
      ['message.delta', { conversation_id: CONVERSATION_ID, run_id: RUN_ID, delta: 'x', extra: 1 }],
      [
        'card.proposed',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          card_id: 'c',
          schema_version: 'v1',
          wall_time: 'w',
          timezone_id: 'tz',
          original_text: 't',
          extra: 1,
        },
      ],
      [
        'approval_required',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          approval_id: APPROVAL_ID,
          card_id: 'c',
          presentation_hash: 'ph',
          extra: 1,
        },
      ],
      [
        'thread.completed',
        { conversation_id: CONVERSATION_ID, run_id: RUN_ID, approval_id: null, extra: 1 },
      ],
      [
        'thread.failed',
        {
          conversation_id: CONVERSATION_ID,
          run_id: RUN_ID,
          error: { code: 'X', message: 'm', http_status: 422 },
          extra: 1,
        },
      ],
      ['thread.cancelled', { conversation_id: CONVERSATION_ID, run_id: RUN_ID, extra: 1 }],
    ];
    for (const [type, payload] of payloads) {
      expect(ThreadEventSchema.safeParse(base(type, payload)).success, type).toBe(false);
    }
  });

  it('rejects extra envelope fields and non-positive seq', () => {
    const ok = base('thread.cancelled', { conversation_id: CONVERSATION_ID, run_id: RUN_ID });
    expect(ThreadEventSchema.safeParse({ ...ok, trailing: true }).success).toBe(false);
    expect(ThreadEventSchema.safeParse({ ...ok, seq: 0 }).success).toBe(false);
  });

  it('accepts thread.completed with null approval', () => {
    const parsed = ThreadEventSchema.safeParse(
      base('thread.completed', {
        conversation_id: CONVERSATION_ID,
        run_id: RUN_ID,
        approval_id: null,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('keeps EVENT_TYPES as the seven task-ledger words', () => {
    expect<readonly string[]>([...EVENT_TYPES].sort()).toEqual(
      [
        'cancel_requested',
        'cancelled',
        'created',
        'fired',
        'missed',
        'reconciliation_run',
        'scheduled',
      ].sort(),
    );
  });
  it('requires exact ordered structured ambiguity details and time-error status', () => {
    const details = {
      wall_time: '2026-11-01T01:30:00',
      timezone_id: 'America/New_York',
      ruleset_id: 'FIXTURE_V1',
      candidates: [
        { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
        { fold_choice: 'second', offset_seconds: -18000, fire_at_utc: '2026-11-01T06:30:00Z' },
      ],
    };
    const event = base('thread.failed', {
      conversation_id: CONVERSATION_ID,
      run_id: RUN_ID,
      error: { code: 'AMBIGUOUS_LOCAL_TIME', message: '请选择', http_status: 422, details },
    });
    expect(ThreadEventSchema.safeParse(event).success).toBe(true);
    for (const invalid of [
      undefined,
      '请选择第一次',
      { ...details, candidates: details.candidates.slice(0, 1) },
      { ...details, candidates: [...details.candidates, details.candidates[1]] },
      { ...details, candidates: [...details.candidates].reverse() },
      {
        ...details,
        candidates: [
          { ...details.candidates[0], fire_at_utc: '2026-11-01T07:30:00Z' },
          details.candidates[1],
        ],
      },
      {
        ...details,
        candidates: [
          { fold_choice: 'first', fire_at_utc: '2026-11-01T05:30:00Z' },
          details.candidates[1],
        ],
      },
      {
        ...details,
        candidates: [{ ...details.candidates[0], offset_seconds: -14400.5 }, details.candidates[1]],
      },
      { ...details, wall_time: '01:30' },
      { ...details, extra: 'not on the wire' },
    ]) {
      expect(
        ThreadEventSchema.safeParse({
          ...event,
          payload: {
            ...event.payload,
            error: {
              code: 'AMBIGUOUS_LOCAL_TIME',
              message: 'm',
              http_status: 422,
              details: invalid,
            },
          },
        }).success,
      ).toBe(false);
    }
    for (const [code, http_status] of [
      ['TZDB_UNAVAILABLE', 422],
      ['UNKNOWN_TIMEZONE', 503],
      ['NONEXISTENT_LOCAL_TIME', 503],
      ['AMBIGUOUS_LOCAL_TIME', 503],
    ]) {
      expect(
        ThreadEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, error: { code, message: 'm', http_status, details } },
        }).success,
      ).toBe(false);
    }
  });
});
