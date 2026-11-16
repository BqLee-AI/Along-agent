import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DeploymentDatabase } from '../local/database.mjs';
import { createAuth } from '../../apps/api/src/modules/identity/better-auth.js';

const connectionString = process.env.DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;

databaseTests('invited account schema explicit local upgrade against isolated PG16', () => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  let oldDirectory: string;
  let passwordHash: string;
  beforeAll(async () => {
    oldDirectory = await mkdtemp(join(tmpdir(), 'identity-0023-migrations-'));
    const source = new URL('../../infra/migrations/', import.meta.url);
    for (const file of (await readdir(source)).filter(
      (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0023',
    ))
      await copyFile(new URL(file, source), join(oldDirectory, file));
    passwordHash = await (
      await createAuth(admin, { secret: 'isolated-112-p1-migration-library-only' })!.$context
    ).password.hash('original isolated password');
  });
  afterAll(async () => {
    await admin.end();
    if (oldDirectory) await rm(oldDirectory, { recursive: true, force: true });
  });

  async function isolated(action: (url: string) => Promise<void>) {
    const name = `identity_lifecycle_${randomUUID().replaceAll('-', '')}`;
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
  async function oldDatabase(url: string) {
    await deployment(
      url,
      async (database) => {
        expect((await database.initialize()).version).toBe('0023');
      },
      oldDirectory,
    );
  }
  const originalFacts = `SELECT jsonb_build_object(
    'users',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM users u),
    'credentials',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM auth_accounts a),
    'sessions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM sessions s),
    'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY user_id),'[]') FROM installation_admin i),
    'conversations',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM conversations c),
    'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY version),'[]') FROM schema_migrations m WHERE version<='0023')) AS value`;

  it('preserves original users, credentials, secret-derived session hashes and business owners; admits only the bound administrator; reconnects twice with zero DDL', async () => {
    await isolated(async (url) => {
      await oldDatabase(url);
      const administrator = randomUUID(),
        ordinary = randomUUID(),
        seed = randomUUID();
      let original: unknown;
      await sql(url, async (client) => {
        for (const [id, status] of [
          [administrator, 'active'],
          [ordinary, 'active'],
          [seed, 'disabled'],
        ])
          await client.query(
            "INSERT INTO users(id,auth_email,display_name,status,metadata) VALUES($1,$2,'original owner',$3,'{\"preserve\":true}')",
            [id, `${id}@local.invalid`, status],
          );
        for (const id of [administrator, ordinary])
          await client.query(
            'INSERT INTO auth_accounts(user_id,account_id,password_hash) VALUES($1::uuid,$1::uuid::text,$2)',
            [id, passwordHash],
          );
        await client.query(
          "INSERT INTO auth_accounts(user_id,account_id) VALUES($1::uuid,'seed:'||$1::uuid::text)",
          [seed],
        );
        await client.query('INSERT INTO installation_admin(user_id) VALUES($1)', [administrator]);
        await client.query(
          "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,'original-session-hmac-fixture',now()+interval '7 days')",
          [ordinary],
        );
        await client.query(
          "INSERT INTO conversations(id,owner_id,title) VALUES($1,$2,'original ordinary history')",
          [randomUUID(), ordinary],
        );
        original = (await client.query(originalFacts)).rows[0].value;
      });
      await deployment(url, async (database) => {
        expect(await database.classify()).toMatchObject({
          kind: 'supported',
          version: '0023',
          reason: 'explicit_upgrade_required',
        });
        await expect(database.initialize()).rejects.toMatchObject({
          code: 'explicit_upgrade_required',
        });
        expect((await database.upgrade()).version).toBe('0029');
      });
      await sql(url, async (client) => {
        expect((await client.query(originalFacts)).rows[0].value).toEqual(original);
        expect(
          (
            await client.query(
              'SELECT user_id,source,credential_revision,reset_generation,contact_generation FROM identity_account_admissions',
            )
          ).rows,
        ).toEqual([
          {
            user_id: administrator,
            source: 'installation_admin',
            credential_revision: '1',
            reset_generation: '0',
            contact_generation: '0',
          },
        ]);
        await expect(
          client.query(
            "INSERT INTO auth_accounts(user_id,account_id) VALUES($1::uuid,'duplicate:'||$1::uuid::text)",
            [ordinary],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await client.query(`CREATE FUNCTION identity_reject_restart_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'identity restart attempted DDL'; END; $$;
          CREATE EVENT TRIGGER identity_restart_readonly ON ddl_command_start EXECUTE FUNCTION identity_reject_restart_ddl()`);
      });
      for (let restart = 0; restart < 2; restart++) {
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0029' });
          expect((await database.initialize()).version).toBe('0029');
          expect((await database.upgrade()).version).toBe('0029');
        });
      }
    });
  }, 30000);

  it('does not auto-admit any historical active account when no administrator was explicitly bound', async () => {
    await isolated(async (url) => {
      await oldDatabase(url);
      await sql(url, async (client) => {
        const id = randomUUID();
        await client.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
          id,
          `${id}@local.invalid`,
        ]);
        await client.query(
          'INSERT INTO auth_accounts(user_id,account_id,password_hash) VALUES($1::uuid,$1::uuid::text,$2)',
          [id, passwordHash],
        );
      });
      await deployment(url, async (database) => {
        await database.upgrade();
      });
      await sql(url, async (client) => {
        expect(
          (await client.query('SELECT count(*) FROM identity_account_admissions')).rows[0].count,
        ).toBe('0');
      });
    });
  }, 30000);

  for (const anomaly of [
    'duplicate',
    'malformed_hash',
    'wrong_account_id',
    'seed_with_password',
    'bound_without_credential',
  ] as const) {
    it(`refuses original ${anomaly} without rewriting identity facts or stamping the new ledger`, async () => {
      await isolated(async (url) => {
        await oldDatabase(url);
        let original: unknown;
        await sql(url, async (client) => {
          const id = randomUUID();
          await client.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
            id,
            `${id}@local.invalid`,
          ]);
          if (anomaly === 'bound_without_credential')
            await client.query('INSERT INTO installation_admin(user_id) VALUES($1)', [id]);
          else {
            await client.query(
              'INSERT INTO auth_accounts(user_id,account_id,password_hash) VALUES($1,$2,$3)',
              [
                id,
                anomaly === 'wrong_account_id'
                  ? 'wrong-original-account'
                  : anomaly === 'seed_with_password'
                    ? `seed:${id}`
                    : id,
                anomaly === 'malformed_hash' ? 'invalid-old-hash' : passwordHash,
              ],
            );
            if (anomaly === 'duplicate')
              await client.query(
                "INSERT INTO auth_accounts(user_id,account_id) VALUES($1::uuid,'seed:'||$1::uuid::text)",
                [id],
              );
          }
          original = (await client.query(originalFacts)).rows[0].value;
        });
        await deployment(url, async (database) => {
          await expect(database.upgrade()).rejects.toBeDefined();
          expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0023' });
        });
        await sql(url, async (client) => {
          expect((await client.query(originalFacts)).rows[0].value).toEqual(original);
          expect(
            (
              await client.query(
                "SELECT to_regclass('public.identity_account_admissions') AS admission",
              )
            ).rows[0].admission,
          ).toBeNull();
        });
      });
    }, 30000);
  }

  it('rolls back a real DDL failure, retains the old copy, and permits only explicit forward repair', async () => {
    await isolated(async (url) => {
      await oldDatabase(url);
      let original: unknown;
      await sql(url, async (client) => {
        original = (await client.query(originalFacts)).rows[0].value;
        await client.query(`CREATE FUNCTION identity_reject_upgrade_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
          BEGIN IF tg_tag='CREATE TABLE' THEN RAISE EXCEPTION 'isolated intentional upgrade failure'; END IF; END; $$;
          CREATE EVENT TRIGGER identity_upgrade_failure ON ddl_command_start EXECUTE FUNCTION identity_reject_upgrade_ddl()`);
      });
      await deployment(url, async (database) => {
        await expect(database.upgrade()).rejects.toBeDefined();
      });
      await sql(url, async (client) => {
        expect((await client.query(originalFacts)).rows[0].value).toEqual(original);
        expect(
          (await client.query("SELECT to_regclass('public.identity_invitations') AS invitations"))
            .rows[0].invitations,
        ).toBeNull();
        await client.query('DROP EVENT TRIGGER identity_upgrade_failure');
      });
      await deployment(url, async (database) => {
        expect((await database.upgrade()).version).toBe('0029');
      });
    });
  }, 30000);

  for (const [name, mutation] of [
    [
      'missing cipher key',
      'ALTER TABLE identity_contacts ALTER COLUMN encryption_key_id DROP NOT NULL',
    ],
    [
      'weak ciphertext group',
      'ALTER TABLE identity_challenges DROP CONSTRAINT identity_challenges_candidate_check',
    ],
    [
      'missing credential uniqueness',
      'ALTER TABLE auth_accounts DROP CONSTRAINT auth_accounts_user_id_key',
    ],
    ['missing invitation uniqueness', 'DROP INDEX identity_invitations_pending_lookup_idx'],
    [
      'wrong history order',
      'DROP INDEX identity_invitations_creator_created_idx; CREATE INDEX identity_invitations_creator_created_idx ON identity_invitations(created_by,created_at,id)',
    ],
    [
      'weakened action expiry',
      'ALTER TABLE identity_action_keys DROP CONSTRAINT identity_action_keys_replay_check',
    ],
    ['unstamped schema', "DELETE FROM schema_migrations WHERE version='0024'"],
  ]) {
    it(`read-only classification refuses ${name} and does not repair or rewrite the catalog`, async () => {
      await isolated(async (url) => {
        await deployment(url, async (database) => {
          await database.initialize();
        });
        const snapshot = `SELECT jsonb_build_object('constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c WHERE connamespace='public'::regnamespace),'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace),'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m)) AS value`;
        let original: unknown;
        await sql(url, async (client) => {
          await client.query(mutation!);
          original = (await client.query(snapshot)).rows[0].value;
        });
        await deployment(url, async (database) => {
          expect((await database.classify()).kind).toBe('unknown');
          await expect(database.initialize()).rejects.toBeDefined();
          await expect(database.upgrade()).rejects.toBeDefined();
        });
        await sql(url, async (client) => {
          expect((await client.query(snapshot)).rows[0].value).toEqual(original);
        });
      });
    }, 30000);
  }
});
