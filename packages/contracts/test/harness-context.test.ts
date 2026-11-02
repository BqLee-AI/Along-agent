import { expect, test } from 'bun:test';
import type { z } from 'zod';
import { HarnessRequestSchema, HarnessStartSchema } from '../src/harness.js';

const request = {
  protocol: 'harness/v6',
  request_ref: 'r1',
  type: 'measure_context',
  messages: [{ role: 'user', content: 'Full frozen input' }],
  remaining_tokens: null,
  max_output_tokens: 37,
} satisfies z.input<typeof HarnessRequestSchema>;

test('R2-A wire accepts an unknown actual balance without inventing a remaining budget', () => {
  expect(HarnessRequestSchema.parse(request)).toEqual(request);
  expect(HarnessRequestSchema.safeParse({ ...request, owner_id: 'untrusted' }).success).toBe(false);
  expect(HarnessRequestSchema.safeParse({ ...request, max_output_tokens: 0 }).success).toBe(false);
});

test('R2-A start retains all typed provenance and full immutable input', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const source = {
    result_version: 1,
    kind: 'read',
    omitted: true,
    path: 'source.txt',
    version: 'a'.repeat(64),
    byte_length: 200000,
    content_total: 100000,
  } as const;
  const start = {
    protocol: 'harness/v6',
    type: 'start',
    trusted_context: null,
    routing_policy: { revision: 'r2b/1', mode: 'off' },
    eligible_phase: 'disabled',
    context_policy: {
      revision: 'r2a/1',
      completion_cap: 37,
      model_window_tokens: null,
      input_meter: 'unavailable',
      meter_revision: 'unavailable/1',
      reserve_tokens: 0,
      model_binding: { model: 'fixture', adapter_revision: 'openai-chat/v1' },
    },
    messages: [{ message_id: id, role: 'user', content: 'Do not truncate this frozen input.' }],
    tools: [],
    budget: { max_iterations: 4, max_tokens: 1000 },
    snapshot: null,
    observations: [
      { view: 'projected', invocation_id: id, tool_id: 'workspace_read', outcome: 'ok', source },
    ],
    approval: null,
  } satisfies z.input<typeof HarnessStartSchema>;
  expect(HarnessStartSchema.parse(start)).toEqual(start);
  expect(
    HarnessStartSchema.safeParse({
      ...start,
      observations: [{ ...start.observations[0], source: { ...source, omitted: false } }],
    }).success,
  ).toBe(false);
});

test('R2-A wire accepts 256 complete messages and rejects message 257 without truncation', () => {
  const messages = Array.from({ length: 256 }, () => ({ role: 'user' as const, content: 'whole' }));
  expect(HarnessRequestSchema.safeParse({ ...request, messages }).success).toBe(true);
  const rejected = HarnessRequestSchema.safeParse({
    ...request,
    messages: [...messages, { role: 'user', content: 'must not be silently removed' }],
  });
  expect(rejected.success).toBe(false);
  if (!rejected.success) {
    expect(rejected.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['messages'],
        code: 'too_big',
        maximum: 256,
      }),
    );
  }
});
