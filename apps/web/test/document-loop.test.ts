import { describe, expect, it } from 'bun:test';
import { ThreadEventSchema } from '@along/stream-protocol';
import { approvalHref } from '../src/lib/document-loop';

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
