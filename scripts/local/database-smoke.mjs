import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { DeploymentDatabase, DeploymentDatabaseError } from './database.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_MIGRATIONS = path.join(ROOT, 'infra/migrations');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

// Every connection is explicitly injected. No environment or .env is consulted.
function explicitClient(connectionString) {
  let url, identity;
  try {
    url = new URL(connectionString);
    if (
      !['postgresql:', 'postgres:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !url.pathname.slice(1) ||
      url.search ||
      url.hash
    )
      throw new Error();
    identity = {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
    };
  } catch {
    throw new Error('smoke_connection_input_invalid');
  }
  const client = new pg.Client({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 5432),
    ...identity,
    ssl: false,
    application_name: 'along-lifecycle67-isolated-smoke',
    connectionTimeoutMillis: 5000,
    options: '-c search_path=public,pg_catalog',
    replication: 'false',
    client_encoding: 'UTF8',
  });
  client.on('error', () => {});
  return client;
}
async function withClient(connectionString, callback) {
  const client = explicitClient(connectionString);
  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end().catch(() => {});
  }
}
async function withDeployment(connectionString, options, callback) {
  const database = new DeploymentDatabase({ connectionString, ...options });
  try {
    await database.connect();
    await database.acquireLease();
    return await callback(database);
  } finally {
    await database.close();
  }
}
async function rejectsCode(callback, code) {
  await assert.rejects(
    callback,
    (error) => error instanceof DeploymentDatabaseError && error.code === code,
  );
}
async function signature(client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
    'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
    'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM outbox t),
    'invocations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY invocation_id) FROM tool_invocations t),
    'documents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM document_approvals t),
    'conversations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM conversations t),
    'messages',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messages t),
    'runs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM agent_runs t),
    'attempts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM run_attempts t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY version) FROM schema_migrations t),
    'schema',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,a.attname,a.atttypid,a.attnotnull) ORDER BY c.relname,a.attnum)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
      WHERE n.nspname='public')) AS value`)
  ).rows[0].value;
}
const CANARIES = `
INSERT INTO users(id,auth_email,display_name,metadata) VALUES ('00000000-0000-4000-8000-000000000001','lifecycle67@example.invalid','historical fixture','{"preserve":true}');
INSERT INTO tasks(id,owner_id,fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version,state)
VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','2020-01-01T00:00:00Z','2020-01-01 00:00','UTC',0,'fixture','cancelled');
INSERT INTO outbox(id,owner_id,task_id,expected_state_version,command,idempotency_key,status,ack_check_no,last_error)
VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1,'{"kind":"send"}','lifecycle67-fixture','acked_unknown',2,'legacy_send_uncertain');
INSERT INTO tool_invocations(invocation_id,owner_id,conversation_id,run_id,call_key,first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context,state)
VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','fixture','00000000-0000-4000-8000-000000000007','fixture','fixture',repeat('a',64),2,'non_transactional','{}','unknown');
INSERT INTO document_approvals(id,owner_id,conversation_id,run_id,workspace_id,workspace_grant,relative_path,base_read_invocation_id,base_version,exact_new_content,new_version,presentation_version,presentation_hash,preview)
VALUES ('00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','fixture','{}','fixture.txt','00000000-0000-4000-8000-000000000004',repeat('a',64),'preserve fixture',repeat('b',64),'document_replace.v1',repeat('c',64),'{}');
`;
const HISTORY_CANARIES = `
INSERT INTO conversations(id,owner_id,created_at)
VALUES ('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000001','2020-01-01T00:00:00.123456Z');
INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at)
SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105',role,
  E'  historical content\\n original whitespace  ','2020-01-01T00:00:00.123456Z'
