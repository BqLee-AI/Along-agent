import { afterEach, describe, expect, it } from 'bun:test';
import { DocumentApprovalDetailSchema, type RunView } from '@along/contracts';
import {
  confirmInlineDocument,
  inlineDocumentWaiting,
  readInlineDocument,
} from '../src/features/conversations/inline-document';

const id = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const detail = DocumentApprovalDetailSchema.parse({
  kind: 'document_replace',
  approval_id: id,
  run_id: runId,
  conversation_id: id,
  workspace_id: 'managed-copy',
  relative_path: '资料/原文.md',
  base_read_invocation_id: id,
  base_version: 'a'.repeat(64),
  new_version: 'b'.repeat(64),
  exact_new_content: '新正文\r\n',
  presentation_version: 'document_replace.v1',
  presentation_hash: 'c'.repeat(64),
  preview: { before: '旧正文\n', after: '新正文\n', body: '\r\n 冻结正文\t\n' },
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
const run: RunView = {
  run_id: runId,
  conversation_id: id,
  execution: 'harness',
  status: 'suspended_approval',
  attempt_id: id,
  attempt_no: 1,
  authorization_revision: 'delegation/1',
  can_resume: false,
  waiting: { checkpoint_id: id, invocation_id: id, approval_id: id, approval_kind: 'document' },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const envelope = (data: unknown) =>
  Response.json({ code: 0, msg: 'ok', request_id: 'document-inline', data });
const signal = () => new AbortController().signal;

describe('inline delegated document authorization', () => {
  it('only accepts the same delegated document waiting point', () => {
    expect(inlineDocumentWaiting(run, id)).toBe(true);
    expect(inlineDocumentWaiting({ ...run, authorization_revision: undefined }, id)).toBe(false);
    expect(inlineDocumentWaiting({ ...run, status: 'done' }, id)).toBe(false);
    expect(inlineDocumentWaiting(run, runId)).toBe(false);
  });
  it('reading remains GET only, including an already authorized decision', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return envelope({ ...detail, state: 'approved' });
    }) as typeof fetch;
    expect((await readInlineDocument(detail, signal())).state).toBe('approved');
    expect(methods).toEqual(['GET']);
  });
  it('submits the original exact frozen body with a stable key only after reading', async () => {
    const calls: { method: string; body: unknown }[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return init?.method === 'POST'
        ? envelope({ approval_id: id, status: 'approved', duplicate: false })
        : envelope(detail);
    }) as typeof fetch;
    await confirmInlineDocument({ initial: detail, run, csrf: 'csrf', signal: signal() });
    expect(calls).toEqual([
      { method: 'GET', body: null },
      {
        method: 'POST',
        body: {
          presentation_hash: detail.presentation_hash,
          seen_content: detail.preview.body,
          idempotency_key: id,
        },
      },
    ]);
  });
  it('never posts a changed preview or rejected decision', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return envelope({ ...detail, preview: { ...detail.preview, body: 'changed' } });
    }) as typeof fetch;
    await expect(
      confirmInlineDocument({ initial: detail, run, csrf: null, signal: signal() }),
    ).rejects.toThrow();
    expect(methods).toEqual(['GET']);
  });
  it('reads an already approved decision without posting again, and rejects a different run', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return envelope({ ...detail, state: 'approved' });
    }) as typeof fetch;
    expect(
      (await confirmInlineDocument({ initial: detail, run, csrf: null, signal: signal() })).state,
    ).toBe('approved');
    await expect(
      confirmInlineDocument({
        initial: detail,
        run: { ...run, run_id: id },
        csrf: null,
        signal: signal(),
      }),
    ).rejects.toThrow();
    expect(methods).toEqual(['GET']);
  });
});
