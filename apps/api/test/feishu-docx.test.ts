import { expect, test } from 'bun:test';
import { readFeishuDocx } from '../src/features/office-connectors/feishu-docx.js';

const documentId = 'TestDocument000000000000000';
const input = {
  documentUrl: `https://test.feishu.cn/docx/${documentId}`,
  tenantAccessToken: 'synthetic-test-credential',
  signal: new AbortController().signal,
};

function document(revision_id: number) {
  return { document: { document_id: documentId, title: 'Test Doc', revision_id } };
}

test('rejects the body if the document revision changes while reading', async () => {
  const replies = [document(1), { content: 'Do not disclose this body.' }, document(2)];
  const result = await readFeishuDocx(input, async () =>
    Response.json({ code: 0, data: replies.shift() }),
  );
  expect(result).toEqual({ status: 'error', reason: 'version_changed' });
});

test('does not disclose a body attached to an upstream permission error', async () => {
  const result = await readFeishuDocx(input, async () =>
    Response.json(
      { code: 1770032, data: { content: 'Do not disclose this body.' } },
      { status: 403 },
    ),
  );
  expect(result).toEqual({ status: 'error', reason: 'permission_denied' });
});
