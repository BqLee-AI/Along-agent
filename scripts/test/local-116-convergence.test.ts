import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  async function historical(url: string, history: History, ending: '\n' | '\r\n' = '\n') {
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
      await client.query(
        (await readFile(source, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', ending),
      );
      if (history === 'legacy') {
        await client.query(
          (await readFile(new URL('0025_approval_utc_cancellation.sql', migrations), 'utf8'))
            .replaceAll('\r\n', '\n')
            .replaceAll('\n', ending),
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
        expect((await db.initialize()).version).toBe('0036');
        expect(await db.classify()).toMatchObject({ kind: 'supported', version: '0036' });
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
        ).toEqual([
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
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
          expect((await db.upgrade()).version).toBe('0036');
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
          ).toEqual([
            '0024',
            '0025',
            '0026',
            '0027',
            '0028',
            '0029',
            '0030',
            '0031',
            '0032',
            '0033',
            '0034',
            '0035',
            '0036',
          ]);
        });
        await deployment(url, async (db) => {
          expect((await db.initialize()).version).toBe('0036');
          expect((await db.upgrade()).version).toBe('0036');
        });
      });
    }, 30000);
  }

  for (const [historyEnding, nextEnding] of [
    ['\n', '\r\n'],
    ['\r\n', '\n'],
  ] as const) {
    it(`upgrades legacy functions from ${JSON.stringify(historyEnding)} to ${JSON.stringify(nextEnding)} checkout`, async () => {
      await isolated(async (url) => {
        await historical(url, 'legacy', historyEnding);
        const before = await sql(url, async (client) => {
          const bodies = (
            await client.query(
              "SELECT proname,prosrc FROM pg_proc WHERE proname IN ('tasks_guard_elapsed_basis','approvals_guard_null_tzdb') ORDER BY proname",
            )
          ).rows;
          expect(bodies).toHaveLength(2);
          for (const body of bodies) {
            expect(body.prosrc.includes('\r\n')).toBe(historyEnding === '\r\n');
          }
          return facts(client, 'legacy');
        });
        const directory = await mkdtemp(join(tmpdir(), 'convergence-endings-'));
        try {
          for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql'))) {
            const source = await readFile(new URL(name, migrations), 'utf8');
            await writeFile(
              join(directory, name),
              source.replaceAll('\r\n', '\n').replaceAll('\n', nextEnding),
            );
          }
          await deployment(
            url,
            async (db) => {
              expect(await db.classify()).toMatchObject({ kind: 'supported', version: '0025' });
              expect((await db.upgrade()).version).toBe('0036');
            },
            directory,
          );
          await sql(url, async (client) => {
            expect(await facts(client, 'legacy')).toEqual(before);
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }, 30000);
  }

  it('recognizes an installation that already applied the original 0026 without rerunning it', async () => {
    await isolated(async (url) => {
      await historical(url, 'legacy');
      const before = await sql(url, async (client) => {
        const current = await readFile(new URL('0026_reconcile_0024.sql', migrations), 'utf8');
        const original = current
          .replace(
            'replace(p.prosrc, chr(13) || chr(10), chr(10)) = replace($elapsed_body$',
            'p.prosrc = $elapsed_body$',
          )
          .replace('$elapsed_body$, chr(13) || chr(10), chr(10)))', '$elapsed_body$)')
          .replace(
            'replace(p.prosrc, chr(13) || chr(10), chr(10)) = replace($approval_body$',
            'p.prosrc=$approval_body$',
          )
          .replace('$approval_body$, chr(13) || chr(10), chr(10)))', '$approval_body$)');
        expect(original).not.toBe(current);
        await client.query(original);
        return {
          facts: await facts(client, 'legacy'),
          ledger: (await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows,
          admission: (
            await client.query('SELECT * FROM identity_account_admissions ORDER BY user_id')
          ).rows,
        };
      });
      await deployment(url, async (db) => {
        expect(await db.classify()).toMatchObject({
          kind: 'supported',
          version: '0026',
          reason: 'explicit_upgrade_required',
        });
        expect((await db.upgrade()).version).toBe('0036');
      });
      await sql(url, async (client) => {
        expect(await facts(client, 'legacy')).toEqual(before.facts);
        expect(
          (
            await client.query(
              "SELECT * FROM schema_migrations WHERE version <= '0026' ORDER BY version",
            )
          ).rows,
        ).toEqual(before.ledger);
        expect(
          (await client.query('SELECT * FROM identity_account_admissions ORDER BY user_id')).rows,
        ).toEqual(before.admission);
      });
    });
  }, 30000);

  for (const object of ['elapsed', 'approval'] as const) {
    for (const drift of ['body', 'trigger'] as const) {
      it(`refuses ${object} ${drift} drift even with equivalent line endings`, async () => {
        await isolated(async (url) => {
          await historical(url, 'legacy', '\r\n');
          const before = await sql(url, async (client) => {
            const name =
              object === 'elapsed' ? 'tasks_guard_elapsed_basis' : 'approvals_guard_null_tzdb';
            if (drift === 'body') {
              const original =
                object === 'elapsed'
                  ? await readFile(elapsedFixture, 'utf8')
                  : await readFile(
                      new URL('0025_approval_utc_cancellation.sql', migrations),
                      'utf8',
                    );
              const definition = original.match(
                new RegExp(`CREATE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$function\\$;`),
              )?.[0];
              expect(definition).toBeDefined();
              await client.query(
                definition!
                  .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
                  .replace('RETURN NEW;', 'RETURN NULL;'),
              );
            } else {
              await client.query(
                object === 'elapsed'
                  ? 'ALTER TABLE tasks DISABLE TRIGGER tasks_elapsed_basis_guard'
                  : 'ALTER TABLE approvals DISABLE TRIGGER approvals_null_tzdb_guard',
              );
            }
            return facts(client, 'legacy');
          });
          await deployment(url, async (db) => {
            expect((await db.classify()).kind).toBe('unknown');
            await expect(db.upgrade()).rejects.toBeDefined();
          });
          await sql(url, async (client) => {
            expect(await facts(client, 'legacy')).toEqual(before);
            expect(
              (await client.query("SELECT count(*) FROM schema_migrations WHERE version='0026'"))
                .rows[0].count,
            ).toBe('0');
          });
        });
      }, 30000);
    }
  }

  it('rolls back an interrupted 0026 after DDL and retries without changing historical facts', async () => {
    await isolated(async (url) => {
      await historical(url, 'legacy');
      const before = await sql(url, (client) => facts(client, 'legacy'));
      const directory = await mkdtemp(join(tmpdir(), 'convergence-interrupted-'));
      try {
        for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql'))) {
          const source = await readFile(new URL(name, migrations), 'utf8');
          await writeFile(
            join(directory, name),
            name.startsWith('0026_')
              ? source.replace(
                  "  INSERT INTO schema_migrations(version) VALUES ('0026');",
                  "  RAISE EXCEPTION 'injected failure after reconciliation';\n  INSERT INTO schema_migrations(version) VALUES ('0026');",
                )
              : source,
          );
        }
        await deployment(
          url,
          async (db) => {
            await expect(db.upgrade()).rejects.toMatchObject({
              code: 'migration_failed_reconcile_before_retry',
            });
          },
          directory,
        );
        await sql(url, async (client) => {
          expect(await facts(client, 'legacy')).toEqual(before);
          expect(
            (
              await client.query(
                "SELECT to_regclass('public.identity_account_admissions') AS relation",
              )
            ).rows[0].relation,
          ).toBeNull();
          expect(
            (await client.query("SELECT count(*) FROM schema_migrations WHERE version='0026'"))
              .rows[0].count,
          ).toBe('0');
        });
        await deployment(url, async (db) => {
          expect((await db.upgrade()).version).toBe('0036');
        });
        await sql(url, async (client) => expect(await facts(client, 'legacy')).toEqual(before));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }, 30000);

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
