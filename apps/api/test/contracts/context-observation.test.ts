import { describe, expect, it } from 'bun:test';
import { workspaceResultSchema } from '@along/contracts';

const source = '11111111-1111-4111-8111-111111111111';

describe('accepted context observation contract', () => {
  it('accepts a Unicode-scalar source page without claiming it is a fresh workspace read', () => {
    const page = {
      kind: 'context_slice',
      source_invocation_id: source,
      source_tool_id: 'workspace_read',
      source_result_version: 1,
      source_kind: 'read',
      field: 'content',
      unit: 'unicode_scalar',
      offset: 1,
      end: 3,
      total: 4,
      has_more: true,
      path: 'memo.txt',
      version: 'a'.repeat(64),
      byte_length: 9,
      content: '😀\r',
    } as const;
    const accepted = workspaceResultSchema.safeParse(page);
    expect(accepted.success).toBe(true);
    if (accepted.success) expect(accepted.data).toEqual(page);
    expect(workspaceResultSchema.safeParse({ ...page, owner_id: source }).success).toBe(false);
    expect(workspaceResultSchema.safeParse({ ...page, items: [] }).success).toBe(false);
    expect(workspaceResultSchema.safeParse({ ...page, content: '', end: 1 }).success).toBe(false);
    expect(workspaceResultSchema.safeParse({ ...page, content: '\uD83D', end: 2 }).success).toBe(
      false,
    );
  });
});
