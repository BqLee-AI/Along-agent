import { describe, expect, it } from 'bun:test';
import type { GoalResult } from '@along/contracts';
import type { RunGoalDocumentEvidence } from '../src/agent/tools/query.js';
import { validateGoalDocuments } from '../src/agent/operations/goal-result.js';
import {
  decodeWorkspaceContent,
  hydrateWorkspaceReadResult,
} from '../src/agent/tools/invocations/accepted-result.js';
import { hashBytes } from '../src/features/workspaces/public.js';

const apply = '00000000-0000-4000-8000-000000000001';
const read = '00000000-0000-4000-8000-000000000002';
const goal = (refs: string[]): GoalResult => ({
  status: 'completed',
  outcomes: [{ description: '保存资料', status: 'achieved', receipt_refs: refs }],
  clarification: null,
  answer: '已保存。',
});
const evidence = (
  status: 'applied' | 'verified' | 'conflict' | 'failed' | 'unknown',
): RunGoalDocumentEvidence => ({
  effects: [
    {
      workspace_id: 'test',
      path: 'memo.txt',
      invocation_id: apply,
      read_invocation_id: status === 'verified' ? read : null,
      version: null,
      status,
      superseded: false,
    },
  ],
  hasPendingApproval: false,
  resolvedApprovalInvocationIds: [],
});

describe('document GoalResult evidence', () => {
  it('requires an accepted effect and its independent verification receipt', () => {
    expect(() => validateGoalDocuments(goal([read]), evidence('verified'))).toThrow();
    expect(() => validateGoalDocuments(goal([apply]), evidence('verified'))).toThrow();
    expect(() => validateGoalDocuments(goal([apply, read]), evidence('verified'))).not.toThrow();
    expect(() => validateGoalDocuments(goal([apply]), evidence('applied'))).toThrow();
  });

  it('accepts a verified write and its fresh read in separate achieved outcomes', () => {
    const split: GoalResult = {
      ...goal([]),
      outcomes: [
        { description: '写入资料', status: 'achieved', receipt_refs: [apply] },
        { description: '重新读取并核对', status: 'achieved', receipt_refs: [read] },
      ],
    };
    expect(() => validateGoalDocuments(split, evidence('verified'))).not.toThrow();
    expect(() =>
      validateGoalDocuments(
        {
          ...split,
          status: 'partial',
          outcomes: [split.outcomes[0]!, { ...split.outcomes[1]!, status: 'not_done' }],
        },
        evidence('verified'),
      ),
    ).toThrow();
  });

  it('retains an accepted but unverified write as unfinished rather than achieved', () => {
    const partial: GoalResult = {
      status: 'blocked',
      outcomes: [
        { description: '写入已接受，尚未回读', status: 'not_done', receipt_refs: [apply] },
      ],
      clarification: null,
      answer: '尚未验证。',
    };
    expect(() => validateGoalDocuments(partial, evidence('applied'))).not.toThrow();
    expect(() =>
      validateGoalDocuments(
        { ...partial, outcomes: [{ ...partial.outcomes[0]!, receipt_refs: [] }] },
        evidence('applied'),
      ),
    ).toThrow();
  });

  it('does not turn conflicts, unknown effects or pending approvals into success', () => {
    for (const status of ['conflict', 'failed', 'unknown'] as const)
      expect(() => validateGoalDocuments(goal([apply]), evidence(status))).toThrow();
    expect(() =>
      validateGoalDocuments(goal([apply, read]), {
        ...evidence('verified'),
        hasPendingApproval: true,
      }),
    ).toThrow();
  });

  it('permits an explicitly superseded zero-write conflict only alongside a verified successor', () => {
    const verified = evidence('verified');
    const conflict = evidence('conflict').effects[0]!;
    const earlier = '00000000-0000-4000-8000-000000000003';
    const chain = {
      ...verified,
      effects: [{ ...conflict, invocation_id: earlier, superseded: true }, ...verified.effects],
    };
    expect(() => validateGoalDocuments(goal([apply, read]), chain)).not.toThrow();
    expect(() =>
      validateGoalDocuments(goal([apply, read]), {
        ...chain,
        effects: [{ ...chain.effects[0]!, superseded: false }, chain.effects[1]!],
      }),
    ).toThrow();
  });

  it('requires fresh verification for a created artifact and rejects zero-write failures', () => {
    const created = evidence('verified');
    created.effects[0]!.operation = 'create';
    expect(() => validateGoalDocuments(goal([apply]), created)).toThrow();
    expect(() => validateGoalDocuments(goal([apply, read]), created)).not.toThrow();
    const failed = evidence('failed');
    failed.effects[0]!.operation = 'create';
    expect(() => validateGoalDocuments(goal([apply]), failed)).toThrow();
  });

  it('hydrates a JSONB-safe NUL read and rejects malformed encoded bytes', () => {
    const content = 'before\u0000中文😀';
    const bytes = Buffer.from(content, 'utf8');
    const result = {
      status: 'ok',
      result: {
        kind: 'read',
        workspace_id: 'test',
        path: 'output/nul.txt',
        version: hashBytes(bytes),
        byte_length: bytes.length,
        content,
      },
    } as const;
    const envelope = {
      encoding: 'json-base64/1',
      data: Buffer.from(JSON.stringify(result), 'utf8').toString('base64'),
    };
    expect(hydrateWorkspaceReadResult(envelope)).toEqual(result);
    expect(() => decodeWorkspaceContent('YQ')).toThrow();
    expect(() => decodeWorkspaceContent('/w==')).toThrow();
    expect(() => hydrateWorkspaceReadResult({ ...envelope, unexpected: true })).toThrow();
  });
});
