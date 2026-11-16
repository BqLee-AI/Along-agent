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
});
