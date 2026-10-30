import { describe, expect, it } from 'bun:test';
import {
  HarnessApprovalDecisionSchema,
  HarnessCancelSchema,
  HarnessReplySchema,
  HarnessModelStepSchema,
  HarnessRequestSchema,
  HarnessSnapshotSchema,
  HarnessStartSchema,
} from '../src/harness.js';

const approvalId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const invocationId = '00000000-0000-4000-8000-000000000003';
const messageId = '00000000-0000-4000-8000-000000000004';
const snapshot = {
  version: 2,
  message_refs: [messageId],
  tool_refs: [invocationId],
  next_call_no: 2,
  usage: { iterations: 1, tokens: null },
  waiting: { invocation_id: invocationId, approval_id: approvalId },
};
const start = {
  protocol: 'harness/v3',
  type: 'start',
  messages: [{ message_id: messageId, role: 'user', content: 'Read the registered workspace.' }],
  tools: [],
  budget: { max_iterations: 8, max_tokens: 8000 },
  snapshot: null,
  observations: [],
  approval: null,
};
const workspace = {
  workspace_id: 'documents',
  label: 'My documents',
  readable_paths: ['sources', 'brief.md'],
  writable_paths: ['brief.md'],
};

function acceptsDecision(decision: unknown) {
  expect<unknown>(HarnessApprovalDecisionSchema.parse(decision)).toEqual(decision);
  expect<unknown>(HarnessStartSchema.parse({ ...start, approval: decision }).approval).toEqual(
    decision,
  );
}

function rejectsDecision(decision: unknown) {
  expect(HarnessApprovalDecisionSchema.safeParse(decision).success).toBe(false);
  expect(HarnessStartSchema.safeParse({ ...start, approval: decision }).success).toBe(false);
}

