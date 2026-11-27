import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DeploymentDatabase } from '../local/database.mjs';
import { copyMigrationsThrough } from './fixtures/migrations.js';

const connectionString = process.env.DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;

databaseTests('trusted goal schema lifecycle admission against PG16', () => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  afterAll(async () => {
    await admin.end();
  });

  async function isolated(action: (url: string) => Promise<void>) {
    const name = `goal_lifecycle_${randomUUID().replaceAll('-', '')}`;
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
    action: (database: DeploymentDatabase) => Promise<void>,
    migrationsDirectory?: string,
  ) {
    const database = new DeploymentDatabase({
      connectionString: url,
      ...(migrationsDirectory ? { migrationsDirectory } : {}),
    });
    try {
      await database.connect();
      await database.acquireLease();
      await action(database);
    } finally {
      await database.close();
    }
  }

  async function sql(url: string, action: (client: pg.Client) => Promise<void>) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await action(client);
    } finally {
      await client.end();
    }
  }

  async function isolatedAt0029(action: (url: string, directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'goal-0029-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0029',
      )) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated((url) => action(url, directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  for (const source of [
    '0016',
    '0017',
    '0018',
    '0019',
    '0020',
    '0021',
    '0022',
    '0023',
    '0024',
    '0025-elapsed',
    '0026',
    '0028',
  ]) {
    const version = source.slice(0, 4);
    it(`explicitly upgrades original ${source} to 0041 without rewriting existing identity or Run facts`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `goal-${version}-`));
      const migrations = new URL('../../infra/migrations/', import.meta.url);
      try {
        for (const name of (await readdir(migrations)).filter(
          (name) =>
            name.endsWith('.sql') &&
            name.slice(0, 4) <= (source === '0025-elapsed' ? '0023' : version),
        )) {
          await copyFile(new URL(name, migrations), join(directory, name));
        }
        await isolated(async (url) => {
          await deployment(
            url,
            async (database) => {
              expect((await database.initialize()).version).toBe(
                source === '0025-elapsed' ? '0023' : version,
              );
            },
            directory,
          );
          if (source === '0025-elapsed') {
            await sql(url, async (client) => {
              await client.query(
                await readFile(
                  new URL('./fixtures/0024_tasks_elapsed_basis.sql', import.meta.url),
                  'utf8',
                ),
              );
              await client.query(
                await readFile(new URL('0025_approval_utc_cancellation.sql', migrations), 'utf8'),
              );
            });
          }
          const ownerId = randomUUID();
          const conversationId = randomUUID();
          const runId = randomUUID();
          let original: unknown;
          await sql(url, async (client) => {
            await client.query(
              `INSERT INTO users(id,auth_email,display_name,timezone_id,metadata)
              VALUES($1,$2,'original identity','Asia/Shanghai','{"preserve":true}')`,
              [ownerId, `${ownerId}@goal.test`],
            );
            await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
              conversationId,
              ownerId,
            ]);
            await client.query(
              `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
              budget_max_iterations,budget_max_tokens,frozen_context)
              VALUES($1,$2,$3,'historical','chat','done',2,100,'{"legacy":true}')`,
              [runId, ownerId, conversationId],
            );
            original = (
              await client.query(
                `SELECT jsonb_build_object(
              'identity',(SELECT to_jsonb(u) FROM users u WHERE id=$1),
              'run',(SELECT to_jsonb(r)-'goal_result'-'cancellation_scope_candidates' FROM agent_runs r WHERE id=$2)) AS value`,
                [ownerId, runId],
              )
            ).rows[0].value;
          });
          await copyMigrationsThrough(directory, '0041');
          await deployment(
            url,
            async (database) => {
              expect(database.targetVersion).toBe('0041');
              expect(await database.classify()).toMatchObject({
                kind: 'supported',
                version,
                reason: 'explicit_upgrade_required',
              });
              await expect(database.initialize()).rejects.toMatchObject({
                code: 'explicit_upgrade_required',
              });
              expect((await database.upgrade()).version).toBe('0041');
            },
            directory,
          );
          await sql(url, async (client) => {
            expect(
              (
                await client.query(
                  "SELECT version FROM schema_migrations WHERE version >= '0029' ORDER BY version",
                )
              ).rows.map((row) => row.version),
            ).toEqual([
              '0029',
              '0030',
              '0031',
              '0032',
              '0033',
              '0034',
              '0035',
              '0036',
              '0037',
              '0038',
              '0039',
              '0040',
              '0041',
            ]);
            expect(
              (
                await client.query(
                  `SELECT jsonb_build_object(
              'identity',(SELECT to_jsonb(u) FROM users u WHERE id=$1),
              'run',(SELECT to_jsonb(r)-'goal_result'-'cancellation_scope_candidates' FROM agent_runs r WHERE id=$2)) AS value`,
                  [ownerId, runId],
                )
              ).rows[0].value,
            ).toEqual(original);
            expect(
              (
                await client.query(
                  'SELECT goal_result,cancellation_scope_candidates FROM agent_runs WHERE id=$1',
                  [runId],
                )
              ).rows[0],
            ).toEqual({ goal_result: null, cancellation_scope_candidates: null });
            expect(
              (
                await client.query(`SELECT
                (SELECT count(*)::int FROM harness_pauses) AS pauses,
                (SELECT count(*)::int FROM harness_pause_resumes) AS resumes`)
              ).rows[0],
            ).toEqual({ pauses: 0, resumes: 0 });
            await client.query(`CREATE FUNCTION goal_reject_restart_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
              BEGIN RAISE EXCEPTION 'read-only goal restart attempted DDL'; END; $$;
              CREATE EVENT TRIGGER goal_restart_readonly ON ddl_command_start EXECUTE FUNCTION goal_reject_restart_ddl()`);
          });
          for (let restart = 0; restart < 2; restart++) {
            await deployment(
              url,
              async (database) => {
                expect(await database.classify()).toMatchObject({
                  kind: 'supported',
                  version: '0041',
                });
                expect((await database.initialize()).version).toBe('0041');
                expect((await database.upgrade()).version).toBe('0041');
              },
              directory,
            );
          }
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  }

  it('requires true delegated terminal facts rather than SQL NULL from missing legacy or goal keys', async () => {
    await isolated(async (url) => {
      await deployment(url, async (database) => {
        expect((await database.initialize()).version).toBe('0043');
      });
      await sql(url, async (client) => {
        const ownerId = randomUUID();
        const conversationId = randomUUID();
        await client.query('INSERT INTO personal_bots(id,owner_id,config) VALUES($1,$1,$2)', [
          ownerId,
          {
            name: 'Goal',
            introduction: '',
            role: '',
            instructions: '',
            model_selection: null,
            tool_ids: [],
            workspace_ids: [],
          },
        ]);
        await client.query('INSERT INTO conversations(id,owner_id,bot_id) VALUES($1,$2,$2)', [
          conversationId,
          ownerId,
        ]);
        async function insertRun(frozenContext: unknown, goalResult: unknown, status = 'done') {
          return client.query(
            `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
              budget_max_iterations,budget_max_tokens,frozen_context,goal_result)
             VALUES($1,$2,$3,'goal-null-boundary','chat',$4,2,100,$5::jsonb,$6::jsonb) RETURNING id`,
            [
              randomUUID(),
              ownerId,
              conversationId,
              status,
              frozenContext === null ? null : JSON.stringify(frozenContext),
              goalResult === undefined ? null : JSON.stringify(goalResult),
            ],
          );
        }
        for (const [frozen, goalResult, status] of [
          [null, { status: 'completed' }, 'done'],
          [{}, { status: 'completed' }, 'done'],
          [{ authorization_revision: 'delegation/1' }, {}, 'done'],
          [{ authorization_revision: 'delegation/1' }, { status: null }, 'done'],
          [{ authorization_revision: 'delegation/1' }, null, 'done'],
          [{ authorization_revision: 'delegation/2' }, { status: 'completed' }, 'done'],
          [{ authorization_revision: 'delegation/1' }, { status: 'completed' }, 'running'],
        ] as const) {
          await expect(insertRun(frozen, goalResult, status)).rejects.toMatchObject({
            code: '23514',
            constraint: 'agent_runs_goal_result_check',
          });
        }
        expect((await insertRun(null, undefined)).rowCount).toBe(1);
        expect(
          (await insertRun({ authorization_revision: 'delegation/1' }, { status: 'completed' }))
            .rowCount,
        ).toBe(1);
      });
    });
  }, 30000);

  it('enforces 0029 user-only pause integrity and append-only unique continuations', async () => {
    await isolatedAt0029(async (url, directory) => {
      await deployment(
        url,
        async (database) => {
          expect((await database.initialize()).version).toBe('0029');
        },
        directory,
      );
      await sql(url, async (client) => {
        const owner = randomUUID(),
          conversation = randomUUID(),
          run = randomUUID();
        const attempt = randomUUID(),
          successor = randomUUID(),
          pause = randomUUID();
        await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
          conversation,
          owner,
        ]);
        await client.query(
          `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
            budget_max_iterations,budget_max_tokens,frozen_context)
           VALUES($1,$2,$3,'test','chat','paused',2,100,'{}')`,
          [run, owner, conversation],
        );
        await client.query(
          `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status)
           VALUES($1,$3,$4,1,'done'),($2,$3,$4,2,'running')`,
          [attempt, successor, owner, run],
        );
        const insertPause = `INSERT INTO harness_pauses
          (id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`;
        const args = (
          id: string,
          reason: string,
          purpose: string,
          source: string,
          state: string,
          snapshot: string | null,
        ) => [
          id,
          owner,
          conversation,
          run,
          attempt,
          randomUUID(),
          reason,
          purpose,
          source,
          state,
          snapshot,
        ];
        for (const invalid of [
          args(randomUUID(), 'runtime', 'none', 'user', 'pending', null),
          args(randomUUID(), 'user', 'manual_compact', 'user', 'pending', null),
          args(randomUUID(), 'user', 'none', 'runtime', 'pending', null),
          args(randomUUID(), 'user', 'none', 'user', 'pending', '{}'),
          args(randomUUID(), 'user', 'none', 'user', 'paused', null),
          args(randomUUID(), 'user', 'none', 'user', 'consumed', null),
        ]) {
          await expect(client.query(insertPause, invalid)).rejects.toMatchObject({ code: '23514' });
        }
        await client.query(insertPause, args(pause, 'user', 'none', 'user', 'pending', null));
        await expect(
          client.query(insertPause, args(randomUUID(), 'user', 'none', 'user', 'pending', null)),
        ).rejects.toMatchObject({ code: '23505' });
        await client.query(`UPDATE harness_pauses SET state='paused',snapshot='{}' WHERE id=$1`, [
          pause,
        ]);
        const insertResume = `INSERT INTO harness_pause_resumes
          (owner_id,idempotency_key,run_id,pause_id,attempt_id,source) VALUES($1,$2,$3,$4,$5,$6)`;
        await expect(
          client.query(insertResume, [owner, randomUUID(), run, pause, successor, 'runtime']),
        ).rejects.toMatchObject({ code: '23514' });
        const key = randomUUID();
        await client.query(insertResume, [owner, key, run, pause, successor, 'user']);
        await expect(
          client.query(insertResume, [owner, randomUUID(), run, pause, attempt, 'user']),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query('UPDATE harness_pause_resumes SET source=source WHERE pause_id=$1', [pause]),
        ).rejects.toMatchObject({ code: 'P0001' });
        await expect(
          client.query('DELETE FROM harness_pause_resumes WHERE pause_id=$1', [pause]),
        ).rejects.toMatchObject({ code: 'P0001' });
      });
    });
  }, 30000);

  it.each([
    ['live pause index', 'DROP INDEX harness_pauses_one_live_run'],
    ['pause snapshot check', 'ALTER TABLE harness_pauses DROP CONSTRAINT harness_pauses_check1'],
    [
      'resume append-only trigger',
      'ALTER TABLE harness_pause_resumes DISABLE TRIGGER harness_pause_resumes_no_update_delete',
    ],
  ])(
    'refuses damaged %s without repair',
    async (_name, mutation) => {
      await isolated(async (url) => {
        await deployment(url, async (database) => {
          expect((await database.initialize()).version).toBe('0043');
        });
        await sql(url, async (client) => {
          await client.query(mutation);
        });
        await deployment(url, async (database) => {
          expect((await database.classify()).kind).toBe('unknown');
          await expect(database.initialize()).rejects.toMatchObject({
            code: 'unknown_database_refused',
          });
          await expect(database.upgrade()).rejects.toMatchObject({
            code: 'unsupported_upgrade_source',
          });
        });
      });
    },
    30000,
  );

  it.each([
    [
      'missing result constraint',
      'ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_goal_result_check',
    ],
    [
      'weakened result constraint',
      `ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_goal_result_check;
      ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_goal_result_check CHECK(true)`,
    ],
    ['required result column', 'ALTER TABLE agent_runs ALTER COLUMN goal_result SET NOT NULL'],
    [
      'invented result default',
      "ALTER TABLE agent_runs ALTER COLUMN goal_result SET DEFAULT '{}'::jsonb",
    ],
    ['unstamped result schema', "DELETE FROM schema_migrations WHERE version='0022'"],
    [
      'missing candidate evidence column',
      'ALTER TABLE agent_runs DROP COLUMN cancellation_scope_candidates',
    ],
    [
      'required candidate evidence column',
      'ALTER TABLE agent_runs ALTER COLUMN cancellation_scope_candidates SET NOT NULL',
    ],
    ['unstamped candidate evidence', "DELETE FROM schema_migrations WHERE version='0027'"],
  ])(
    'refuses %s without repair or ledger rewriting',
    async (_name, mutation) => {
      await isolated(async (url) => {
        await deployment(url, async (database) => {
          expect((await database.initialize()).version).toBe('0043');
        });
        let before: unknown;
        const snapshot = `SELECT jsonb_build_object(
        'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m),
        'checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_expr(conbin,conrelid)) ORDER BY conname)
          FROM pg_constraint WHERE conrelid='agent_runs'::regclass),
        'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid='agent_runs'::regclass AND a.attnum>0 AND NOT a.attisdropped)) AS value`;
        await sql(url, async (client) => {
          await client.query(mutation);
          before = (await client.query(snapshot)).rows[0].value;
        });
        await deployment(url, async (database) => {
          const state = await database.classify();
          expect(state.kind).toBe('unknown');
          await expect(database.initialize()).rejects.toMatchObject({
            code: 'unknown_database_refused',
          });
          await expect(database.upgrade()).rejects.toMatchObject({
            code: 'unsupported_upgrade_source',
          });
          expect(await database.classify()).toEqual(state);
        });
        await sql(url, async (client) => {
          expect((await client.query(snapshot)).rows[0].value).toEqual(before);
        });
      });
    },
    30000,
  );
});
