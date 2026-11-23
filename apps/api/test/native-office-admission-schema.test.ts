import { describe, expect, test } from 'bun:test';
import { SendMessageBodySchema } from '../src/features/conversations/schemas.js';

const id = '8f81eb23-03b4-4448-b8fa-ef7baa0da399';
const base = {
  execution: 'harness',
  authorization_revision: 'delegation/1',
  raw_text: '请分析我选择的任务表',
};

describe('office request admission schema', () => {
  test('accepts a selected CSV with an explicit draft', () => {
    const input = { ...base, office_materials: { draft_id: id, tasks_attachment_id: id } };
    expect(SendMessageBodySchema.safeParse(input).success).toBe(true);
  });

  test('rejects an empty selection or unsupported execution profile', () => {
    expect(
      SendMessageBodySchema.safeParse({ ...base, office_materials: { draft_id: id } }).success,
    ).toBe(false);
    expect(
      SendMessageBodySchema.safeParse({
        ...base,
        execution: 'business',
        office_materials: { draft_id: id, tasks_attachment_id: id },
      }).success,
    ).toBe(false);
  });
});
