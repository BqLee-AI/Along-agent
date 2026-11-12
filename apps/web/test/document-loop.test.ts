import { describe, expect, it } from 'bun:test';
import { ThreadEventSchema } from '@along/stream-protocol';
import { DocumentApprovalDetailSchema } from '@along/contracts';
import type { DocumentApprovalEffect } from '@along/contracts';
import {
  approvalHref,
  documentConfirmBody,
  documentEffectReadReducer,
} from '../src/features/approvals/model/document-loop';
import type { DocumentEffectRead } from '../src/features/approvals/model/document-loop';

const id = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';

describe('document loop browser consumers', () => {
  it('routes the existing approval event to the document page without changing task approvals', () => {
    const event = ThreadEventSchema.parse({
      protocol_version: 'v1',
      seq: 4,
      type: 'approval_required',
      request_id: 'document-consumer',
      payload: {
        conversation_id: id,
        run_id: runId,
        approval_id: id,
        card_id: `document-approval:${id}`,
        presentation_hash: 'c'.repeat(64),
      },
    });
    if (event.type !== 'approval_required') throw new Error('expected document approval event');
    expect(approvalHref(event.payload.approval_id, event.payload.card_id)).toBe(
      `/document-approvals/${id}`,
    );
    expect(approvalHref(id, 'task-card')).toBe(`/approvals/${id}`);
    expect(approvalHref(id, `document-approval:${runId}`)).toBe(`/approvals/${id}`);
  });
});

describe('exact document approval and independent effect reads', () => {
  const body = '\r\n  冻结正文\u00a0e\u0301\t\r\n末行空格  \n';
  const detail = DocumentApprovalDetailSchema.parse({
    kind: 'document_replace',
    approval_id: id,
    run_id: runId,
    conversation_id: id,
    workspace_id: 'managed-copy',
    relative_path: '资料/完整内容.md',
    base_read_invocation_id: id,
    base_version: 'a'.repeat(64),
    new_version: 'b'.repeat(64),
    exact_new_content: '  完整新正文\r\n',
    presentation_version: 'document_replace.v1',
    presentation_hash: 'c'.repeat(64),
    preview: { before: '旧正文\n', after: '新正文\n', body },
    replaces_approval_id: null,
    state: 'pending',
    apply_invocation_id: null,
    effect: {
      status: 'not_started',
      apply_invocation_id: null,
      read_invocation_id: null,
      successor_approval_id: null,
    },
  });

  it('submits only the frozen body without normalizing whitespace, Unicode or line endings', () => {
    const request = documentConfirmBody(detail, runId);
    const transmitted = JSON.parse(JSON.stringify(request));
    expect(new TextEncoder().encode(transmitted.seen_content)).toEqual(
      new TextEncoder().encode(body),
    );
    expect(transmitted).toEqual({
      presentation_hash: detail.presentation_hash,
      seen_content: body,
      idempotency_key: runId,
    });
    expect(transmitted.seen_content).not.toBe(detail.exact_new_content);
    expect(transmitted.seen_content).not.toBe(detail.preview.after);
    expect(documentConfirmBody(detail, runId)).toEqual(request);
  });

  it('does not manufacture not_started after an accepted decision followed by a failed effect GET', () => {
    let state: DocumentEffectRead = {
      value: detail.effect,
      reading: false,
      current: true,
      error: null,
    };
    state = documentEffectReadReducer(state, { type: 'invalidate' });
    state = documentEffectReadReducer(state, { type: 'start' });
    state = documentEffectReadReducer(state, { type: 'failure', message: 'HTTP 503' });
    expect(state.current).toBe(false);
    expect(state.error).toBe('HTTP 503');
    expect(state.value).toEqual(detail.effect);
    expect(state.reading).toBe(false);
  });

  it('keeps accepted effect evidence through failures and accepts only a subsequent successful read as current', () => {
    for (const status of [
      'reserved',
      'unknown',
      'failed',
      'conflict',
      'applied',
      'verified',
    ] as const) {
      const value: DocumentApprovalEffect = {
        ...detail.effect,
        status,
        apply_invocation_id: id,
        read_invocation_id: status === 'verified' ? runId : null,
      };
      let state: DocumentEffectRead = { value, current: true, reading: false, error: null };
      state = documentEffectReadReducer(state, { type: 'start' });
      state = documentEffectReadReducer(state, { type: 'failure', message: 'Connection lost' });
      expect(state.value).toEqual(value);
      expect(state.current).toBe(false);
      const latest = { ...value, status: 'verified' as const, read_invocation_id: runId };
      state = documentEffectReadReducer(state, { type: 'start' });
      state = documentEffectReadReducer(state, { type: 'success', value: latest });
      expect(state).toEqual({ value: latest, current: true, reading: false, error: null });
    }
  });
});
