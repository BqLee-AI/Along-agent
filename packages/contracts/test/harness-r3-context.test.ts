import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  HarnessR3ContextSchema,
  HarnessR3SnapshotSchema,
  HarnessRequestSchema,
} from '../src/harness.js';

const ids = Array.from({ length: 4 }, () => randomUUID());
const context = {
  manifest: { message_ids: ids.slice(0, 3) },
  summary: {
    id: randomUUID(),
    revision: '12345678901234567890',
    text: 'summary',
    message_ids: [ids[0], ids[2]],
  },
  messages: [{ message_id: ids[1], role: 'user', content: 'late historical fact' }],
  input: { type: 'user', message_id: ids[3], content: 'complete input' },
};
const snapshot = {
  version: 4,
  original_manifest: context.manifest,
  original_summary: { id: context.summary.id, revision: context.summary.revision },
  context,
  tool_refs: [],
  next_call_no: 1,
  usage: { iterations: 2, tokens: null },
  waiting: null,
  native_state: {
    protected_messages: [],
    history_index: 0,
    units: [],
    hard_denied: '',
    closing_goal: false,
    pending_model: null,
  },
};

test('v8 validates exact interleaved coverage without conflating input and history', () => {
  expect(HarnessR3ContextSchema.safeParse(context).success).toBe(true);
  expect(HarnessR3ContextSchema.safeParse({ ...context, messages: [] }).success).toBe(false);
  expect(
    HarnessR3ContextSchema.safeParse({
      ...context,
      summary: { ...context.summary, message_ids: [ids[2], ids[0]] },
    }).success,
  ).toBe(false);
  expect(
    HarnessR3ContextSchema.safeParse({
      ...context,
      input: { ...context.input, message_id: ids[0] },
    }).success,
  ).toBe(false);
  expect(
    HarnessR3ContextSchema.safeParse({ ...context, summary: null, messages: [] }).success,
  ).toBe(false);
  expect(
    HarnessR3ContextSchema.safeParse({ ...context, input: { type: 'compact_control' } }).success,
  ).toBe(true);
});

test('v4 snapshots are exclusive to v8 and bind the immutable manifest', () => {
  expect(HarnessR3SnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(
    HarnessR3SnapshotSchema.safeParse({ ...snapshot, original_manifest: { message_ids: [] } })
      .success,
  ).toBe(false);
  const request = { type: 'pause_point', request_ref: 'r1', context: snapshot };
  expect(HarnessRequestSchema.safeParse({ ...request, protocol: 'harness/v8' }).success).toBe(true);
  expect(HarnessRequestSchema.safeParse({ ...request, protocol: 'harness/v7' }).success).toBe(
    false,
  );
});

test('context preview is v8-only and may truthfully report exhausted budget', () => {
  const preview = {
    type: 'context_preview',
    request_ref: 'r1',
    messages: [{ role: 'user', content: 'complete current input' }],
    remaining_tokens: 0,
    max_output_tokens: 0,
    pending_model: true,
  };
  expect(HarnessRequestSchema.safeParse({ ...preview, protocol: 'harness/v8' }).success).toBe(true);
  expect(HarnessRequestSchema.safeParse({ ...preview, protocol: 'harness/v7' }).success).toBe(
    false,
  );
});

test('only v8 may propose automatic compact on a pause probe', () => {
  const probe = { type: 'pause_probe', request_ref: 'r1' };
  expect(
    HarnessRequestSchema.safeParse({ ...probe, protocol: 'harness/v8', auto_compact: true })
      .success,
  ).toBe(true);
  expect(
    HarnessRequestSchema.safeParse({ ...probe, protocol: 'harness/v8', auto_compact: false })
      .success,
  ).toBe(false);
  expect(
    HarnessRequestSchema.safeParse({ ...probe, protocol: 'harness/v7', auto_compact: true })
      .success,
  ).toBe(false);
  expect(HarnessRequestSchema.safeParse({ ...probe, protocol: 'harness/v7' }).success).toBe(true);
});