describe('harness/v3 executable contract with snapshot2', () => {
  it('retains all five typed task decision states and their real references', () => {
    for (const status of ['pending', 'consumed', 'rejected', 'expired', 'superseded'] as const) {
      acceptsDecision({
        kind: 'task',
        approval_id: approvalId,
        status,
        task_id: status === 'consumed' ? taskId : null,
        successor_id: status === 'superseded' ? taskId : null,
      });
    }
  });

  it('requires a real task_id for consumed task decisions', () => {
    const consumed = {
      kind: 'task',
      approval_id: approvalId,
      status: 'consumed',
      successor_id: null,
    };
    for (const task_id of [undefined, null, '', 'not-a-uuid'])
      rejectsDecision({ ...consumed, task_id });
    acceptsDecision({ ...consumed, task_id: taskId });
  });

  it('types document authorization separately with a nullable apply invocation', () => {
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      for (const apply_invocation_id of [null, invocationId]) {
        acceptsDecision({
          kind: 'document',
          approval_id: approvalId,
          status,
          apply_invocation_id,
        });
      }
    }
  });

  it('rejects fake task results and cross-kind states or fields on document decisions', () => {
    const document = {
      kind: 'document',
      approval_id: approvalId,
      status: 'approved',
      apply_invocation_id: null,
    };
    rejectsDecision({ ...document, task_id: taskId });
    rejectsDecision({ ...document, task_id: null });
    rejectsDecision({ ...document, successor_id: null });
    for (const status of ['consumed', 'expired', 'superseded'])
      rejectsDecision({ ...document, status });
    rejectsDecision({ ...document, apply_invocation_id: 'not-a-uuid' });
    rejectsDecision({ kind: 'document', approval_id: approvalId, status: 'approved' });
    rejectsDecision({
      kind: 'task',
      approval_id: approvalId,
      status: 'approved',
      task_id: taskId,
      successor_id: null,
    });
    rejectsDecision({
      approval_id: approvalId,
      status: 'consumed',
      task_id: taskId,
      successor_id: null,
    });
  });

  it('accepts omitted, null or strict safe workspace summaries without exposing a root', () => {
    expect<unknown>(HarnessStartSchema.parse(start)).toEqual(start);
    expect(HarnessStartSchema.parse({ ...start, workspace: null }).workspace).toBeNull();
    expect(HarnessStartSchema.parse({ ...start, workspace }).workspace).toEqual(workspace);
    for (const extra of [
      { root: '/private/documents' },
      { owner_id: approvalId },
      { allowlist: ['workspace_apply_replace'] },
      { unexpected: true },
    ]) {
      expect(
        HarnessStartSchema.safeParse({ ...start, workspace: { ...workspace, ...extra } }).success,
      ).toBe(false);
    }
    for (const malformed of [
      { ...workspace, workspace_id: 1 },
      { ...workspace, label: null },
      { ...workspace, readable_paths: 'sources' },
      { ...workspace, writable_paths: [1] },
      { workspace_id: workspace.workspace_id, label: workspace.label },
    ])
      expect(HarnessStartSchema.safeParse({ ...start, workspace: malformed }).success).toBe(false);
  });

  it('accepts snapshot2 references and rejects native-supplied approval kinds', () => {
    expect<unknown>(HarnessSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect<unknown>(HarnessStartSchema.parse({ ...start, snapshot }).snapshot).toEqual(snapshot);
    expect(
      HarnessRequestSchema.parse({
        protocol: 'harness/v3',
        type: 'snapshot',
        request_ref: 'snapshot-1',
        context: snapshot,
      }),
    ).toMatchObject({ context: snapshot });
    expect(
      HarnessSnapshotSchema.safeParse({
        ...snapshot,
        waiting: { ...snapshot.waiting, kind: 'document' },
      }).success,
    ).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v3',
        type: 'suspend',
        request_ref: 'suspend-1',
        checkpoint_ref: messageId,
        invocation_id: invocationId,
        approval_id: approvalId,
        kind: 'document',
      }).success,
    ).toBe(false);
  });

  it('accepts correlated model pulls and bounded delta-or-complete replies only', () => {
    expect(
      HarnessRequestSchema.parse({
        protocol: 'harness/v3',
        type: 'model_next',
        request_ref: 'next-1',
        model_ref: 'model-1',
      }),
    ).toMatchObject({ model_ref: 'model-1' });
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v3',
        type: 'model_next',
        request_ref: 'next-1',
      }).success,
    ).toBe(false);
    expect(HarnessModelStepSchema.parse({ type: 'delta', delta: '中文😀' })).toEqual({
      type: 'delta',
      delta: '中文😀',
    });
    for (const delta of ['', 'x'.repeat(4001)]) {
      expect(HarnessModelStepSchema.safeParse({ type: 'delta', delta }).success).toBe(false);
      expect(
        HarnessRequestSchema.safeParse({
          protocol: 'harness/v3',
          type: 'answer',
          request_ref: 'answer-1',
          delta,
        }).success,
      ).toBe(false);
    }
    expect(
      HarnessModelStepSchema.parse({
        type: 'complete',
        reply: { message: { content: '中文😀', tool_calls: [] }, usage: null },
      }),
    ).toMatchObject({ type: 'complete' });
    expect(
      HarnessModelStepSchema.safeParse({
        message: { content: 'old complete reply', tool_calls: [] },
        usage: null,
      }).success,
    ).toBe(false);
    expect(HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v2' }).success).toBe(false);
  });
  it('rejects v1 executable frames and v1 snapshots rather than running a fallback protocol', () => {
    expect(HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v1' }).success).toBe(false);
    const legacy = { ...snapshot, version: 1 };
    expect(HarnessSnapshotSchema.safeParse(legacy).success).toBe(false);
    expect(HarnessStartSchema.safeParse({ ...start, snapshot: legacy }).success).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v3',
        type: 'snapshot',
        request_ref: 'snapshot-1',
        context: legacy,
      }).success,
    ).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v1',
        type: 'answer',
        request_ref: 'answer-1',
        delta: 'legacy answer',
      }).success,
    ).toBe(false);
    expect(
      HarnessReplySchema.safeParse({
        protocol: 'harness/v1',
        type: 'reply',
        reply_to: 'answer-1',
        value: null,
      }).success,
    ).toBe(false);
    expect(
      HarnessCancelSchema.safeParse({
        protocol: 'harness/v1',
        type: 'cancel',
        reason: 'legacy cancel',
      }).success,
    ).toBe(false);
  });
});
