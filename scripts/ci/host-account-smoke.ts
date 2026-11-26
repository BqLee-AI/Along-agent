import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as contracts from '@along/contracts';
import { createIntegrationDatabase } from '../../apps/api/test/integration/setup.js';
import { networkInterfaces } from 'node:os';
import type { NextRequest } from 'next/server';
import { MeSchema } from '../../apps/web/src/shared/session/identity.js';
import {
  loadIdentityKeyring,
  openIdentity,
} from '../../apps/api/src/features/identity/security/email-security.js';

const origin = 'http://localhost:3000';
const password = 'synthetic account smoke password';
const replacement = 'synthetic recovered smoke password';
const credential = 'synthetic-provider-credential-must-stay-private';
const proxy = 'ab'.repeat(32);
const requestId = 'host-account-smoke';
const database = await createIntegrationDatabase();
const port = process.argv[2] === 'legacy' ? '3098' : '3097';
const base = `http://127.0.0.1:${port}/api/v1`;
const external = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === 'IPv4' && !address.internal);
assert(external, 'run on a disposable Docker network');
const webBase = `http://${external.address}:${port}`;
process.env.API_BASE = webBase;
process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN = proxy;
// The Next route reads API_BASE at module initialization, after the test chooses its listener.
const web = await import('../../apps/web/src/app/api/[...path]/route.js');
const child = Bun.spawn(
  process.argv[2] === 'legacy' ? ['bun', 'apps/api/dist/main.js'] : ['/app/host/bin/along-host'],
  {
    env: {
      ...process.env,
      PORT: port,
      ROLE: 'api',
      TZDB_VERSION: 'fixture-v1',
      DATABASE_URL: database.connectionString,
      APP_ORIGIN: origin,
      BETTER_AUTH_SECRET: 'synthetic account smoke signing secret',
      IDENTITY_MAIL_PROVIDER: 'resend',
      IDENTITY_MAIL_FROM: 'smoke@example.test',
      IDENTITY_MAIL_API_KEY: 'synthetic-mail-never-submitted',
      MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      ALONG_LOCAL_MODEL_PROXY_TOKEN: proxy,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
);
const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);

type Session = { cookie: string; csrf: string };
async function request(
  path: string,
  expected: number,
  opts: {
    body?: unknown;
    session?: Session;
    method?: string;
    headers?: Record<string, string>;
    viaWeb?: boolean;
    outsideLoopback?: boolean;
  } = {},
) {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const init: RequestInit = {
    method,
    headers: {
      origin,
      'x-request-id': requestId,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.session ? { cookie: opts.session.cookie, 'x-csrf-token': opts.session.csrf } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    signal: AbortSignal.timeout(10_000),
  };
  const result = opts.viaWeb
    ? await (method === 'GET' ? web.GET : web.POST)(
        new Request(`${origin}/api/v1${path}`, init) as NextRequest,
        { params: Promise.resolve({ path: ['v1', ...path.split('?')[0]!.slice(1).split('/')] }) },
      )
    : await fetch((opts.outsideLoopback ? `${webBase}/api/v1` : base) + path, init);
  const text = await result.text();
  assert(!text.includes(credential), 'provider credential escaped in HTTP');
  assert.equal(result.status, expected, `${path}: ${result.status} ${text.slice(0, 100)}`);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-request-id'), requestId);
  const envelope = contracts.EnvelopeSchema.parse(JSON.parse(text));
  assert.equal(envelope.request_id, requestId);
  return { ...envelope, cookies: result.headers.getSetCookie(), headers: result.headers };
}

async function sessionFrom(cookies: string[]): Promise<Session> {
  assert(
    cookies.some(
      (cookie) => cookie.includes('better-auth.session_token=') && /HttpOnly/i.test(cookie),
    ),
  );
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const me = await request('/me', 200, { headers: { cookie } });
  const csrf = MeSchema.parse(me.data).csrf_token;
  assert(csrf);
  return { cookie, csrf };
}

async function deliveryToken(purpose: string) {
  const { rows } = await database.pool.query(
    'SELECT * FROM identity_mail_deliveries WHERE purpose=$1 ORDER BY created_at DESC LIMIT 1',
    [purpose],
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  const payload = JSON.parse(
    openIdentity(
      loadIdentityKeyring(),
      {
        ciphertext: row.payload_ciphertext,
        nonce: row.payload_nonce,
        tag: row.payload_tag,
        encryption_key_id: row.encryption_key_id,
      },
      `identity:delivery:${row.id}:${row.challenge_id}:${row.purpose}:${row.generation}`,
    ),
  );
  assert.equal(typeof payload.token, 'string');
  return payload.token as string;
}

try {
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => null);
    if (ready?.ok) break;
    if (attempt === 49 || child.exitCode !== null)
      throw new Error('account smoke service unavailable');
    await Bun.sleep(100);
  }
  contracts.authStatusSchema.parse((await request('/auth/status', 200)).data);
  const admin = await sessionFrom(
    (
      await request('/auth/initialize', 201, {
        body: { login_name: 'smoke_admin', password, display_name: 'Smoke administrator' },
      })
    ).cookies,
  );
  const contact = await request('/auth/contact/request', 202, {
    session: admin,
    body: { email: 'admin@example.test', current_password: password },
  });
  contracts.authContactRequestedSchema.parse(contact.data);
  await request('/auth/contact/verify', 200, {
    session: admin,
    body: { token: await deliveryToken('verify_contact') },
  });
  const inviteBody = {
    email: 'member@example.test',
    current_password: password,
    idempotency_key: randomUUID(),
  };
  const invitation = await request('/auth/invitations', 201, { session: admin, body: inviteBody });
  contracts.authInvitationCreatedSchema.parse(invitation.data);
  assert.deepEqual(
    (await request('/auth/invitations', 200, { session: admin, body: inviteBody })).data,
    invitation.data,
  );
  const accepted = await request('/auth/invitations/accept', 201, {
    body: {
      token: await deliveryToken('invitation'),
      login_name: 'smoke_member',
      password,
      display_name: 'Smoke member',
    },
    viaWeb: true,
  });
  contracts.authInvitationAcceptedSchema.parse(accepted.data);
  assert.deepEqual(accepted.cookies, []);
  const member = await sessionFrom(
    (
      await request('/auth/sign-in', 200, {
        body: { login_name: 'smoke_member', password },
        viaWeb: true,
      })
    ).cookies,
  );
  contracts.AccountViewSchema.parse(
    (await request('/auth/account', 200, { session: member })).data,
  );
  contracts.authSessionsSchema.parse(
    (await request('/auth/sessions?limit=1', 200, { session: member })).data,
  );
  await request('/auth/sessions?limit=1&limit=2', 400, { session: member });
  await request('/auth/status/', 404);
  await request('/auth/status', 404, { method: 'PUT' });
  await request('/auth/password/forgot', 202, { body: { email: 'member@example.test' } });
  const reset = await request('/auth/password/reset', 200, {
    viaWeb: true,
    body: { token: await deliveryToken('reset_password'), new_password: replacement },
  });
  contracts.authPasswordResetResultSchema.parse(reset.data);
  await request('/me', 401, { session: member });
  const recovered = await sessionFrom(
    (
      await request('/auth/sign-in', 200, {
        body: { email: 'member@example.test', password: replacement },
      })
    ).cookies,
  );
  const revoked = await request('/auth/sign-out', 200, {
    session: recovered,
    body: {},
    viaWeb: true,
  });
  assert(revoked.cookies.length > 1, 'sign-out must retain separate clearing cookies');
  assert(revoked.cookies.every((cookie) => /max-age=0/i.test(cookie)));
  await request('/me', 401, { session: recovered });

  const oversize = { name: 'z'.repeat(131072) };
  await request('/model-providers', 401, { body: oversize });
  await request('/model-providers', 403, {
    session: admin,
    body: oversize,
    headers: { 'x-csrf-token': 'invalid' },
  });
  await request('/model-providers', 413, { session: admin, body: oversize });
  await request('/model-providers', 413, { session: admin, body: oversize, viaWeb: true });
  await request('/model-providers', 403, {
    session: admin,
    body: { name: 'forbidden' },
    outsideLoopback: true,
    headers: {
      'x-along-host-tls': '1',
      'x-along-host-peer': '127.0.0.1',
      'x-along-host-local': '127.0.0.1',
      'x-forwarded-proto': 'https',
      'x-along-local-model-proxy': '0'.repeat(64),
    },
  });
  const created = contracts.ProviderViewSchema.parse(
    (
      await request('/model-providers', 200, {
        session: admin,
        body: { name: 'Smoke provider' },
      })
    ).data,
  );
  const providerPath = `/model-providers/${created.id}`;
  const settings = {
    enabled: true,
    base_url: 'https://provider.example.test/v1',
    credential: { action: 'replace', api_key: credential },
  };
  const updated = contracts.ProviderViewSchema.parse(
    (
      await request(`${providerPath}/actions/update`, 200, {
        session: admin,
        body: settings,
        viaWeb: true,
      })
    ).data,
  );
  assert.equal(updated.has_api_key, true);
  assert.equal(updated.key_hint, null);
  await request(`${providerPath}/models`, 200, { session: admin, body: { model_id: 'smoke' } });
  await request('/model-selection/actions/set-default', 200, {
    session: admin,
    body: { selection: { provider_id: updated.id, model_id: 'smoke' } },
  });
  assert.equal(
    contracts.ProviderListSchema.parse(
      (
        await request('/model-providers', 200, {
          session: admin,
        })
      ).data,
    ).default_selection?.model_id,
    'smoke',
  );
  assert.equal(
    (
      await database.pool.query(
        'SELECT count(*)::int AS count FROM identity_mail_deliveries WHERE status = $1',
        ['submitted'],
      )
    ).rows[0].count,
    0,
  );
  console.log('account, sessions, invitation, reset, cookies and provider settings passed');
} finally {
  child.kill('SIGTERM');
  await child.exited;
  assert(
    !(await output).some((text) => text.includes(credential)),
    'provider credential escaped in service diagnostics',
  );
  await database.close();
}
