import { describe, expect, it } from 'bun:test';
import {
  DelegatedWorkspaceReadInputSchema,
  WorkspaceReplaceInputSchema,
  WorkspaceReadInputSchema,
} from '../src/modules/tools/schemas.js';
import { DELEGATION_TOOL_DEFINITIONS } from '../src/modules/tools/catalog.js';

describe('delegated workspace gateway contracts', () => {
  it('requires an explicit workspace on delegated reads while preserving legacy shape', () => {
    expect(DelegatedWorkspaceReadInputSchema.safeParse({ path: 'memo.txt' }).success).toBe(false);
    expect(
      DelegatedWorkspaceReadInputSchema.safeParse({ workspace_id: 'one', path: 'memo.txt' })
        .success,
    ).toBe(true);
    expect(
      WorkspaceReadInputSchema.safeParse({ workspace_id: 'one', path: 'memo.txt' }).success,
    ).toBe(false);
  });

  it('binds direct edits to a full-read invocation without model-selected targets', () => {
    const read_invocation_id = 'bb727e0a-cb78-4a66-b2dd-4f89361edc48';
    expect(
      WorkspaceReplaceInputSchema.safeParse({
        read_invocation_id,
        change: { kind: 'full', new_content: '' },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceReplaceInputSchema.safeParse({
        read_invocation_id,
        change: { kind: 'literal', old_text: '', new_text: 'x' },
      }).success,
    ).toBe(false);
    expect(
      WorkspaceReplaceInputSchema.safeParse({
        read_invocation_id,
        path: 'other',
        change: { kind: 'full', new_content: 'x' },
      }).success,
    ).toBe(false);
    expect(DELEGATION_TOOL_DEFINITIONS.some((tool) => tool.name === 'workspace_replace')).toBe(
      true,
    );
  });
});
