import { expect, test } from 'bun:test';
import { readFeishuBotDocx } from '../src/features/office-connectors/feishu-bot-docx.js';

const documentId = 'a'.repeat(27);
const url = `https://test.feishu.cn/docx/${documentId}`;
const config = {
  appId: 'cli_abcdefghijkl',
  connectionId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
  ownerId: crypto.randomUUID(),
  secretEnv: 'BOT_SECRET',
  observationKeyEnv: 'BOT_KEY',
  documents: [url],
};
const env = { BOT_SECRET: 'synthetic' };

test('revocation during token exchange prevents Docx dispatch', async () => {
  let authorized = true;
  let requests = 0;
  const result = await readFeishuBotDocx(
    {
      config,
      url,
      signal: new AbortController().signal,
      authorized: async () => authorized,
    },
    async () => {
      requests++;
      authorized = false;
      return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 1200 });
    },
    env,
  );
  expect(result).toEqual({ status: 'error', reason: 'local_denied' });
  expect(requests).toBe(1);
});

test('provider refusal is distinct from local refusal and discards its body', async () => {
  const result = await readFeishuBotDocx(
    {
      config,
      url,
      signal: new AbortController().signal,
      authorized: async () => true,
    },
    async (endpoint) => {
      if (endpoint.endsWith('/internal'))
        return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 1200 });
      if (endpoint.endsWith('/raw_content'))
        return Response.json({ code: 1770032, data: { content: 'protected canary' } });
      return Response.json({
        code: 0,
        data: {
          document: {
            document_id: documentId,
            title: 'Fixture',
            revision_id: 1,
          },
        },
      });
    },
    env,
  );
  expect(result).toEqual({ status: 'error', reason: 'permission_denied' });
});
