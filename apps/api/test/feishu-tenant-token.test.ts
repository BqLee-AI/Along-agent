import { expect, test } from 'bun:test';
import { issueFeishuTenantToken } from '../src/features/office-connectors/feishu-tenant-token.js';

const input = {
  appId: 'cli_synthetic',
  appSecret: 'synthetic',
  signal: new AbortController().signal,
};

test('returns a tenant token and the provider expiry for a successful application exchange', async () => {
  const result = await issueFeishuTenantToken(input, async () =>
    Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 1200 }),
  );
  expect(result).toEqual({ token: 'synthetic-token', expiresInSeconds: 1200 });
});

test('rejects provider errors even if they contain a token and expiry', async () => {
  const result = await issueFeishuTenantToken(input, async () =>
    Response.json({ code: 10003, tenant_access_token: 'must-not-escape', expire: 1200 }),
  );
  expect(result).toBeNull();
});

test('never sends credentials after the caller aborts', async () => {
  let calls = 0;
  const result = await issueFeishuTenantToken(
    { ...input, signal: AbortSignal.abort() },
    async () => {
      calls++;
      return Response.json({ code: 0, tenant_access_token: 'must-not-escape', expire: 1200 });
    },
  );
  expect(result).toBeNull();
  expect(calls).toBe(0);
});
