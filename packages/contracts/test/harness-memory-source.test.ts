import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HarnessMemorySourceSchema, ReadMemorySourceInputSchema } from '../src/harness.js';

const ids = Array.from({ length: 4 }, () => randomUUID());
const input = {
  recall_invocation_id: ids[0],
  memory_id: ids[1],
  message_id: ids[2],
  offset: 0,
  limit: 4096,
};
const source = {
  kind: 'memory_source',
  recall_invocation_id: ids[0],
  memory_id: ids[1],
  conversation_id: ids[3],
  message_id: ids[2],
  role: 'user',
  content: 'A😀',
  offset: 0,
  end: 2,
  total: 3,
  has_more: true,
};

test('source lookup bounds scalar slices and requires complete provenance', () => {
  expect(ReadMemorySourceInputSchema.safeParse(input).success).toBe(true);
  expect(ReadMemorySourceInputSchema.safeParse({ ...input, limit: 4097 }).success).toBe(false);
  expect(ReadMemorySourceInputSchema.safeParse({ ...input, owner_id: ids[3] }).success).toBe(false);
  expect(HarnessMemorySourceSchema.safeParse(source).success).toBe(true);
  expect(HarnessMemorySourceSchema.safeParse({ ...source, end: 3 }).success).toBe(false);
  expect(HarnessMemorySourceSchema.safeParse({ ...source, has_more: false }).success).toBe(false);
  expect(
    HarnessMemorySourceSchema.safeParse({
      ...source,
      content: 'a'.repeat(4097),
      end: 4097,
      total: 4097,
      has_more: false,
    }).success,
  ).toBe(false);
});
