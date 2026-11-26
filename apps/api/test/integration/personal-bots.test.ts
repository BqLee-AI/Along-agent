import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationListPageSchema } from '@along/contracts';
import { createHostProductRoutes } from '../../src/bin/host-product-routes.js';
import type { PersonalBotConfig } from '../../src/features/bots/public.js';
import { PersonalBotSchema } from '../../src/features/bots/schemas.js';
import type { SeededSession } from '../../src/features/identity/public.js';
import { configureWorkspaceRegistry } from '../../src/features/workspaces/public.js';
import { createApp } from '../../src/http/app.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const base = '/api/v1/bots';
const baseline = {
  name: 'Research',
  introduction: 'Independent purpose',
  role: 'Review source material',
  instructions: 'Cite original documents',
  model_selection: null,
  tool_ids: ['list_tasks'],
  workspace_ids: [],
} satisfies PersonalBotConfig;

type Handle = (request: Request) => Response | null | Promise<Response | null>;

maybe('owner-scoped personal Bots at both HTTP entries', () => {
  let db: IntegrationDatabase;
  let root: string;
  let owner: SeededSession;
  let other: SeededSession;
  let app: Handle;
  let product: Handle;
  const workspace = 'owned-research';
  const foreignWorkspace = randomUUID();

  beforeAll(async () => {
    db = await createIntegrationDatabase();
    owner = await seedAdmittedSession(db.pool);
    other = await seedAdmittedSession(db.pool);
    root = await mkdtemp(join(tmpdir(), 'along-bot-registry-'));
    const workspaceRoot = await realpath(root);
    const foreignRoot = join(workspaceRoot, 'foreign');
    const ownedRoot = join(workspaceRoot, 'owned');
    await Promise.all([mkdir(foreignRoot), mkdir(ownedRoot)]);
    expect(
      await configureWorkspaceRegistry([
        {
          workspace_id: workspace,
          owner_id: owner.userId,
          label: 'Owned',
          root: ownedRoot,
          readable_paths: [],
          writable_paths: [],
        },
        {
          workspace_id: foreignWorkspace,
          owner_id: other.userId,
          label: 'Foreign',
          root: foreignRoot,
          readable_paths: [],
          writable_paths: [],
        },
      ]),
    ).toMatchObject({ accepted: 2 });
    const deps = { pool: db.pool, tzdbVersion: 'fixture-v1' };
    const http = createApp(deps);
    app = (request) => http.handle(request);
    product = createHostProductRoutes(deps);
  });
  afterAll(async () => {
    await configureWorkspaceRegistry([]);
    if (root) await rm(root, { recursive: true, force: true });
    await db?.close();
  });

  async function request(
    handle: Handle,
    session: SeededSession | null,
    path: string,
    body?: unknown,
    options: { csrf?: boolean; key?: string; malformed?: boolean } = {},
  ) {
    const headers = new Headers({ 'x-request-id': 'personal-bot-contract' });
    if (session) {
      headers.set('cookie', `better-auth.session_token=${session.token}`);
      if (options.csrf !== false) headers.set('x-csrf-token', session.csrfToken);
    }
    if (options.key) headers.set('Idempotency-Key', options.key);
    if (body !== undefined || options.malformed) headers.set('content-type', 'application/json');
    const response = await handle(
      new Request(`http://localhost${path}`, {
        method: body === undefined && !options.malformed ? 'GET' : 'POST',
        headers,
        body: options.malformed ? '{' : JSON.stringify(body),
      }),
    );
    if (!response) throw new Error(`route did not reach its HTTP entry: ${path}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('personal-bot-contract');
    return {
      status: response.status,
      payload: (await response.json()) as { data: unknown; error: unknown },
    };
  }

  it('auth and CSRF precede malformed payloads, and foreign config is not returned or changed', async () => {
    for (const handle of [app, product]) {
      expect((await request(handle, null, base, undefined, { malformed: true })).status).toBe(401);
      expect(
        await request(handle, owner, base, undefined, { csrf: false, malformed: true }),
      ).toMatchObject({
        status: 403,
        payload: { error: { code: 'FORBIDDEN', details: { reason: 'CSRF_MISMATCH' } } },
      });
    }
    const own = await request(product, owner, base, baseline);
    const bot = PersonalBotSchema.parse(own.payload.data);
    const detail = `${base}/${bot.id}`;
    expect((await request(app, other, detail)).status).toBe(404);
    expect(
      (await request(product, other, detail, { revision: bot.revision, ...baseline })).status,
    ).toBe(404);
    expect((await request(app, other, base)).payload.data).toEqual({ items: [] });
    expect((await request(app, owner, detail)).payload.data).toEqual(bot);
  });

  it('saves a complete revision atomically and rejects foreign grant references without modifying it', async () => {
    const first = PersonalBotSchema.parse((await request(app, owner, base, baseline)).payload.data);
    const second = PersonalBotSchema.parse(
      (await request(app, owner, base, { ...baseline, name: 'Other job' })).payload.data,
    );
    const provider = randomUUID();
    const version = randomUUID();
    const foreignProvider = randomUUID();
    const foreignVersion = randomUUID();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [id, ver, uid] of [
        [provider, version, owner.userId],
        [foreignProvider, foreignVersion, other.userId],
      ]) {
        await client.query(
          'INSERT INTO model_providers (id,owner_id,name,current_version_id) VALUES ($1,$2,$3,$4)',
          [id, uid, id, ver],
        );
        await client.query(
          'INSERT INTO model_provider_versions (id,owner_id,provider_id,base_url) VALUES ($1,$2,$3,$4)',
          [ver, uid, id, 'https://provider.example.test/v1'],
        );
        await client.query(
          "INSERT INTO model_provider_models (provider_id,model_id) VALUES ($1,'fixture')",
          [id],
        );
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const path = `${base}/${first.id}`;
    const config = {
      ...baseline,
      role: 'Updated',
      model_selection: { provider_id: provider, model_id: 'fixture' },
      workspace_ids: [workspace],
    };
    const saved = { id: first.id, revision: first.revision + 1, config };
    expect(
      (await request(product, owner, path, { revision: first.revision, ...config })).payload.data,
    ).toEqual(saved);
    expect(
      (await request(app, owner, path, { revision: first.revision, ...baseline })).status,
    ).toBe(409);
    expect(
      (
        await request(product, owner, path, {
          revision: saved.revision,
          ...config,
          workspace_ids: [foreignWorkspace],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(product, owner, path, {
          revision: saved.revision,
          ...config,
          model_selection: { provider_id: foreignProvider, model_id: 'fixture' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app, owner, path, {
          revision: saved.revision,
          ...config,
          api_key: 'not-a-config-key',
        })
      ).status,
    ).toBe(400);
    expect((await request(app, owner, path)).payload.data).toEqual(saved);
    expect((await request(product, owner, `${base}/${second.id}`)).payload.data).toEqual(second);
  });

  it('replays concurrent creation, scopes pages and direct links, and never starts execution', async () => {
    const first = PersonalBotSchema.parse((await request(app, owner, base, baseline)).payload.data);
    const second = PersonalBotSchema.parse(
      (await request(app, owner, base, baseline)).payload.data,
    );
    const ownPath = `${base}/${first.id}/conversations`;
    const otherPath = `${base}/${second.id}/conversations`;
    const key = randomUUID();
    expect((await request(product, owner, ownPath, {})).status).toBe(400);
    expect((await request(product, other, ownPath, {}, { key })).status).toBe(404);
    const [a, b] = await Promise.all([
      request(app, owner, ownPath, {}, { key }),
      request(product, owner, ownPath, {}, { key }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(b.payload.data).toEqual(a.payload.data);
    const { conversation_id: cid } = a.payload.data as { conversation_id: string };
    expect((await request(product, owner, otherPath, {}, { key })).status).toBe(409);
    expect(
      (await request(app, owner, ownPath, { bot_id: second.id }, { key: randomUUID() })).status,
    ).toBe(400);
    expect((await request(app, owner, ownPath, {}, { key: randomUUID() })).status).toBe(200);
    const page = ConversationListPageSchema.parse(
      (await request(product, owner, `${ownPath}?limit=1`)).payload.data,
    );
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    expect((await request(app, owner, `${otherPath}?cursor=${page.next_cursor}`)).status).toBe(400);
    expect((await request(app, other, ownPath)).status).toBe(404);
    expect((await request(product, owner, otherPath)).payload.data).toEqual({
      items: [],
      next_cursor: null,
    });
    const tail = ConversationListPageSchema.parse(
      (await request(app, owner, `${ownPath}?cursor=${page.next_cursor}`)).payload.data,
    );
    expect([...page.items, ...tail.items].map((item) => item.conversation_id)).toContain(cid);
    expect((await request(app, owner, `/api/v1/conversations/${cid}/bot`)).payload.data).toEqual({
      bot_id: first.id,
    });
    expect((await request(app, other, `/api/v1/conversations/${cid}/bot`)).status).toBe(403);
    expect(
      (
        await db.pool.query(
          `SELECT bot_id, anchor_received_at_utc, title,
        (SELECT count(*)::int FROM messages WHERE conversation_id=c.id) AS messages,
        (SELECT count(*)::int FROM agent_runs WHERE conversation_id=c.id) AS runs,
        (SELECT count(*)::int FROM approvals WHERE conversation_id=c.id) AS approvals
       FROM conversations c WHERE id=$1`,
          [cid],
        )
      ).rows[0],
    ).toEqual({
      bot_id: first.id,
      anchor_received_at_utc: null,
      title: '',
      messages: 0,
      runs: 0,
      approvals: 0,
    });
    await expect(
      db.pool.query('UPDATE conversations SET bot_id=$2 WHERE id=$1', [cid, second.id]),
    ).rejects.toThrow('conversation Bot ownership is immutable');
    await expect(
      db.pool.query(
        'INSERT INTO conversations (id,owner_id,bot_id) VALUES (gen_random_uuid(),$1,$2)',
        [other.userId, first.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('revoking a Bot tool blocks a pending reminder confirmation while preserving accepted receipts', async () => {
    const botConfig = { ...baseline, tool_ids: ['propose_task', 'request_cancel_task'] };
    const bot = PersonalBotSchema.parse((await request(app, owner, base, botConfig)).payload.data);
    const { payload } = await request(
      app,
      owner,
      `${base}/${bot.id}/conversations`,
      {},
      { key: randomUUID() },
    );
    const { conversation_id } = payload.data as { conversation_id: string };
    async function propose(raw_text: string): Promise<string> {
      const res = await app(
        new Request('http://localhost/api/v1/conversations/messages', {
          method: 'POST',
          headers: {
            cookie: `better-auth.session_token=${owner.token}`,
            'x-csrf-token': owner.csrfToken,
            'content-type': 'application/json',
            'x-request-id': randomUUID(),
          },
          body: JSON.stringify({ conversation_id, raw_text, confirmed_timezone: 'Asia/Shanghai' }),
        }),
      );
      expect(res?.status).toBe(200);
      const frames = (await res!.text()).split('\n').filter((line) => line.startsWith('data:'));
      for (const frame of frames) {
        const event = JSON.parse(frame.slice(5));
        if (event.type === 'approval_required') return event.payload.approval_id as string;
      }
      throw new Error('reminder proposal did not produce approval_required');
    }
    async function confirmation(approval: string) {
      const url = `/api/v1/approvals/${approval}`;
      const { payload } = await request(app, owner, url);
      const detail = payload.data as { presentation_hash: string; echo_text: string };
      const body = {
        presentation_hash: detail.presentation_hash,
        seen_content: detail.echo_text,
        idempotency_key: randomUUID(),
      };
      return () => request(app, owner, `${url}/actions/confirm`, body);
    }
    const accepted = await confirmation(await propose('明天 9:20 提醒我喝水'));
    const first = await accepted();
    expect(first.status).toBe(200);
    const { task_id } = first.payload.data as { task_id: string };
    const cancelId = await propose(`取消任务 ${task_id}`);
    const pendingCancel = await confirmation(cancelId);
    const pendingCreateId = await propose('明天 10:20 提醒我整理资料');
    const pendingCreate = await confirmation(pendingCreateId);
    expect(
      (
        await request(product, owner, `${base}/${bot.id}`, {
          ...botConfig,
          revision: bot.revision,
          tool_ids: [],
        })
      ).status,
    ).toBe(200);
    expect((await pendingCancel()).status).toBe(403);
    expect((await pendingCreate()).status).toBe(403);
    expect((await accepted()).payload.data).toMatchObject({ task_id, duplicate: true });
    expect(
      (
        await db.pool.query(
          'SELECT id, state FROM approvals WHERE id=ANY($1::uuid[]) ORDER BY id',
          [[cancelId, pendingCreateId]],
        )
      ).rows,
    ).toEqual([cancelId, pendingCreateId].sort().map((id) => ({ id, state: 'pending' })));
  });
});