FROM (VALUES (106,'user'),(107,'assistant'),(108,'system')) AS fixture(n,role);
INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,input_message_id)
VALUES ('00000000-0000-4000-8000-000000000109','00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000105','historical','chat',1,1,'00000000-0000-4000-8000-000000000106');
INSERT INTO run_attempts(id,owner_id,run_id,attempt_no)
VALUES ('00000000-0000-4000-8000-000000000110','00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000109',1);
`;

/** Run only against an explicitly supplied, disposable PostgreSQL 16 server.
 * The administrative account needs CREATEDB, event-trigger creation, catalog
 * updates for the isolated invalid-index fixture, and backend termination privileges.
 * Existing databases are never cleared or migrated.
 * Each scenario exclusively owns a newly CREATE DATABASE'd random name; cleanup
 * drops only names successfully created by this invocation.
 */
export async function runDatabaseSmoke({
  connectionString,
  migrationsDirectory: sourceMigrationsDirectory = DEFAULT_MIGRATIONS,
  report = () => {},
}) {
  // Validate before opening an administrative connection.
  const admin = explicitClient(connectionString);
  const created = new Set();
  const reports = [];
  const temp = await mkdtemp(path.join(tmpdir(), 'along-lifecycle67-'));
  // Keep the original #67 0016 and #68 0017 scenarios fixed as the inventory grows.
  const migrationsDirectory = path.join(temp, 'legacy0016');
  const accountMigrationsDirectory = path.join(temp, 'legacy0017');
  await mkdir(migrationsDirectory);
  await mkdir(accountMigrationsDirectory);
  for (const name of await readdir(sourceMigrationsDirectory)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    const sql = await readFile(path.join(sourceMigrationsDirectory, name));
    if (name.slice(0, 4) <= '0016') await writeFile(path.join(migrationsDirectory, name), sql);
    if (name.slice(0, 4) <= '0017')
      await writeFile(path.join(accountMigrationsDirectory, name), sql);
  }
  let stage = 'admin_connect';
  const record = (name) => {
    reports.push({ scenario: name, status: 'passed' });
    report({ scenario: name, status: 'passed' });
  };
  const databaseUrl = (name) => {
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  };
  async function fresh(name, callback) {
    stage = name;
    const databaseName = `along_lifecycle67_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${quote(databaseName)} TEMPLATE template0`);
    created.add(databaseName);
    return callback(databaseUrl(databaseName), databaseName);
  }
  async function baseline(url) {
    await withDeployment(url, { migrationsDirectory }, async (database) => {
      assert.equal(
        database.targetVersion,
        '0016',
        'Smoke requires the fixed 0016 baseline migration directory',
      );
      assert.equal((await database.initialize()).version, '0016');
    });
  }
  let cleanupFailed = false;
  try {
    await admin.connect();
    const version = (
      await admin.query("SELECT current_setting('server_version_num')::int AS version")
    ).rows[0].version;
    assert(version >= 160000 && version < 170000);
    await fresh('empty_and_readonly_restarts', async (url) => {
      await withDeployment(url, { migrationsDirectory }, async (database) => {
        assert.deepEqual(await database.classify(), {
          kind: 'empty',
          version: null,
          reason: 'empty_application_database',
        });
        assert.equal((await database.initialize()).version, '0016');
      });
      await withClient(url, async (client) => {
        await client.query(CANARIES);
        // Reject any DDL at the server, not via source inspection or a mocked query.
        await client.query(`CREATE FUNCTION lifecycle67_reject_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'smoke: readonly gate attempted DDL'; END; $$;
          CREATE EVENT TRIGGER lifecycle67_no_ddl ON ddl_command_start EXECUTE FUNCTION lifecycle67_reject_ddl()`);
        const before = await signature(client);
        for (let i = 0; i < 2; i++)
          await withDeployment(url, { migrationsDirectory }, async (database) => {
            assert.equal((await database.classify()).kind, 'supported');
            assert.equal((await database.initialize()).version, '0016');
            assert.equal((await database.upgrade()).version, '0016');
            await database.assertLease();
          });
        assert.deepEqual(await signature(client), before);
      });
      record('empty_initialize_old0016_two_restarts_zero_ddl_preserve_facts');
    });
    await fresh('forged_last_ledger', async (url) => {
      await withClient(url, (client) =>
        client.query(
          "CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(version) VALUES ('0016')",
        ),
      );
      await withDeployment(url, { migrationsDirectory }, async (database) => {
        assert.equal((await database.classify()).kind, 'unknown');
        await rejectsCode(() => database.initialize(), 'unknown_database_refused');
        await rejectsCode(() => database.upgrade(), 'unsupported_upgrade_source');
      });
      record('forged_last_ledger_refused');
    });
    await fresh('forged_contiguous_ledger', async (url) => {
      await withClient(url, (client) =>
        client.query(
          "CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(version) SELECT lpad(n::text,4,'0') FROM generate_series(12,16) n",
        ),
      );
      await withDeployment(url, { migrationsDirectory }, async (database) => {
        assert.equal((await database.classify()).kind, 'unknown');
        await rejectsCode(() => database.initialize(), 'unknown_database_refused');
        await rejectsCode(() => database.upgrade(), 'unsupported_upgrade_source');
      });
      record('forged_contiguous_ledger_without_baseline_refused');
    });
    await fresh('partial_early_initialization', async (url) => {
      const first = (await readdir(migrationsDirectory)).find(
        (name) => name.startsWith('0001_') && name.endsWith('.sql'),
      );
      assert(first);
      await withClient(url, (client) =>
        readFile(path.join(migrationsDirectory, first), 'utf8').then((sql) => client.query(sql)),
      );
      await withDeployment(url, { migrationsDirectory }, async (database) => {
        assert.equal((await database.classify()).kind, 'unknown');
        await rejectsCode(() => database.initialize(), 'unknown_database_refused');
      });
      record('partial_early_initialization_refused_without_stamping');
    });
    // Every damaged fixture gets its own committed state; no schema repair and no
    // false result from an uncommitted DDL transaction invisible to another client.
    const damageCases = [
      ['missing_early_column', 'ALTER TABLE users DROP COLUMN display_name'],
      ['missing_0016_column', 'ALTER TABLE document_approvals DROP COLUMN exact_new_content'],
      [
        'missing_0016_constraint',
        'ALTER TABLE document_approvals DROP CONSTRAINT document_approvals_base_version_check',
      ],
      [
        'wrong_0016_constraint',
        "ALTER TABLE document_approvals DROP CONSTRAINT document_approvals_base_version_check; ALTER TABLE document_approvals ADD CONSTRAINT document_approvals_base_version_check CHECK (base_version <> '')",
      ],
      // Same tokens after parentheses are erased, but the OR now bypasses the
      // tools_allowlist array requirement. The final INSERT proves the weakening.
      [
        'weakened_check_boolean_grouping',
        `
        ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_harness_context_check;
        ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_harness_context_check CHECK (
          (jsonb_typeof(tools_allowlist) = 'array' AND execution = 'business')
          OR (mode = 'chat' AND input_message_id IS NOT NULL
            AND frozen_context IS NOT NULL AND jsonb_typeof(frozen_context) = 'object')
        );
        INSERT INTO conversations(id,owner_id) VALUES (
          '00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000100');
        INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES (
          '00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000100',
          '00000000-0000-4000-8000-000000000101','user','grouping fixture');
        INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,
          budget_max_iterations,budget_max_tokens,tools_allowlist,frozen_context,input_message_id)
        VALUES ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000100',
          '00000000-0000-4000-8000-000000000101','fixture','chat',1,1,'{}','{}',
          '00000000-0000-4000-8000-000000000102');
      `,
      ],
      ['missing_0016_index', 'DROP INDEX document_approvals_owner_run'],
      [
        'wrong_0016_index',
        'DROP INDEX document_approvals_owner_run; CREATE INDEX document_approvals_owner_run ON document_approvals(owner_id)',
      ],
      [
        'wrong_index_direction',
        'DROP INDEX users_created_at_idx; CREATE INDEX users_created_at_idx ON users(created_at ASC)',
      ],
      [
        'wrong_index_null_order',
        'DROP INDEX users_created_at_idx; CREATE INDEX users_created_at_idx ON users(created_at DESC NULLS LAST)',
      ],
      [
        'disabled_0016_trigger',
        'ALTER TABLE document_approvals DISABLE TRIGGER document_approvals_immutable',
      ],
      ['missing_0016_trigger', 'DROP TRIGGER document_approvals_predecessor ON document_approvals'],
      [
        'altered_trigger_function',
        'CREATE OR REPLACE FUNCTION document_approvals_guard_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$',
      ],
      ['missing_default', 'ALTER TABLE outbox ALTER COLUMN ack_check_no DROP DEFAULT'],
      ['wrong_nullability', 'ALTER TABLE document_approvals ALTER COLUMN state DROP NOT NULL'],
      ['missing_0016_table', 'DROP TABLE document_approval_decisions'],
      ['ledger_gap', "DELETE FROM schema_migrations WHERE version='0013'"],
      ['higher_version', "INSERT INTO schema_migrations(version) VALUES ('0017')"],
    ];
    for (const [name, sql] of damageCases)
      await fresh(name, async (url) => {
        await baseline(url);
        await withClient(url, (client) => client.query(sql));
        await withDeployment(url, { migrationsDirectory }, async (database) => {
          assert.equal((await database.classify()).kind, 'unknown');
          await rejectsCode(() => database.upgrade(), 'unsupported_upgrade_source');
        });
        record(`${name}_refused`);
      });
    await fresh('leases_and_client_fence', async (url, name) => {
      const first = new DeploymentDatabase({ connectionString: url, migrationsDirectory });
      const second = new DeploymentDatabase({ connectionString: url, migrationsDirectory });
      try {
        await first.connect();
        await first.acquireLease();
        await second.connect();
        await rejectsCode(() => second.acquireLease(), 'deployment_busy');
        await rejectsCode(() => first.assertNoOtherClients(), 'unmanaged_database_clients');
        await second.close();
        await first.assertNoOtherClients();
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND application_name='along-local-lifecycle'`,
          [name],
        );
        await assert.rejects(
          () => first.assertLease(),
          (error) => error instanceof DeploymentDatabaseError,
        );
        await assert.rejects(
          () => first.classify(),
          (error) => error instanceof DeploymentDatabaseError,
        );
      } finally {
        await first.close();
        await second.close();
      }
      await withDeployment(url, { migrationsDirectory }, (database) => database.assertLease());
      record('concurrent_lease_external_client_fence_disconnect_fail_closed_and_release');
    });
    await fresh('account0017_explicit_upgrade_preserves_original_facts', async (url) => {
      await baseline(url);
      await withClient(url, (client) => client.query(CANARIES));
      const originalFacts = await withClient(
        url,
        async (client) =>
          (
            await client.query(`SELECT jsonb_build_object(
        'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
        'accounts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth_accounts t),
        'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sessions t),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t)) AS value`)
          ).rows[0].value,
      );
      await withDeployment(
        url,
        { migrationsDirectory: accountMigrationsDirectory },
        async (database) => {
          assert.equal(database.targetVersion, '0017');
          assert.deepEqual(await database.classify(), {
            kind: 'supported',
            version: '0016',
            reason: 'explicit_upgrade_required',
          });
          await rejectsCode(() => database.initialize(), 'explicit_upgrade_required');
          assert.equal((await database.upgrade()).version, '0017');
        },
      );
      await withClient(url, async (client) => {
        const after = (
          await client.query(`SELECT jsonb_build_object(
          'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
          'accounts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth_accounts t),
          'sessions',(SELECT jsonb_agg(to_jsonb(t)-'ip_address'-'user_agent' ORDER BY id) FROM sessions t),
          'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t)) AS value`)
        ).rows[0].value;
        assert.deepEqual(after, originalFacts);
        assert.equal(
          (await client.query('SELECT count(*)::int AS count FROM installation_admin')).rows[0]
            .count,
          0,
        );
        const before = await signature(client);
        for (let restart = 0; restart < 2; restart++) {
          await withDeployment(
            url,
            { migrationsDirectory: accountMigrationsDirectory },
            async (database) => {
              assert.equal((await database.classify()).version, '0017');
              assert.equal((await database.initialize()).version, '0017');
              assert.equal((await database.upgrade()).version, '0017');
            },
          );
        }
        assert.deepEqual(await signature(client), before);
      });
      record('account0017_explicit_upgrade_preserves_original_facts_two_readonly_restarts');
    });
    for (const [name, mutation] of [
      ['missing_admin_table', 'DROP TABLE installation_admin'],
      ['missing_standard_column', 'ALTER TABLE sessions DROP COLUMN ip_address'],
      [
        'wrong_admin_singleton',
        'ALTER TABLE installation_admin DROP CONSTRAINT installation_admin_singleton_check; ALTER TABLE installation_admin ADD CONSTRAINT installation_admin_singleton_check CHECK (singleton OR user_id IS NOT NULL)',
      ],
      [
        'wrong_admin_foreign_key',
        'ALTER TABLE installation_admin DROP CONSTRAINT installation_admin_user_id_fkey; ALTER TABLE installation_admin ADD CONSTRAINT installation_admin_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE',
      ],
      ['unstamped_account_schema', "DELETE FROM schema_migrations WHERE version='0017'"],
      ['future_account_ledger', "INSERT INTO schema_migrations(version) VALUES('0018')"],
    ]) {
      await fresh(`account0017_${name}`, async (url) => {
        await withDeployment(url, { migrationsDirectory: accountMigrationsDirectory }, (database) =>
          database.initialize(),
        );
        await withClient(url, (client) => client.query(mutation));
        await withDeployment(
          url,
          { migrationsDirectory: accountMigrationsDirectory },
          async (database) => {
            assert.equal((await database.classify()).kind, 'unknown');
            await rejectsCode(() => database.upgrade(), 'unsupported_upgrade_source');
            await rejectsCode(() => database.initialize(), 'unknown_database_refused');
          },
        );
        record(`account0017_${name}_refused`);
      });
    }
    await fresh('history0018_explicit_upgrade_preserves_original_facts', async (url) => {
      await withDeployment(url, { migrationsDirectory: accountMigrationsDirectory }, (database) =>
        database.initialize(),
      );
      const beforeFacts = await withClient(url, async (client) => {
        await client.query(CANARIES + HISTORY_CANARIES);
        const facts = await signature(client);
        delete facts.schema;
        delete facts.ledger;
        return facts;
      });
      await withDeployment(
        url,
        { migrationsDirectory: sourceMigrationsDirectory },
        async (database) => {
          assert.equal(database.targetVersion, '0018');
          assert.deepEqual(await database.classify(), {
            kind: 'supported',
            version: '0017',
            reason: 'explicit_upgrade_required',
          });
          await rejectsCode(() => database.initialize(), 'explicit_upgrade_required');
          assert.equal((await database.upgrade()).version, '0018');
        },
      );
      await withClient(url, async (client) => {
        const afterFacts = await signature(client);
        delete afterFacts.schema;
        delete afterFacts.ledger;
        assert.deepEqual(afterFacts, beforeFacts);
        await client.query(`CREATE FUNCTION history0018_reject_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'smoke: history restart attempted DDL'; END; $$;
          CREATE EVENT TRIGGER history0018_no_ddl ON ddl_command_start EXECUTE FUNCTION history0018_reject_ddl()`);
        const before = await signature(client);
        for (let restart = 0; restart < 2; restart++)
          await withDeployment(
            url,
            { migrationsDirectory: sourceMigrationsDirectory },
            async (database) => {
              assert.deepEqual(await database.classify(), {
                kind: 'supported',
                version: '0018',
                reason: 'target_schema_verified',
              });
              assert.equal((await database.initialize()).version, '0018');
              assert.equal((await database.upgrade()).version, '0018');
            },
          );
        assert.deepEqual(await signature(client), before);
      });
      record('history0017_to0018_preserves_facts_repeated_upgrade_two_readonly_restarts');
    });
    for (const [name, mutation] of [
      ['missing_conversation_index', 'DROP INDEX conversations_owner_history_idx'],
      ['missing_message_index', 'DROP INDEX messages_owner_conversation_history_idx'],
      ['missing_run_index', 'DROP INDEX agent_runs_owner_conversation_history_idx'],
      [
        'wrong_conversation_order',
        'DROP INDEX conversations_owner_history_idx; CREATE INDEX conversations_owner_history_idx ON conversations(owner_id,created_at ASC,id DESC)',
      ],
      [
        'wrong_message_order',
        "DROP INDEX messages_owner_conversation_history_idx; CREATE INDEX messages_owner_conversation_history_idx ON messages(owner_id,conversation_id,id,created_at) WHERE role IN ('user','assistant')",
      ],
      [
        'wrong_run_owner',
        'DROP INDEX agent_runs_owner_conversation_history_idx; CREATE INDEX agent_runs_owner_conversation_history_idx ON agent_runs(conversation_id,created_at,id)',
      ],
      [
        'wrong_null_order',
        'DROP INDEX conversations_owner_history_idx; CREATE INDEX conversations_owner_history_idx ON conversations(owner_id,created_at DESC NULLS LAST,id DESC)',
      ],
      [
        'missing_message_predicate',
        'DROP INDEX messages_owner_conversation_history_idx; CREATE INDEX messages_owner_conversation_history_idx ON messages(owner_id,conversation_id,created_at,id)',
      ],
      [
        'broadened_message_predicate',
        "DROP INDEX messages_owner_conversation_history_idx; CREATE INDEX messages_owner_conversation_history_idx ON messages(owner_id,conversation_id,created_at,id) WHERE role IN ('user','assistant','system')",
      ],
      [
        'invalid_index',
        "UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid='public.messages_owner_conversation_history_idx'::regclass",
      ],
      [
        'not_ready_index',
        "UPDATE pg_catalog.pg_index SET indisready=false WHERE indexrelid='public.agent_runs_owner_conversation_history_idx'::regclass",
      ],
      ['future_history_version', "INSERT INTO schema_migrations(version) VALUES('0019')"],
    ])
      await fresh(`history0018_${name}`, async (url) => {
        await withDeployment(url, { migrationsDirectory: sourceMigrationsDirectory }, (database) =>
          database.initialize(),
        );
        await withClient(url, (client) => client.query(mutation));
        const before = await withClient(url, signature);
        await withDeployment(
          url,
          { migrationsDirectory: sourceMigrationsDirectory },
          async (database) => {
            assert.equal((await database.classify()).kind, 'unknown');
            await rejectsCode(() => database.initialize(), 'unknown_database_refused');
            await rejectsCode(() => database.upgrade(), 'unsupported_upgrade_source');
          },
        );
        assert.deepEqual(await withClient(url, signature), before);
        record(`history0018_${name}_refused_without_repair`);
      });
    await fresh('history0018_forged_version_without_indexes', async (url) => {
      await withDeployment(url, { migrationsDirectory: accountMigrationsDirectory }, (database) =>
        database.initialize(),
      );
      await withClient(url, (client) =>
        client.query("INSERT INTO schema_migrations(version) VALUES('0018')"),
      );
      await withDeployment(
        url,
        { migrationsDirectory: sourceMigrationsDirectory },
        async (database) => {
          assert.equal((await database.classify()).kind, 'unknown');
          await rejectsCode(() => database.initialize(), 'unknown_database_refused');
          await rejectsCode(() => database.upgrade(), 'unsupported_upgrade_source');
        },
      );
      record('history0018_forged_version_without_indexes_refused');
    });
    // Create an extension migration set outside the repository. The first step
    // commits a canary once. The second step fails or is terminated mid-transaction.
    const extended = path.join(temp, 'migrations'),
      verificationDirectory = path.join(temp, 'baselines');
    await mkdir(extended);
    await mkdir(verificationDirectory);
    for (const name of await readdir(migrationsDirectory))
      if (/^\d{4}_[a-z0-9_]+\.sql$/.test(name))
        await writeFile(
          path.join(extended, name),
          await readFile(path.join(migrationsDirectory, name)),
        );
    const step17 = `BEGIN; CREATE TABLE lifecycle67_committed(id integer PRIMARY KEY, count integer NOT NULL); INSERT INTO lifecycle67_committed VALUES(1,1); INSERT INTO schema_migrations(version) VALUES('0017'); COMMIT;`;
    const step18 = `BEGIN; CREATE TABLE lifecycle67_interrupted(id integer PRIMARY KEY); SELECT pg_sleep(30); INSERT INTO schema_migrations(version) VALUES('0018'); COMMIT;`;
    const fixed18 = `BEGIN; CREATE TABLE lifecycle67_interrupted(id integer PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES('0018'); COMMIT;`;
    await writeFile(path.join(extended, '0017_smoke.sql'), step17);
    await writeFile(
      path.join(verificationDirectory, '0017.sql'),
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM lifecycle67_committed WHERE id=1 AND count=1) THEN RAISE EXCEPTION 'fixture invalid'; END IF; END; $$;`,
    );
    await writeFile(
      path.join(verificationDirectory, '0018.sql'),
      `DO $$ BEGIN IF to_regclass('public.lifecycle67_interrupted') IS NULL THEN RAISE EXCEPTION 'fixture missing'; END IF; END; $$;`,
    );
    await fresh('migration_failure_committed_step_not_replayed', async (url) => {
      await baseline(url);
      await writeFile(
        path.join(extended, '0018_smoke.sql'),
        "BEGIN; SELECT 1/0; INSERT INTO schema_migrations(version) VALUES('0018'); COMMIT;",
      );
      const options = { migrationsDirectory: extended, verificationDirectory };
      await withDeployment(url, options, async (database) => {
        assert.equal(database.targetVersion, '0018');
        assert.deepEqual(await database.classify(), {
          kind: 'supported',
          version: '0016',
          reason: 'explicit_upgrade_required',
        });
        await rejectsCode(() => database.upgrade(), 'migration_failed_reconcile_before_retry');
        assert.equal((await database.classify()).version, '0017');
      });
      await withClient(url, async (client) => {
        assert.equal(
          (await client.query('SELECT count FROM lifecycle67_committed')).rows[0].count,
          1,
        );
        assert.deepEqual(
          (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
            (r) => r.version,
          ),
          ['0012', '0013', '0014', '0015', '0016', '0017'],
        );
      });
      await writeFile(path.join(extended, '0018_smoke.sql'), fixed18);
      await withDeployment(url, options, async (database) =>
        assert.equal((await database.upgrade()).version, '0018'),
      );
      await withClient(url, async (client) =>
        assert.equal(
          (await client.query('SELECT count FROM lifecycle67_committed')).rows[0].count,
          1,
        ),
      );
      record('failed_migration_retains_commit_explicit_repair_skips_committed_0017');
    });
    await fresh('migration_backend_interruption', async (url, name) => {
      await baseline(url);
      await writeFile(path.join(extended, '0018_smoke.sql'), step18);
      const database = new DeploymentDatabase({
        connectionString: url,
        migrationsDirectory: extended,
        verificationDirectory,
      });
      try {
        await database.connect();
        await database.acquireLease();
        const rejected = assert.rejects(
          () => database.upgrade(),
          (error) =>
            error instanceof DeploymentDatabaseError &&
            error.code === 'migration_connection_lost_reconcile_before_retry',
        );
        let interrupted = false;
        for (let i = 0; i < 200; i++) {
          const active = (
            await admin.query(
              `SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name='along-local-lifecycle' AND wait_event='PgSleep'`,
              [name],
            )
          ).rows;
          if (active.length) {
            await admin.query('SELECT pg_terminate_backend($1)', [active[0].pid]);
            interrupted = true;
            break;
          }
          await pause(25);
        }
        await rejected;
        assert(interrupted, 'Migration never reached the interruption fixture');
        await assert.rejects(
          () => database.assertLease(),
          (error) => error instanceof DeploymentDatabaseError,
        );
      } finally {
        await database.close();
      }
      await withClient(url, async (client) => {
        assert.equal(
          (
            await client.query(
              "SELECT to_regclass('public.lifecycle67_interrupted') IS NULL AS absent",
            )
          ).rows[0].absent,
          true,
        );
        assert.equal(
          (await client.query('SELECT count FROM lifecycle67_committed')).rows[0].count,
          1,
        );
      });
      await writeFile(path.join(extended, '0018_smoke.sql'), fixed18);
      await withDeployment(
        url,
        { migrationsDirectory: extended, verificationDirectory },
        async (database) => assert.equal((await database.upgrade()).version, '0018'),
      );
      record('interrupted_transaction_rolls_back_permit_lost_reconnect_skips_commit');
    });
    await fresh('launcher_process_interruption', async (url, name) => {
      await baseline(url);
      await writeFile(path.join(extended, '0018_smoke.sql'), step18);
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--interruption-child'],
        { stdio: ['pipe', 'ignore', 'ignore'], env: {} },
      );
      const exited = new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      child.stdin.end(
        JSON.stringify({
          connectionString: url,
          migrationsDirectory: extended,
          verificationDirectory,
        }),
      );
      try {
        let active = false;
        for (let i = 0; i < 200; i++) {
          active = (
            await admin.query(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='along-local-lifecycle' AND wait_event='PgSleep') AS active`,
              [name],
            )
          ).rows[0].active;
          if (active) break;
          await pause(25);
        }
        assert(active, 'Child did not reach interrupted migration');
        child.kill('SIGKILL');
        await exited;
        // PostgreSQL detects socket loss at its next interrupt check; wait for
        // the exact owned backend to exit before attempting writer handoff.
        for (let i = 0; i < 1400; i++) {
          const present = (
            await admin.query(
              'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1) AS present',
              [name],
            )
          ).rows[0].present;
          if (!present) break;
          if (i === 1399) throw new Error('child_backend_did_not_exit');
          await pause(25);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
      await writeFile(path.join(extended, '0018_smoke.sql'), fixed18);
      await withDeployment(
        url,
        { migrationsDirectory: extended, verificationDirectory },
        async (database) => assert.equal((await database.upgrade()).version, '0018'),
      );
      await withClient(url, async (client) =>
        assert.equal(
          (await client.query('SELECT count FROM lifecycle67_committed')).rows[0].count,
          1,
        ),
      );
      record('launcher_kill_releases_session_transaction_reconciled_no_replay');
    });
    stage = 'connection_failure';
    const missing = `along_lifecycle67_missing_${randomUUID().replaceAll('-', '')}`;
    const database = new DeploymentDatabase({
      connectionString: databaseUrl(missing),
      migrationsDirectory,
    });
    await rejectsCode(() => database.connect(), 'connection_failed');
    await rejectsCode(() => database.classify(), 'deployment_lease_lost');
    await database.close();
    record('connection_failure_never_classified_as_empty');
  } catch (error) {
    // Do not include assertion values, PG messages, SQL, URLs, object IDs or causes.
    const code = error instanceof DeploymentDatabaseError ? error.code : 'scenario_failed';
    throw new Error(`database_smoke:${stage}:${code}`);
  } finally {
    for (const name of created) {
      // Only a successful CREATE above adds to this set. Never delete a supplied DB.
      await admin.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`).catch(() => {
        cleanupFailed = true;
        report({ scenario: 'owned_fixture_cleanup', status: 'failed' });
      });
    }
    await admin.end().catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
  if (cleanupFailed) throw new Error('database_smoke:owned_fixture_cleanup:scenario_failed');
  return reports;
}

async function stdinJson() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) throw new Error('smoke_input_invalid');
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error('smoke_input_invalid');
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const input = await stdinJson();
    if (process.argv[2] === '--interruption-child') {
      await withDeployment(input.connectionString, input, (database) => database.upgrade());
    } else {
      await runDatabaseSmoke({
        ...input,
        report: (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
      });
    }
  } catch (error) {
    const message =
      typeof error.message === 'string' &&
      /^database_smoke:[a-z0-9_]+:[a-z0-9_]+$/.test(error.message)
        ? error.message
        : 'database_smoke:input_or_child:failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
