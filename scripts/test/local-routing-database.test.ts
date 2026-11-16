import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DeploymentDatabase } from '../local/database.mjs';

const connectionString = process.env.DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;

databaseTests('routing lifecycle schema admission against PG16', () => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  let routingMigrationsDirectory: string;
  beforeAll(async () => {
    routingMigrationsDirectory = await mkdtemp(join(tmpdir(), 'routing-0020-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(
      (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0020',
    )) {
      await copyFile(new URL(name, migrations), join(routingMigrationsDirectory, name));
    }
  });
  afterAll(async () => {
    try {
      await admin.end();
    } finally {
      if (routingMigrationsDirectory)
        await rm(routingMigrationsDirectory, { recursive: true, force: true });
    }
  });

  async function isolated(action: (url: string) => Promise<void>) {
    const name = `routing_lifecycle_${randomUUID().replaceAll('-', '')}`;
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
    migrationsDirectory = routingMigrationsDirectory,
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

  it('accepts the original 0019 schema, requires explicit upgrade and preserves facts across read-only 0020 restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-0019-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0019',
      )) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0019');
          },
          directory,
        );
        const user = randomUUID();
        let before: unknown;
        await sql(url, async (client) => {
          await client.query('INSERT INTO users(id,display_name,auth_email) VALUES($1,$2,$3)', [
            user,
            'migration canary',
            `${user}@example.test`,
          ]);
          before = (await client.query('SELECT to_jsonb(u) value FROM users u WHERE id=$1', [user]))
            .rows[0].value;
        });
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0019' });
          await expect(database.initialize()).rejects.toMatchObject({
            code: 'explicit_upgrade_required',
          });
          expect((await database.upgrade()).version).toBe('0020');
        });
        await sql(url, async (client) => {
          expect(
            (await client.query('SELECT to_jsonb(u) value FROM users u WHERE id=$1', [user]))
              .rows[0].value,
          ).toEqual(before);
          await client.query(`CREATE FUNCTION routing_reject_restart_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'readonly restart attempted DDL'; END; $$;
            CREATE EVENT TRIGGER routing_restart_readonly ON ddl_command_start EXECUTE FUNCTION routing_reject_restart_ddl()`);
        });
        for (let restart = 0; restart < 2; restart++) {
          await deployment(url, async (database) => {
            expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0020' });
            expect((await database.initialize()).version).toBe('0020');
            expect((await database.upgrade()).version).toBe('0020');
          });
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  it.each([
    ['unique receipt index', 'DROP INDEX run_checkpoints_routing_attempt_kind_unique'],
    [
      'source trigger',
      'ALTER TABLE run_checkpoints DISABLE TRIGGER run_checkpoints_routing_source',
    ],
    [
      'closed kind constraint',
      'ALTER TABLE run_checkpoints DROP CONSTRAINT run_checkpoints_kind_check',
    ],
  ])(
    'refuses a damaged %s without repair',
    async (_name, mutation) => {
      await isolated(async (url) => {
        await deployment(url, async (database) => {
          expect((await database.initialize()).version).toBe('0020');
        });
        await sql(url, async (client) => {
          await client.query(mutation);
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
      });
    },
    30000,
  );
  it('upgrades 0028 to the pause schema and rejects a damaged live-pause index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pause-lifecycle-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      const names = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names.filter((item) => item.slice(0, 4) <= '0028')) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0028');
          },
          directory,
        );
        const pauseMigration = names.find((name) => name.startsWith('0029_'))!;
        await copyFile(new URL(pauseMigration, migrations), join(directory, pauseMigration));
        await deployment(
          url,
          async (database) => {
            expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0028' });
            expect((await database.upgrade()).version).toBe('0029');
            expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0029' });
          },
          directory,
        );
        await sql(url, async (client) => {
          await client.query('DROP INDEX harness_pauses_one_live_run');
        });
        await deployment(
          url,
          async (database) => {
            expect((await database.classify()).kind).toBe('unknown');
          },
          directory,
        );
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
  it('upgrades each memory schema version without losing facts and rejects a damaged revision trigger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      const names = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names.filter((item) => item.slice(0, 4) <= '0029')) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0029');
          },
          directory,
        );
        const owner = randomUUID();
        const memory = randomUUID();
        const conversation = randomUUID();
        const message = randomUUID();
        for (const version of ['0030', '0031', '0032']) {
          const name = names.find((item) => item.startsWith(`${version}_`))!;
          await copyFile(new URL(name, migrations), join(directory, name));
          await deployment(
            url,
            async (database) => {
              expect((await database.upgrade()).version).toBe(version);
              expect(await database.classify()).toMatchObject({ kind: 'supported', version });
              expect(await database.classify()).toMatchObject({ kind: 'supported', version });
            },
            directory,
          );
          if (version === '0030') {
            await sql(url, async (client) => {
              await client.query('BEGIN');
              await client.query(
                `INSERT INTO r3_memories(id,owner_id,current_revision,status) VALUES ($1,$2,1,'active')`,
                [memory, owner],
              );
              await client.query(
                `INSERT INTO r3_memory_revisions(owner_id,memory_id,revision,conversation_id,message_ids,content,source_kind)
                 VALUES ($1,$2,1,$3,ARRAY[$4::uuid],'保留的来源事实','explicit')`,
                [owner, memory, conversation, message],
              );
              await client.query('COMMIT');
            });
          }
          await sql(url, async (client) => {
            const result = await client.query(
              'SELECT content,message_ids FROM r3_memory_revisions WHERE owner_id=$1 AND memory_id=$2',
              [owner, memory],
            );
            expect(result.rows).toEqual([{ content: '保留的来源事实', message_ids: [message] }]);
          });
        }
        await sql(url, async (client) => {
          await client.query(
            'ALTER TABLE r3_memory_revisions DISABLE TRIGGER r3_memory_revision_no_mutation',
          );
        });
        await deployment(
          url,
          async (database) => {
            expect((await database.classify()).kind).toBe('unknown');
            await expect(database.initialize()).rejects.toMatchObject({
              code: 'unknown_database_refused',
            });
          },
          directory,
        );
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
  it('upgrades 0032 through compact and context versions without rewriting pause facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compact-lifecycle-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    const names = (await readdir(migrations)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    try {
      for (const name of names.filter((item) => item.slice(0, 4) <= '0032'))
        await copyFile(new URL(name, migrations), join(directory, name));
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0032');
          },
          directory,
        );
        const [owner, conversation, message, run, attempt, pause, key] = Array.from(
          { length: 7 },
          () => randomUUID(),
        );
        let original: unknown;
        await sql(url, async (client) => {
          await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
            conversation,
            owner,
          ]);
          await client.query(
            "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','original')",
            [message, owner, conversation],
          );
          await client.query(
            `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens)
            VALUES($1,$2,$3,'historical','chat','paused',2,100)`,
            [run, owner, conversation],
          );
          await client.query(
            "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')",
            [attempt, owner, run],
          );
          await client.query(
            `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
            VALUES($1,$2,$3,$4,$5,$6,'user','none','user','paused','{"original":true}')`,
            [pause, owner, conversation, run, attempt, key],
          );
          original = (
            await client.query('SELECT to_jsonb(p) AS value FROM harness_pauses p WHERE id=$1', [
              pause,
            ])
          ).rows[0].value;
        });
        for (const name of names.filter(
          (item) => item.slice(0, 4) >= '0033' && item.slice(0, 4) <= '0036',
        )) {
          const version = name.slice(0, 4);
          await copyFile(new URL(name, migrations), join(directory, name));
          await deployment(
            url,
            async (database) => {
              expect(await database.classify()).toMatchObject({
                kind: 'supported',
                version: String(Number(version) - 1).padStart(4, '0'),
              });
              expect((await database.upgrade()).version).toBe(version);
              expect(await database.classify()).toMatchObject({ kind: 'supported', version });
            },
            directory,
          );
          await sql(url, async (client) => {
            expect(
              (
                await client.query(
                  'SELECT to_jsonb(p) AS value FROM harness_pauses p WHERE id=$1',
                  [pause],
                )
              ).rows[0].value,
            ).toEqual(original);
            if (version === '0033') {
              expect(
                (await client.query('SELECT count(*)::int AS n FROM compact_freezes')).rows[0].n,
              ).toBe(0);
              await expect(
                client.query(
                  `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
                VALUES($1,$2,$3,$4,$5,$6,'user','manual_compact','user','invalidated')`,
                  [randomUUID(), owner, conversation, run, attempt, randomUUID()],
                ),
              ).rejects.toMatchObject({ code: '23514' });
              await client.query(
                `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
                VALUES($1,$2,$3,$4,$5,$6,'runtime','automatic_compact','runtime','invalidated')`,
                [randomUUID(), owner, conversation, run, attempt, randomUUID()],
              );
            }
            if (version === '0035') {
              await client.query(
                `INSERT INTO r3_context_freezes(run_id,owner_id,conversation_id,input_message_id,context)
                VALUES($1,$2,$3,$4,$5::jsonb)`,
                [
                  run,
                  owner,
                  conversation,
                  message,
                  JSON.stringify({ input: { type: 'user', message_id: message } }),
                ],
              );
              await expect(
                client.query('DELETE FROM r3_context_freezes WHERE run_id=$1', [run]),
              ).rejects.toBeDefined();
            }
            if (version === '0036') {
              expect(
                (
                  await client.query('SELECT context FROM r3_context_freezes WHERE run_id=$1', [
                    run,
                  ])
                ).rows[0].context,
              ).toEqual({ input: { type: 'user', message_id: message } });
            }
          });
          const mutation =
            version === '0033'
              ? [
                  'ALTER TABLE harness_pauses DROP CONSTRAINT harness_pauses_check',
                  `ALTER TABLE harness_pauses ADD CONSTRAINT harness_pauses_check CHECK ((reason='user' AND purpose='none' AND resume_source='user') OR (reason='runtime' AND purpose IN ('manual_compact','automatic_compact') AND resume_source='runtime'))`,
                ]
              : version === '0034'
                ? [
                    'ALTER TABLE compact_continuations DISABLE TRIGGER compact_continuations_immutable',
                    'ALTER TABLE compact_continuations ENABLE TRIGGER compact_continuations_immutable',
                  ]
                : version === '0035'
                  ? [
                      'ALTER TABLE r3_context_freezes ALTER COLUMN input_message_id DROP NOT NULL',
                      'ALTER TABLE r3_context_freezes ALTER COLUMN input_message_id SET NOT NULL',
                    ]
                  : [
                      'ALTER TABLE idle_compact_requests DISABLE TRIGGER idle_compact_requests_immutable',
                      'ALTER TABLE idle_compact_requests ENABLE TRIGGER idle_compact_requests_immutable',
                    ];
          await sql(url, async (client) => {
            await client.query(mutation[0]);
          });
          await deployment(
            url,
            async (database) => {
              expect((await database.classify()).kind).toBe('unknown');
              await expect(database.upgrade()).rejects.toMatchObject({
                code: 'unsupported_upgrade_source',
              });
            },
            directory,
          );
          await sql(url, async (client) => {
            await client.query(mutation[1]);
          });
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
