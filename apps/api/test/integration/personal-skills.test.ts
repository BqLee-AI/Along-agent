import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  SKILL_FILE_MAX_BYTES,
  SkillDetailSchema,
  SkillImportPreviewSchema,
  SkillListPageSchema,
} from '@along/contracts';
import { createHostProductRoutes } from '../../src/bin/host-product-routes.js';
import { withTransaction } from '../../src/db/transaction.js';
import type { SeededSession } from '../../src/features/identity/public.js';
import {
  assertSkillActive,
  listAssignedSkills,
  lockAdmittedSkill,
  validateAssignedSkills,
} from '../../src/features/skills/public.js';
import { createApp } from '../../src/http/app.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const root = '/api/v1/skills';
const fields = {
  name: 'weekly-report',
  description: 'Organize the report',
  body: 'List evidence.',
};
const file = [
  '---',
  'name: weekly-report',
  'description: Organize the report',
  'allowed-tools: search',
  'metadata:',
  '  team: narrative',
  '---',
  'Read [reference](./reference.md) as text.',
  '',
].join('\r\n');

type Handle = (request: Request) => Response | null | Promise<Response | null>;

maybe('personal text skills at both HTTP entry points', () => {
  let db: IntegrationDatabase;
  let owner: SeededSession;
  let other: SeededSession;
  let app: Handle;
  let product: Handle;

  beforeAll(async () => {
    db = await createIntegrationDatabase();
    owner = await seedAdmittedSession(db.pool);
    other = await seedAdmittedSession(db.pool);
    const deps = { pool: db.pool, tzdbVersion: 'fixture-v1' };
    const http = createApp(deps);
    app = (request) => http.handle(request);
    product = createHostProductRoutes(deps);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function send(
    handle: Handle,
    path: string,
    options: {
      session?: SeededSession | null;
      method?: string;
      key?: string;
      body?: unknown;
      file?: string | Uint8Array<ArrayBuffer>;
      csrf?: boolean;
    } = {},
  ) {
    const { session = owner, method = 'GET', key, file, body, csrf = true } = options;
    const headers = new Headers({ 'x-request-id': 'skills-contract' });
    if (session) {
      headers.set('cookie', `better-auth.session_token=${session.token}`);
      if (csrf) headers.set('x-csrf-token', session.csrfToken);
    }
    if (key) headers.set('Idempotency-Key', key);
    if (file !== undefined) headers.set('content-type', 'text/markdown');
    else if (body !== undefined) headers.set('content-type', 'application/json');
    const reply = await handle(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        body: file ?? JSON.stringify(body),
      }),
    );
    if (!reply) throw new Error(`skills route was not dispatched: ${path}`);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.headers.get('x-request-id')).toBe('skills-contract');
    const { data, error } = (await reply.json()) as { data: unknown; error: unknown };
    return { status: reply.status, data, error };
  }

  it('authenticates both reads and writes and checks CSRF before parsing', async () => {
    for (const handle of [app, product]) {
      expect((await send(handle, root, { session: null })).status).toBe(401);
      for (const [method, path] of [
        ['POST', root],
        ['POST', `${root}/actions/preview-import`],
        ['PATCH', `${root}/${randomUUID()}`],
        ['POST', `${root}/${randomUUID()}/actions/disable`],
      ] as const) {
        const invalid = new Uint8Array([0xff]);
        expect((await send(handle, path, { method, file: invalid, session: null })).status).toBe(
          401,
        );
        expect(await send(handle, path, { method, file: invalid, csrf: false })).toMatchObject({
          status: 403,
          error: { code: 'FORBIDDEN', details: { reason: 'CSRF_MISMATCH' } },
        });
      }
    }
  });

  it('previews and saves the same raw file, preserves the body, and does not persist extras', async () => {
    const session = await seedAdmittedSession(db.pool);
    const preview = `${root}/actions/preview-import`;
    const options = { session, method: 'POST', file };
    const result = await send(product, preview, options);
    expect(result.status).toBe(200);
    expect(SkillImportPreviewSchema.parse(result.data)).toEqual({
      name: fields.name,
      description: fields.description,
      body: 'Read [reference](./reference.md) as text.\r\n',
      extras: { 'allowed-tools': 'search', metadata: { team: 'narrative' } },
    });
    expect((await send(app, root, { session })).data).toEqual({ items: [], next_cursor: null });

    const key = randomUUID();
    const saved = await send(app, root, { ...options, key });
    expect(saved.status).toBe(200);
    const skill = SkillDetailSchema.parse(saved.data);
    expect(skill.body).toBe('Read [reference](./reference.md) as text.\r\n');
    expect((await send(product, root, { ...options, key })).data).toEqual(skill);
    expect((await send(product, root, { ...options, key, file: `${file}\r\n` })).status).toBe(409);

    const listed = SkillListPageSchema.parse((await send(product, root, { session })).data);
    expect(listed).toEqual({
      items: [
        {
          id: skill.id,
          revision: skill.revision,
          name: skill.name,
          description: skill.description,
          disabled_at: skill.disabled_at,
        },
      ],
      next_cursor: null,
    });
  });

  it('rejects unsafe or invalid import and field text without creating any skill', async () => {
    const session = await seedAdmittedSession(db.pool);
    const invalidFiles = [
      new Uint8Array([0xff]),
      file.replace('description: Organize the report', 'name: second-name\ndescription: report'),
      file.replace('  team: narrative', '  team: &label narrative\n  alias: *label'),
      file.replace('weekly-report', 'weekly--report'),
      file.replace('Organize the report', '"   "'),
      file.replace('Read [reference](./reference.md) as text.', '界'.repeat(5462)),
      `${file}${' '.repeat(SKILL_FILE_MAX_BYTES)}`,
    ];
    for (const invalid of invalidFiles) {
      const options = { session, method: 'POST', file: invalid };
      expect((await send(app, `${root}/actions/preview-import`, options)).status).toBe(422);
      expect((await send(product, root, { ...options, key: randomUUID() })).status).toBe(422);
    }
    expect(
      await send(app, root, {
        session,
        method: 'POST',
        key: randomUUID(),
        body: { ...fields, name: 'Invalid', body: '\u0000' },
      }),
    ).toMatchObject({
      status: 422,
      error: { details: { fields: { name: expect.any(String), body: expect.any(String) } } },
    });
    expect((await send(app, root, { session })).data).toEqual({ items: [], next_cursor: null });
  });

  it('scopes creation replays, history, terminal disable and optimistic concurrency to the owner', async () => {
    const key = randomUUID();
    const create = { method: 'POST', key, body: fields };
    const [first, replay] = await Promise.all([
      send(app, root, create),
      send(product, root, create),
    ]);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.data).toEqual(first.data);
    const skill = SkillDetailSchema.parse(first.data);
    const detail = `${root}/${skill.id}`;
    const disable = `${detail}/actions/disable`;
    const foreign = SkillDetailSchema.parse(
      (await send(product, root, { ...create, session: other })).data,
    );
    expect(foreign.id).not.toBe(skill.id);
    expect(
      (await send(app, root, { ...create, body: { ...fields, body: 'Different content' } })).status,
    ).toBe(409);

    const patch = { method: 'PATCH', body: { ...fields, expected_revision: 1 } };
    const stop = { method: 'POST', body: { expected_revision: 1 } };
    for (const [path, options] of [
      [detail, {}],
      [detail, patch],
      [disable, stop],
    ] as const) {
      const foreignResult = await send(product, path, { ...options, session: other });
      expect(foreignResult.status).toBe(404);
      expect(foreignResult).toEqual(await send(app, path.replace(skill.id, randomUUID()), options));
    }

    const versions = await Promise.all([
      send(app, detail, { ...patch, body: { ...patch.body, body: 'Edited from app' } }),
      send(product, detail, { ...patch, body: { ...patch.body, body: 'Edited from host' } }),
    ]);
    expect(versions.map(({ status }) => status).sort()).toEqual([200, 409]);
    const updated = SkillDetailSchema.parse(versions.find(({ status }) => status === 200)?.data);
    expect(updated.revision).toBe(2);
    expect((await send(app, disable, stop)).status).toBe(409);
    const disabled = SkillDetailSchema.parse(
      (await send(product, disable, { ...stop, body: { expected_revision: 2 } })).data,
    );
    expect(disabled).toEqual({ ...updated, disabled_at: expect.any(String) });
    expect((await send(app, detail)).data).toEqual(disabled);
    expect(
      (await send(product, detail, { ...patch, body: { ...patch.body, expected_revision: 2 } }))
        .status,
    ).toBe(409);
    expect((await send(product, root, create)).data).toEqual(skill);
    expect(
      (
        await db.pool.query(
          'SELECT revision, body FROM personal_skill_revisions WHERE skill_id=$1 ORDER BY revision',
          [skill.id],
        )
      ).rows,
    ).toEqual([
      { revision: 1, body: fields.body },
      { revision: 2, body: updated.body },
    ]);
    await expect(
      db.pool.query('UPDATE personal_skill_revisions SET body=$2 WHERE skill_id=$1', [
        skill.id,
        'tampered',
      ]),
    ).rejects.toThrow('immutable');
  });

  it('paginates owner-scoped metadata without duplicating IDs or exposing bodies', async () => {
    const session = await seedAdmittedSession(db.pool);
    for (let i = 0; i < 3; i++) {
      expect(
        (await send(app, root, { session, method: 'POST', key: randomUUID(), body: fields }))
          .status,
      ).toBe(200);
    }
    const first = SkillListPageSchema.parse(
      (await send(product, `${root}?limit=2`, { session })).data,
    );
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const page = `${root}?limit=2&cursor=${first.next_cursor}`;
    const second = SkillListPageSchema.parse((await send(app, page, { session })).data);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const ids = [...first.items, ...second.items].map(({ id }) => id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort());
    expect((await send(product, page, { session: other })).status).toBe(400);
    expect((await send(app, `${root}?limit=1&limit=2`, { session })).status).toBe(400);
  });

  it('freezes a selected active revision and allows retaining but not newly assigning a disabled skill', async () => {
    const created = await send(app, root, { method: 'POST', key: randomUUID(), body: fields });
    const { id, revision, name, body } = SkillDetailSchema.parse(created.data);
    const selection = { id, revision };
    await withTransaction(db.pool, async (client) => {
      await validateAssignedSkills(client, owner.userId, [id]);
      expect(await lockAdmittedSkill(client, owner.userId, selection)).toEqual({
        id,
        revision,
        name,
        body,
      });
      expect(await listAssignedSkills(client, other.userId, [id])).toEqual([]);
    });
    expect(
      (
        await send(product, `${root}/${id}`, {
          method: 'PATCH',
          body: { ...fields, body: 'second', expected_revision: revision },
        })
      ).status,
    ).toBe(200);
    await withTransaction(db.pool, async (client) => {
      await assertSkillActive(client, owner.userId, id);
      await expect(lockAdmittedSkill(client, owner.userId, selection)).rejects.toMatchObject({
        code: 400010,
      });
      expect(await listAssignedSkills(client, owner.userId, [id])).toMatchObject([
        { id, revision: 2 },
      ]);
    });
    expect(
      (
        await send(product, `${root}/${id}/actions/disable`, {
          method: 'POST',
          body: { expected_revision: 2 },
        })
      ).status,
    ).toBe(200);
    await withTransaction(db.pool, async (client) => {
      await validateAssignedSkills(client, owner.userId, [id], [id]);
      await expect(validateAssignedSkills(client, owner.userId, [id])).rejects.toMatchObject({
        code: 400010,
      });
      await expect(assertSkillActive(client, owner.userId, id)).rejects.toMatchObject({
        code: 400010,
      });
      expect(await listAssignedSkills(client, owner.userId, [id])).toEqual([]);
    });
  });
});
