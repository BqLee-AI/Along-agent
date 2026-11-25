import { describe, expect, test } from 'bun:test';
import { readFeishuDocx } from '../src/features/office-connectors/feishu/docx/read.js';
import { readFeishuBotDocx } from '../src/features/office-connectors/feishu/docx/read-bot.js';
import { issueFeishuTenantToken } from '../src/features/office-connectors/feishu/connections/tenant-token.js';
import {
  openFeishuBotObservation,
  openFeishuObservation,
  sealFeishuBotObservation,
  type FeishuBotDocxGrant,
} from '../src/features/office-connectors/public.js';
import { EnvelopeSchema } from '@along/contracts';
import { createApp } from '../src/http/app.js';

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

describe('Feishu bot Docx', () => {
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
});

describe('Feishu tenant token', () => {
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
});

describe('Feishu observation receipts', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const invocationId = '22222222-2222-4222-8222-222222222222';
  const runId = '33333333-3333-4333-8333-333333333333';
  const key = Buffer.alloc(32, 0x42);

  // Frozen v1 synthetic receipt: 12-byte nonce, ciphertext, 16-byte GCM tag.
  const legacyCiphertext =
    'FxcXFxcXFxcXFxcXh4D+3RKbHHepoFyRxLDbV0UGraxFE1k69hIr0wKlSMFkEA/YYmCWTpfV8ORXafuM';

  test('opens a historical receipt only under its original owner and invocation', () => {
    expect(openFeishuObservation(key, ownerId, invocationId, legacyCiphertext)).toEqual({
      content: 'historical receipt',
    });
    expect(() => openFeishuObservation(key, ownerId, runId, legacyCiphertext)).toThrow();
    expect(() => openFeishuObservation(key, runId, invocationId, legacyCiphertext)).toThrow();
  });

  test('bot receipts bind the run and grant and never fall back to legacy AAD', () => {
    const grant: FeishuBotDocxGrant = {
      kind: 'feishu-docx-bot/1',
      connectionId: '44444444-4444-4444-8444-444444444444',
      revision: '55555555-5555-4555-8555-555555555555',
      generation: '66666666-6666-4666-8666-666666666666',
      appId: 'cli_abcdefghijkl',
      sessionId: '77777777-7777-4777-8777-777777777777',
      url: 'https://test.feishu.cn/docx/TestDocument000000000000000',
    };
    const binding = { ownerId, invocationId, runId, grant };
    const result = { content: 'bot receipt' };
    const ciphertext = sealFeishuBotObservation(key, binding, JSON.stringify(result));
    expect(openFeishuBotObservation(key, binding, ciphertext)).toEqual(result);
    expect(() =>
      openFeishuBotObservation(key, { ...binding, runId: ownerId }, ciphertext),
    ).toThrow();
    expect(() =>
      openFeishuBotObservation(
        key,
        { ...binding, grant: { ...grant, generation: grant.revision } },
        ciphertext,
      ),
    ).toThrow();
    expect(() => openFeishuObservation(key, ownerId, invocationId, ciphertext)).toThrow();
    expect(() => openFeishuBotObservation(key, binding, legacyCiphertext)).toThrow();
  });
});

describe('Feishu HTTP routes', () => {
  const scheme = 'http://localhost:3000';
  const base = '/api/v1/office/feishu';
  const actor = {
    ownerId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Feishu connector test owner',
    timezoneId: null,
  };

  test('requires a signed session for bot status and actions', async () => {
    const anonymous = createApp({ pool: null, resolveActor: async () => null });
    const unsigned = createApp({
      pool: null,
      resolveActor: async () => ({ ...actor, sessionId: null }),
    });
    for (const [path, method] of [
      ['/bot', 'GET'],
      ['/bot/scan', 'POST'],
      ['/bot/cancel', 'POST'],
      ['/bot/disconnect', 'POST'],
    ]) {
      expect((await anonymous.handle(new Request(scheme + base + path, { method }))).status).toBe(
        401,
      );
      expect((await unsigned.handle(new Request(scheme + base + path, { method }))).status).toBe(
        403,
      );
    }
  });

  test('requires exact origin and CSRF before any bot action', async () => {
    const app = createApp({ pool: null, resolveActor: async () => actor });
    const origin = process.env.APP_ORIGIN ?? scheme;
    const foreign = await app.handle(
      new Request(`${scheme}${base}/bot/scan`, {
        method: 'POST',
        headers: { origin: 'https://untrusted.example' },
      }),
    );
    expect(foreign.status).toBe(403);
    expect(EnvelopeSchema.parse(await foreign.json()).error?.message).toBe('Origin mismatch');
    for (const action of ['scan', 'cancel', 'disconnect']) {
      const response = await app.handle(
        new Request(`${scheme}${base}/bot/${action}`, { method: 'POST', headers: { origin } }),
      );
      expect(response.status).toBe(403);
      expect(EnvelopeSchema.parse(await response.json()).error?.details).toMatchObject({
        reason: 'CSRF_MISMATCH',
      });
    }
  });

  test('legacy user OAuth routes are not registered', async () => {
    const app = createApp({ pool: null, resolveActor: async () => actor });
    const origin = process.env.APP_ORIGIN ?? scheme;
    for (const [path, method] of [
      ['/authorize', 'POST'],
      ['/callback?state=synthetic&code=synthetic', 'GET'],
      ['/pending', 'GET'],
      ['/confirm', 'POST'],
      ['/disconnect', 'POST'],
    ]) {
      const response = await app.handle(
        new Request(scheme + base + path, { method, headers: { origin } }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
      expect(EnvelopeSchema.parse(await response.json()).error?.code).toBe('NOT_FOUND');
    }
  });
});
