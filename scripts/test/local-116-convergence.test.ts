import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DeploymentDatabase } from '../local/database.mjs';

const connectionString = process.env.DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;
const migrations = new URL('../../infra/migrations/', import.meta.url);
const elapsedFixture = new URL('./fixtures/0024_tasks_elapsed_basis.sql', import.meta.url);

databaseTests('0024 history convergence against isolated PostgreSQL 16', () => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  let baseDirectory: string;

  beforeAll(async () => {
    expect(
      (await admin.query("SELECT current_setting('server_version_num')::int / 10000 AS major"))
        .rows[0].major,
    ).toBe(16);
    baseDirectory = await mkdtemp(join(tmpdir(), 'convergence-0023-'));
    for (const name of (await readdir(migrations)).filter(
      (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0023',
    )) {
      await copyFile(new URL(name, migrations), join(baseDirectory, name));
    }
  });
  afterAll(async () => {
    await admin.end();
    if (baseDirectory) await rm(baseDirectory, { recursive: true, force: true });
  });

  async function isolated(action: (url: string) => Promise<void>) {
    const name = `convergence_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(connectionString!);
    url.pathname = `/${name}`;
    url.search = '';
    try {
      await action(url.toString());
    } finally {
      await admin.query(`DROP DATABASE "${name}"`);
    }
  }

  async function deployment(
    url: string,
    action: (db: DeploymentDatabase) => Promise<void>,
    directory?: string,
  ) {
    const db = new DeploymentDatabase({
      connectionString: url,
      ...(directory ? { migrationsDirectory: directory } : {}),
    });
    try {
      await db.connect();
      await db.acquireLease();
      await action(db);
    } finally {
      await db.close();
    }
  }

  async function sql<T>(url: string, action: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return await action(client);
    } finally {
      await client.end();
    }
  }

  type History = 'main' | 'legacy';
  async function historical(url: string, history: History) {
    await deployment(
      url,
      async (db) => expect((await db.initialize()).version).toBe('0023'),
      baseDirectory,
    );
    const administrator = randomUUID();
    const ordinary = randomUUID();
    const approval = randomUUID();
    const task = randomUUID();
    await sql(url, async (client) => {
      for (const id of [administrator, ordinary]) {
        await client.query(
          "INSERT INTO users(id,auth_email,display_name,status) VALUES($1,$2,'historical user','active')",
          [id, `${id}@local.invalid`],
        );
        await client.query(
          'INSERT INTO auth_accounts(user_id,account_id,password_hash) VALUES($1::uuid,$1::uuid::text,$2)',
          [id, `${'a'.repeat(32)}:${'b'.repeat(128)}`],
        );
      }
      await client.query('INSERT INTO installation_admin(user_id) VALUES($1)', [administrator]);
      await client.query(
        "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,'historical-session-hash',now()+interval '7 days')",
        [ordinary],
      );
      await client.query(
        `INSERT INTO approvals(id,owner_id,original_text,fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version,presentation_hash,presentation_version,expires_at)
        VALUES($1,$2,'pending historical approval','2030-11-03T01:20:00Z','2030-11-03 09:20','Asia/Shanghai',28800,'frozen-tzdb','original-presentation-hash','v1',now()+interval '7 days')`,
        [approval, ordinary],
      );
      await client.query(
        `INSERT INTO tasks(id,owner_id,source_approval_id,fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version,original_note)
        VALUES($1,$2,$3,'2030-11-03T01:20:00Z','2030-11-03 09:20','Asia/Shanghai',28800,'frozen-tzdb','original task')`,
        [task, ordinary, approval],
      );
      const source =
        history === 'main' ? new URL('0024_invited_accounts.sql', migrations) : elapsedFixture;
      await client.query(await readFile(source, 'utf8'));
      if (history === 'legacy') {
        await client.query(
          await readFile(new URL('0025_approval_utc_cancellation.sql', migrations), 'utf8'),
        );
        const conversation = randomUUID(),
          invocation = randomUUID(),
          message = randomUUID();
        await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
          conversation,
          ordinary,
        ]);
        await client.query(
          "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remind me')",
          [message, ordinary, conversation],
        );
        await client.query(
          `INSERT INTO tool_invocations(invocation_id,owner_id,conversation_id,run_id,call_key,first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context)
          VALUES($1,$2,$3,$4,$5,$6,$7,'create_reminder',$8,2,'local','{}')`,
          [
            invocation,
            ordinary,
            conversation,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            'a'.repeat(64),
          ],
        );
        await client.query(
          `INSERT INTO tasks(id,owner_id,source_invocation_id,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,time_basis,display_version)
          VALUES($1,$2,$3,'2030-11-03T01:21:00Z','2030-11-03 01:21:00','UTC',0,0,NULL,$4,'elapsed/1')`,
          [
            randomUUID(),
            ordinary,
            invocation,
            {
              kind: 'elapsed',
              anchor_utc: '2030-11-03T01:20:00Z',
              duration_seconds: 60,
              source_message_id: message,
              revision: 'elapsed/1',
            },
          ],
        );
      }
      // Non-default timestamps make any ledger rewrite observable.
      await client.query(
        "UPDATE schema_migrations SET applied_at='2001-02-03 04:05:06+00'::timestamptz + version::int * interval '1 second'",
      );
    });
    return { administrator, ordinary, approval, task };
  }

  async function facts(client: pg.Client, history: History) {
    const taskProjection =
      history === 'main' ? "to_jsonb(t)-ARRAY['time_basis','display_version']" : 'to_jsonb(t)';
    return (
      await client.query(
        `SELECT jsonb_build_object(
      'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version <= $1),
      'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),
      'credentials',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM auth_accounts a),
      'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sessions s),
      'admin',(SELECT jsonb_agg(to_jsonb(i) ORDER BY user_id) FROM installation_admin i),
      'tasks',(SELECT jsonb_agg(${taskProjection} ORDER BY id) FROM tasks t),
      'approvals',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM approvals a)) AS value`,
        [history === 'main' ? '0024' : '0025'],
      )
    ).rows[0].value;
  }

  it('initializes an empty database at the converged version', async () => {
    await isolated(async (url) => {
      await deployment(url, async (db) => {
        expect((await db.initialize()).version).toBe('0026');
        expect(await db.classify()).toMatchObject({ kind: 'supported', version: '0026' });
      });
      await sql(url, async (client) => {
        expect(
          (await client.query('SELECT count(*) FROM identity_account_admissions')).rows[0].count,
        ).toBe('0');
        expect(
          (
            await client.query(
              "SELECT version FROM schema_migrations WHERE version >= '0024' ORDER BY version",
            )
          ).rows.map((row) => row.version),
        ).toEqual(['0024', '0025', '0026']);
      });
    });
  }, 30000);

  for (const history of ['main', 'legacy'] as const) {
    it(`upgrades the actual ${history} migration history without rewriting facts or granting ordinary accounts admission`, async () => {
      await isolated(async (url) => {
        const ids = await historical(url, history);
        const before = await sql(url, (client) => facts(client, history));
        await deployment(url, async (db) => {
          expect(await db.classify()).toMatchObject({
            kind: 'supported',
            version: history === 'main' ? '0024' : '0025',
          });
          await expect(db.initialize()).rejects.toMatchObject({
            code: 'explicit_upgrade_required',
          });
          expect((await db.upgrade()).version).toBe('0026');
        });
        await sql(url, async (client) => {
          expect(await facts(client, history)).toEqual(before);
          expect(
            (
              await client.query(
                'SELECT user_id,source FROM identity_account_admissions ORDER BY user_id',
              )
            ).rows,
          ).toEqual([{ user_id: ids.administrator, source: 'installation_admin' }]);
          expect(
            (
              await client.query('SELECT state,presentation_hash FROM approvals WHERE id=$1', [
                ids.approval,
              ])
            ).rows[0],
          ).toEqual({ state: 'pending', presentation_hash: 'original-presentation-hash' });
          expect(
            (
              await client.query(
                "SELECT version FROM schema_migrations WHERE version >= '0024' ORDER BY version",
              )
            ).rows.map((row) => row.version),
          ).toEqual(['0024', '0025', '0026']);
        });
        await deployment(url, async (db) => {
          expect((await db.initialize()).version).toBe('0026');
          expect((await db.upgrade()).version).toBe('0026');
        });
      });
    }, 30000);
  }

  for (const anomaly of ['missing_elapsed_guard', 'mixed_identity'] as const) {
    it(`refuses ${anomaly} without changing the historical ledger or activating privileges`, async () => {
      await isolated(async (url) => {
        await historical(url, 'legacy');
        const before = await sql(url, async (client) => {
          if (anomaly === 'missing_elapsed_guard')
            await client.query('DROP TRIGGER tasks_elapsed_basis_guard ON tasks');
          else
            await client.query(
              'CREATE TABLE identity_account_admissions (user_id uuid PRIMARY KEY)',
            );
          return facts(client, 'legacy');
        });
        await deployment(url, async (db) => {
          await expect(db.upgrade()).rejects.toBeDefined();
        });
        await sql(url, async (client) => {
          expect(await facts(client, 'legacy')).toEqual(before);
          expect(
            (await client.query("SELECT count(*) FROM schema_migrations WHERE version='0026'"))
              .rows[0].count,
          ).toBe('0');
          if (anomaly === 'mixed_identity')
            expect(
              (await client.query('SELECT count(*) FROM identity_account_admissions')).rows[0]
                .count,
            ).toBe('0');
        });
      });
    }, 30000);
  }
});
