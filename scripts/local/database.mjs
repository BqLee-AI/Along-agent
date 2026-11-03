import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LEASE = [1095520078, 67];
const BASELINE = '0016';

export class DeploymentDatabaseError extends Error {
  constructor(code) {
    super(`Local database: ${code}. Stop writers and consult the lifecycle recovery guide.`);
    this.name = 'DeploymentDatabaseError';
    this.code = code;
  }
}
const fail = (code) => {
  throw new DeploymentDatabaseError(code);
};

export function hostDatabaseUrl(config) {
  const { user, password, name } = config.database;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${config.ports.postgres}/${encodeURIComponent(name)}`;
}

// This is a bounded 0016 inventory, not a general migration/schema diff engine.
// Type suffix '?' means nullable. All other columns must be NOT NULL.
const TABLES = {
  users:
    'id:uuid display_name:text primary_email_hash:text? auth_subject:text? auth_provider:text? timezone_id:text? status:text created_at:timestamptz updated_at:timestamptz metadata:jsonb auth_email:text email_verified:boolean',
  sessions:
    'id:uuid user_id:uuid token_hash:text created_at:timestamptz expires_at:timestamptz revoked_at:timestamptz? last_seen_at:timestamptz? client_info:jsonb',
  auth_accounts:
    'id:uuid user_id:uuid provider_id:text account_id:text password_hash:text? created_at:timestamptz updated_at:timestamptz',
  conversations:
    'id:uuid owner_id:uuid title:text status:text confirmed_timezone_id:text? anchor_received_at_utc:timestamptz? created_at:timestamptz updated_at:timestamptz',
  messages:
    'id:uuid owner_id:uuid conversation_id:uuid role:text content:text request_id:text? created_at:timestamptz',
  agent_runs:
    'id:uuid owner_id:uuid conversation_id:uuid agent_revision:text mode:text status:text budget_max_iterations:integer budget_max_tokens:integer created_at:timestamptz ended_at:timestamptz? execution:text tools_allowlist:jsonb frozen_context:jsonb? input_message_id:uuid? waiting_checkpoint_id:uuid? waiting_invocation_id:uuid? waiting_approval_id:uuid?',
  run_attempts:
    'id:uuid owner_id:uuid run_id:uuid attempt_no:integer lease_token:uuid? lease_expires_at:timestamptz? status:text created_at:timestamptz ended_at:timestamptz?',
  run_checkpoints:
    'id:uuid owner_id:uuid attempt_id:uuid seq:integer kind:text payload:jsonb stream_protocol_version:text created_at:timestamptz event_seq:bigint',
  agent_revisions:
    'id:uuid owner_id:uuid? name:text revision:text prompt_version:text tools_allowlist:jsonb created_at:timestamptz',
  prompt_versions: 'id:uuid name:text version:text content_hash:text created_at:timestamptz',
  approvals:
    'id:uuid owner_id:uuid conversation_id:uuid? original_text:text? fire_at_utc:timestamptz wall_time:text timezone_id:text fold:smallint resolved_utc_offset_seconds:integer tzdb_version:text occurrence:text presentation_hash:text presentation_version:text state:text created_at:timestamptz expires_at:timestamptz consumed_task_id:uuid? supersedes_approval_id:uuid? kind:text target_task_id:uuid? expected_state_version:integer?',
  tasks:
    'id:uuid owner_id:uuid kind:text source_approval_id:uuid? recreated_from_task_id:uuid? fire_at_utc:timestamptz wall_time:text timezone_id:text fold:smallint resolved_utc_offset_seconds:integer tzdb_version:text occurrence:text state:text state_version:integer schedule_receipt:text? original_note:text? created_at:timestamptz',
  task_events:
    'id:uuid owner_id:uuid task_id:uuid state_version:integer type:text recorded_at_utc:timestamptz evidence_ref:text',
  outbox:
    'id:uuid owner_id:uuid task_id:uuid expected_state_version:integer command:jsonb idempotency_key:text attempt_no:integer status:text created_at:timestamptz updated_at:timestamptz last_attempt_at:timestamptz? ack_check_no:integer provider_receipt_id:text? last_error:text?',
  notifications:
    'id:uuid owner_id:uuid task_id:uuid channel:text title:text body:text idempotency_key:text status:text created_at:timestamptz sent_at:timestamptz? fire_at_utc:timestamptz? expected_state_version:integer?',
  task_leases:
    'task_id:uuid owner_id:uuid expected_state_version:integer lease_owner:text lease_expires_at:timestamptz',
  security_events:
    'id:uuid owner_id:uuid task_id:uuid? type:text recorded_at_utc:timestamptz evidence_ref:text',
  conversation_idempotency:
    'owner_id:uuid idempotency_key:text request_hash:text conversation_id:uuid run_id:uuid user_message_id:uuid? created_at:timestamptz expires_at:timestamptz',
  tool_calls:
    'id:uuid owner_id:uuid run_id:uuid attempt_id:uuid? tool_id:text args_hash:text decision:text approval_id:uuid? error_code:text? created_at:timestamptz invocation_id:uuid? request_id:text? record_kind:text outcome_kind:text?',
  schema_migrations: 'version:text applied_at:timestamptz',
  approval_revision_requests:
    'owner_id:uuid idempotency_key:uuid target_approval_id:uuid request_hash:text anchor_received_at_utc:timestamptz successor_approval_id:uuid?',
  tool_invocations:
    'invocation_id:uuid owner_id:uuid conversation_id:uuid run_id:uuid call_key:text first_attempt_id:uuid first_request_id:text tool_id:text args_hash:text args_bytes:integer execution_kind:text frozen_context:jsonb state:text outcome_kind:text? result_version:integer? accepted_result:jsonb? approval_id:uuid? accepted_attempt_id:uuid? accepted_request_id:text? accepted_at:timestamptz? evidence_ref:text? created_at:timestamptz',
  harness_resumes:
    'owner_id:uuid idempotency_key:uuid run_id:uuid checkpoint_id:uuid attempt_id:uuid created_at:timestamptz',
  harness_cancellations:
    'owner_id:uuid idempotency_key:uuid run_id:uuid reason:text created_at:timestamptz',
  document_approvals:
    'id:uuid owner_id:uuid conversation_id:uuid run_id:uuid workspace_id:text workspace_grant:jsonb relative_path:text base_read_invocation_id:uuid base_version:text exact_new_content:text new_version:text presentation_version:text presentation_hash:text preview:jsonb state:text apply_invocation_id:uuid? replaces_approval_id:uuid? created_at:timestamptz',
  document_approval_decisions:
    'owner_id:uuid idempotency_key:uuid target_approval_id:uuid action:text request_hash:text decision:text created_at:timestamptz',
};
const DEFAULTS = {
  users: {
    id: 'gen_random_uuid()',
    display_name: "''",
    status: "'active'",
    created_at: 'now()',
    updated_at: 'now()',
    metadata: "'{}'",
    email_verified: 'false',
  },
  sessions: { id: 'gen_random_uuid()', created_at: 'now()', client_info: "'{}'" },
  auth_accounts: {
    id: 'gen_random_uuid()',
    provider_id: "'credential'",
    created_at: 'now()',
    updated_at: 'now()',
  },
  conversations: { title: "''", status: "'open'", created_at: 'now()', updated_at: 'now()' },
  messages: { created_at: 'now()' },
  agent_runs: {
    status: "'running'",
    created_at: 'now()',
    execution: "'business'",
    tools_allowlist: "'[]'",
  },
  run_attempts: { status: "'running'", created_at: 'now()' },
  run_checkpoints: {
    payload: "'{}'",
    created_at: 'now()',
    event_seq: "nextval('run_checkpoints_event_seq_seq'::regclass)",
  },
  agent_revisions: { tools_allowlist: "'[]'", created_at: 'now()' },
  prompt_versions: { created_at: 'now()' },
  approvals: {
    fold: '0',
    occurrence: "'single'",
    state: "'pending'",
    created_at: 'now()',
    kind: "'create_task'",
  },
  tasks: {
    kind: "'notify_only'",
    fold: '0',
    occurrence: "'once'",
    state: "'saved'",
    state_version: '1',
    created_at: 'now()',
  },
  task_events: { recorded_at_utc: 'now()', evidence_ref: "'local'" },
  outbox: {
    attempt_no: '1',
    status: "'pending'",
    created_at: 'now()',
    updated_at: 'now()',
    ack_check_no: '0',
  },
  notifications: { channel: "'inapp'", status: "'pending'", created_at: 'now()' },
  security_events: { recorded_at_utc: 'now()', evidence_ref: "'local'" },
  conversation_idempotency: { created_at: 'now()' },
  tool_calls: { created_at: 'now()', record_kind: "'legacy'" },
  schema_migrations: { applied_at: 'now()' },
  approval_revision_requests: { anchor_received_at_utc: 'clock_timestamp()' },
  tool_invocations: { state: "'reserved'", created_at: 'now()' },
  harness_resumes: { created_at: 'now()' },
  harness_cancellations: { created_at: 'now()' },
  document_approvals: { state: "'pending'", created_at: 'clock_timestamp()' },
  document_approval_decisions: { created_at: 'clock_timestamp()' },
};
const PRIMARY = {
  task_leases: 'task_id',
  schema_migrations: 'version',
  tool_invocations: 'invocation_id',
  conversation_idempotency: 'owner_id,idempotency_key',
  approval_revision_requests: 'owner_id,idempotency_key',
  harness_resumes: 'owner_id,idempotency_key',
  harness_cancellations: 'owner_id,idempotency_key',
  document_approval_decisions: 'owner_id,idempotency_key',
};
const UNIQUE = {
  users: ['auth_email'],
  sessions: ['token_hash'],
  auth_accounts: ['provider_id,account_id'],
  messages: ['request_id'],
  run_attempts: ['run_id,attempt_no'],
  run_checkpoints: ['attempt_id,seq'],
  agent_revisions: ['name,revision'],
  prompt_versions: ['name,version'],
  approvals: ['consumed_task_id'],
  tasks: ['id,fire_at_utc', 'recreated_from_task_id'],
  outbox: ['idempotency_key'],
  notifications: ['idempotency_key'],
  approval_revision_requests: ['successor_approval_id'],
  tool_invocations: ['run_id,call_key'],
  harness_resumes: ['checkpoint_id', 'attempt_id'],
  document_approvals: ['apply_invocation_id', 'replaces_approval_id'],
};
// FK signatures include delete action. 'a' is PostgreSQL NO ACTION; 'r' is RESTRICT.
const FOREIGN = {
  sessions: ['user_id>users.id:r'],
  auth_accounts: ['user_id>users.id:r'],
  messages: ['conversation_id>conversations.id:r'],
  agent_runs: [
    'conversation_id>conversations.id:r',
    'input_message_id>messages.id:r',
    'waiting_checkpoint_id>run_checkpoints.id:r',
  ],
  run_attempts: ['run_id>agent_runs.id:r'],
  run_checkpoints: ['attempt_id>run_attempts.id:r'],
  approvals: ['target_task_id>tasks.id:r'],
  task_events: ['task_id>tasks.id:r'],
  outbox: ['task_id>tasks.id:r'],
  notifications: ['task_id>tasks.id:r'],
  task_leases: ['task_id>tasks.id:r'],
  conversation_idempotency: [
    'owner_id>users.id:a',
    'conversation_id>conversations.id:r',
    'run_id>agent_runs.id:r',
    'user_message_id>messages.id:r',
  ],
  tool_calls: [
    'owner_id>users.id:a',
    'run_id>agent_runs.id:r',
    'attempt_id>run_attempts.id:r',
    'approval_id>approvals.id:r',
    'invocation_id>tool_invocations.invocation_id:r',
  ],
  approval_revision_requests: [
    'target_approval_id>approvals.id:r',
    'successor_approval_id>approvals.id:r',
  ],
  harness_resumes: [
    'run_id>agent_runs.id:r',
    'checkpoint_id>run_checkpoints.id:r',
    'attempt_id>run_attempts.id:r',
  ],
  harness_cancellations: ['run_id>agent_runs.id:r'],
  document_approvals: ['replaces_approval_id>document_approvals.id:r'],
  document_approval_decisions: ['target_approval_id>document_approvals.id:r'],
};
const INDEXES = {
  users: [
    'users_auth_subject_uniq|unique|auth_provider,auth_subject|auth_provider IS NOT NULL AND auth_subject IS NOT NULL',
    'users_status_idx||status',
    'users_created_at_idx||created_at DESC',
  ],
  sessions: [
    'sessions_user_created_idx||user_id,created_at DESC',
    'sessions_expires_at_idx||expires_at',
  ],
  auth_accounts: ['auth_accounts_user_idx||user_id'],
  conversations: [
    'conversations_owner_created_idx||owner_id,created_at DESC',
    'conversations_owner_status_idx||owner_id,status',
  ],
  messages: [
    'messages_conversation_created_idx||conversation_id,created_at',
    'messages_owner_created_idx||owner_id,created_at DESC',
  ],
  agent_runs: [
    'agent_runs_conversation_created_idx||conversation_id,created_at',
    'agent_runs_owner_status_idx||owner_id,status',
  ],
  run_attempts: ['run_attempts_run_created_idx||run_id,created_at'],
  run_checkpoints: [
    'run_checkpoints_event_seq_uniq|unique|event_seq',
    'run_checkpoints_attempt_event_seq_idx||attempt_id,event_seq',
  ],
  approvals: [
    'approvals_owner_state_idx||owner_id,state',
    'approvals_expires_at_idx||expires_at',
    'approvals_owner_kind_idx||owner_id,kind',
    'approvals_supersedes_approval_id_uniq|unique|supersedes_approval_id|supersedes_approval_id IS NOT NULL',
  ],
  tasks: [
    'tasks_owner_state_idx||owner_id,state',
    'tasks_fire_at_utc_idx||fire_at_utc',
    'tasks_owner_fire_at_idx||owner_id,fire_at_utc',
  ],
  task_events: [
    'task_events_task_version_idx||task_id,state_version',
    'task_events_owner_recorded_idx||owner_id,recorded_at_utc DESC',
  ],
  outbox: [
    'outbox_status_created_idx||status,created_at',
    'outbox_task_idx||task_id',
    'outbox_dispatch_idx||status,last_attempt_at',
  ],
  notifications: [
    'notifications_owner_created_idx||owner_id,created_at DESC',
    'notifications_task_idx||task_id',
  ],
  conversation_idempotency: ['conversation_idempotency_expires_at_idx||expires_at'],
  tool_calls: [
    'tool_calls_run_created_idx||run_id,created_at',
    'tool_calls_invocation_created_idx||invocation_id,created_at',
  ],
  tool_invocations: ['tool_invocations_owner_run_created_idx||owner_id,run_id,created_at'],
  document_approvals: ['document_approvals_owner_run||owner_id,run_id'],
};
const TRIGGERS = [
  ['users', 'users_no_delete', 11, 'users_reject_delete'],
  ...['agent_revisions', 'prompt_versions', 'run_checkpoints', 'task_events', 'tool_calls'].map(
    (t) => [t, `${t}_no_update_delete`, 27, `${t}_reject_mutation`],
  ),
  [
    'tool_invocations',
    'tool_invocations_no_illegal_mutation',
    27,
    'tool_invocations_guard_mutation',
  ],
  ['agent_runs', 'agent_runs_frozen_runtime', 19, 'agent_runs_guard_frozen_runtime'],
  ['run_checkpoints', 'run_checkpoints_cursor', 7, 'run_checkpoints_serialize_cursor'],
  ['harness_resumes', 'harness_resumes_no_update_delete', 27, 'run_checkpoints_reject_mutation'],
  [
    'harness_cancellations',
    'harness_cancellations_no_update_delete',
    27,
    'run_checkpoints_reject_mutation',
  ],
  ['document_approvals', 'document_approvals_immutable', 27, 'document_approvals_guard_mutation'],
  [
    'document_approvals',
    'document_approvals_predecessor',
    7,
    'document_approvals_guard_predecessor',
  ],
  [
    'document_approval_decisions',
    'document_approval_decisions_append_only',
    27,
    'run_checkpoints_reject_mutation',
  ],
];

// Only baseline defaults, index keys and simple AND/IS NOT NULL predicates use
// this normalization. CHECK contracts are compared as exact PG16 catalog text.
function expression(value) {
  return value
    .replace(/::(?:text|integer|smallint|bigint|jsonb|boolean)(?:\[\])?/g, '')
    .replace(/\s+/g, '')
    .replace(/[()]/g, '')
    .toLowerCase();
}

export class DeploymentDatabase {
  #client;
  #lost = false;
  #lease = false;
  #migrations;
  #baselineChecks;
  #connected = false;
  constructor({
    connectionString,
    migrationsDirectory = path.join(ROOT, 'infra/migrations'),
    verificationDirectory = path.join(ROOT, 'scripts/local/baselines'),
  }) {
    // Reject libpq ambient defaults, URL-provided options, and multi-host routing.
    // All connection identity must come from the explicit private configuration.
    let url;
    try {
      url = new URL(connectionString);
    } catch {
      fail('connection_input_invalid');
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !url.pathname.slice(1) ||
      url.search ||
      url.hash
    )
      fail('connection_input_invalid');
    let identity;
    try {
      identity = {
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
      };
    } catch {
      fail('connection_input_invalid');
    }
    this.migrationsDirectory = path.resolve(migrationsDirectory);
    this.verificationDirectory = path.resolve(verificationDirectory);
    this.#client = new pg.Client({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 5432),
      ...identity,
      ssl: false,
      application_name: 'along-local-lifecycle',
      connectionTimeoutMillis: 5000,
      options: '-c search_path=public,pg_catalog',
      replication: 'false',
      client_encoding: 'UTF8',
      query_timeout: 60000,
      keepAlive: true,
    });
    this.#client.on('error', () => {
      this.#lost = true;
      this.#lease = false;
    });
    this.#client.on('end', () => {
      this.#lost = true;
      this.#lease = false;
    });
  }
  get targetVersion() {
    return this.#migrations?.at(-1)?.version ?? BASELINE;
  }
  async connect() {
    if (this.#connected || this.#lost) fail('connection_state_invalid');
    try {
      await this.#client.connect();
      this.#connected = true;
      const result = await this.#client.query(
        "SELECT current_setting('server_version_num')::int AS version",
      );
      if (result.rows[0].version < 160000 || result.rows[0].version >= 170000)
        fail('postgres_16_required');
      await this.#client.query('SET search_path TO public, pg_catalog');
      await this.#loadMigrations();
    } catch (error) {
      await this.close();
      if (error instanceof DeploymentDatabaseError) throw error;
      fail('connection_failed');
    }
  }
  async close() {
    this.#lease = false;
    this.#connected = false;
    this.#lost = true;
    try {
      await this.#client.end();
    } catch {
      /* Errors cannot reveal connection material. */
    }
  }
  async #query(sql, values) {
    if (!this.#connected || this.#lost) fail('connection_lost');
    try {
      return await this.#client.query(sql, values);
    } catch (error) {
      if (
        this.#lost ||
        /^08/.test(error.code ?? '') ||
        [
          '57P01',
          '57P02',
          '57P03',
          'ECONNRESET',
          'EPIPE',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
        ].includes(error.code) ||
        error.message === 'Query read timeout'
      ) {
        this.#lost = true;
        this.#lease = false;
        fail('connection_lost');
      }
      fail('database_operation_failed');
    }
  }
  async acquireLease() {
    if (this.#lease) return this.assertLease();
    const result = await this.#query(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
      LEASE,
    );
    if (!result.rows[0].acquired) fail('deployment_busy');
    this.#lease = true;
    await this.assertLease();
  }
  async assertLease() {
    if (!this.#lease || this.#lost) fail('deployment_lease_lost');
    const result = await this.#query(
      `SELECT EXISTS (SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted) AS held`,
      LEASE,
    );
    if (!result.rows[0].held) {
      this.#lease = false;
      fail('deployment_lease_lost');
    }
  }
  async assertNoOtherClients() {
    await this.assertLease();
    const result = await this.#query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend') AS present`);
    if (result.rows[0].present) fail('unmanaged_database_clients');
    await this.assertLease();
  }
  async #loadMigrations() {
    try {
      const entries = (await readdir(this.migrationsDirectory))
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && !name.endsWith('.verify.sql'))
        .sort();
      const migrations = [];
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i],
          version = name.slice(0, 4);
        if (Number(version) !== i + 1) fail('migration_inventory_invalid');
        const sql = await readFile(path.join(this.migrationsDirectory, name), 'utf8');
        let verify = null;
        if (version > BASELINE) {
          try {
            verify = JSON.parse(
              await readFile(
                path.join(this.verificationDirectory, `${version}-checks.json`),
                'utf8',
              ),
            );
            if (
              verify.version !== version ||
              !Array.isArray(verify.tables) ||
              !Array.isArray(verify.columns) ||
              !Array.isArray(verify.constraints) ||
              (verify.additional_checks !== undefined && !Array.isArray(verify.additional_checks))
            )
              fail('migration_inventory_invalid');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            // Existing isolated upgrade fixtures and future SQL verifiers remain supported.
            verify = await readFile(
              path.join(this.verificationDirectory, `${version}.sql`),
              'utf8',
            );
          }
        }
        // Migration files own one explicit transaction. No rewriting of old SQL.
        const withoutComments = sql.replace(/--[^\n]*/g, '').trim();
        if (!/^BEGIN\s*;/i.test(withoutComments) || !/COMMIT\s*;\s*$/i.test(withoutComments))
          fail('migration_transaction_required');
        migrations.push({ version, sql, verify });
      }
      if (migrations.length < 16) fail('migration_inventory_invalid');
      this.#baselineChecks = JSON.parse(
        await readFile(path.join(ROOT, 'scripts/local/baselines/0016-checks.json'), 'utf8'),
      );
      this.#migrations = migrations;
    } catch (error) {
      if (error instanceof DeploymentDatabaseError) throw error;
      fail('migration_inventory_unavailable');
    }
  }
  async #readOnly(callback) {
    await this.assertLease();
    await this.#query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await callback();
      await this.#query('COMMIT');
      await this.assertLease();
      return result;
    } catch (error) {
      if (!this.#lost) {
        try {
          await this.#query('ROLLBACK');
        } catch {
          /* Preserve the safe error. */
        }
      }
      throw error;
    }
  }
  async classify() {
    return this.#readOnly(async () => {
      // An empty application database has no user objects in any non-system schema.
      // Unknown objects are never treated as an invitation to initialize.
      const objects = await this.#query(`SELECT count(*)::int AS count FROM (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'
        UNION ALL SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
        UNION ALL SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
      ) AS objects`);
      if (objects.rows[0].count === 0)
        return { kind: 'empty', version: null, reason: 'empty_application_database' };
      const unknown = (reason, version = null) => ({ kind: 'unknown', version, reason });
      const ledger = await this.#query(`SELECT c.relkind,a.atttypid='text'::regtype AS text_version
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='version' AND NOT a.attisdropped
        WHERE n.nspname='public' AND c.relname='schema_migrations'`);
      if (!ledger.rows.length) return unknown('migration_ledger_missing');
      if (ledger.rows[0].relkind !== 'r' || !ledger.rows[0].text_version)
        return unknown('migration_ledger_invalid');
      const versions = (
        await this.#query('SELECT version FROM public.schema_migrations ORDER BY version')
      ).rows.map((r) => r.version);
      if (versions.some((v) => typeof v !== 'string' || !/^\d{4}$/.test(v)))
        return unknown('migration_ledger_invalid');
      const last = versions.at(-1) ?? null;
      if (!versions.length || versions.some((v, i) => v !== String(12 + i).padStart(4, '0')))
        return unknown('migration_ledger_not_contiguous', last);
      if (last > this.targetVersion) return unknown('database_newer_than_artifacts', last);
      if (last < BASELINE) return unknown('unsupported_legacy_database', last);
      try {
        await this.#verifyBaseline(last);
        for (const migration of this.#migrations.filter((m) => m.version > last)) {
          if (typeof migration.verify !== 'object' || !migration.verify) continue;
          const pending = migration.verify;
          const present = await this.#query(
            `SELECT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname=ANY($1::text[])
            UNION ALL
            SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
              AND (c.relname || '.' || a.attname)=ANY($2::text[])
          ) AS present`,
            [pending.tables, pending.columns.map((c) => `${c.table}.${c.name}`)],
          );
          if (present.rows[0].present) fail('baseline_unstamped_migration_objects');
        }
        for (const migration of this.#migrations.filter(
          (m) => m.version > BASELINE && m.version <= last,
        ))
          await this.#verifyAdditional(migration.verify);
      } catch (error) {
        if (this.#lost) throw error;
        // Roll back an aborted verifier statement before returning the stable classification.
        await this.#query('ROLLBACK');
        await this.#query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const reason =
          error instanceof DeploymentDatabaseError && error.code.startsWith('baseline_')
            ? error.code
            : 'database_structure_mismatch';
        return unknown(reason, last);
      }
      return {
        kind: 'supported',
        version: last,
        reason:
          last === this.targetVersion ? 'target_schema_verified' : 'explicit_upgrade_required',
      };
    });
  }
  async #verifyAdditional(manifest) {
    if (typeof manifest === 'string') return this.#query(manifest);
    const tables = [...new Set(manifest.columns.map((c) => c.table))];
    const columns = (
      await this.#query(
        `SELECT c.relname AS table_name,a.attname AS name,t.typname AS type,
      a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS default_value,c.relkind,c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid AND t.typnamespace='pg_catalog'::regnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped`,
        [tables],
      )
    ).rows;
    for (const expected of manifest.columns) {
      const actual = columns.find(
        (c) => c.table_name === expected.table && c.name === expected.name,
      );
      if (
        !actual ||
        actual.type !== expected.type ||
        actual.required !== expected.required ||
        actual.relkind !== 'r' ||
        actual.relrowsecurity ||
        expression(actual.default_value ?? '') !== expression(expected.default)
      )
        fail('baseline_additional_columns_mismatch');
    }
    for (const table of manifest.tables) {
      if (
        columns.filter((c) => c.table_name === table).length !==
        manifest.columns.filter((c) => c.table === table).length
      )
        fail('baseline_additional_columns_mismatch');
    }
    const constraints = (
      await this.#query(
        `SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,
      k.convalidated AS valid,k.condeferrable AS deferred,k.confdeltype AS delete_action,ref.relname AS target,
      (ref.oid IS NULL OR ref.relnamespace='public'::regnamespace) AS target_public,
      (k.conindid=0 OR EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indexrelid=k.conindid AND ix.indisvalid AND ix.indisready)) AS index_valid,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos)
        JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.pos) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,pos)
        JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.pos) AS target_columns,
      pg_get_expr(k.conbin,k.conrelid) AS expression
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_class ref ON ref.oid=k.confrelid WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
        [[...new Set([...manifest.tables, ...manifest.constraints.map((c) => c.table)])]],
      )
    ).rows;
    if (
      constraints.filter((c) => manifest.tables.includes(c.table_name)).length !==
      manifest.constraints.filter((c) => manifest.tables.includes(c.table)).length
    )
      fail('baseline_additional_constraints_mismatch');
    for (const expected of manifest.constraints) {
      const actual = constraints.find(
        (c) => c.table_name === expected.table && c.name === expected.name,
      );
      if (
        !actual ||
        !actual.valid ||
        actual.deferred ||
        !actual.index_valid ||
        !actual.target_public ||
        actual.type !== expected.type ||
        actual.columns.join(',') !== expected.columns.join(',') ||
        (expected.expression !== undefined && actual.expression !== expected.expression) ||
        (expected.target !== undefined &&
          (actual.target !== expected.target ||
            actual.target_columns.join(',') !== expected.target_columns.join(',') ||
            actual.delete_action !== expected.delete_action))
      )
        fail('baseline_additional_constraints_mismatch');
    }
    // Incremental immutable-policy guards use the same source-body comparison
    // as the fixed baseline triggers. Classification remains entirely read-only.
    const source = this.#migrations.map((migration) => migration.sql).join('\n');
    for (const expected of manifest.functions ?? []) {
      const actual = (
        await this.#query(
          `SELECT p.prosrc AS body,p.provolatile AS volatility,p.proisstrict AS strict,
         p.prosecdef AS security_definer,p.proconfig AS config,l.lanname AS language,
         p.prorettype::regtype::text AS result
         FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
         WHERE p.oid=to_regprocedure($1)`,
          [`public.${expected.name}(${expected.arguments})`],
        )
      ).rows[0];
      const escaped = expected.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = source.match(
        new RegExp(
          `CREATE FUNCTION ${escaped}\\s*\\([^)]*\\)[\\s\\S]*?AS \\$([a-z_]*)\\$([\\s\\S]*?)\\$\\1\\$;`,
          'i',
        ),
      )?.[2];
      if (
        !actual ||
        !body ||
        actual.body.replaceAll('\r\n', '\n').trim() !== body.replaceAll('\r\n', '\n').trim() ||
        actual.volatility !== expected.volatility ||
        actual.strict !== expected.strict ||
        actual.result !== expected.result ||
        actual.language !== 'plpgsql' ||
        actual.security_definer ||
        actual.config !== null
      )
        fail('baseline_additional_functions_mismatch');
    }
    for (const expected of manifest.triggers ?? []) {
      const actual = (
        await this.#query(
          `SELECT t.tgtype AS type,t.tgenabled AS enabled,t.tgqual IS NULL AS unconditional,
         t.tgnargs AS arguments,p.proname AS function_name,nf.nspname AS function_schema,
         ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(num,pos)
           JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num ORDER BY x.pos) AS columns
         FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace nf ON nf.oid=p.pronamespace
         WHERE n.nspname='public' AND c.relname=$1 AND t.tgname=$2 AND NOT t.tgisinternal`,
          [expected.table, expected.name],
        )
      ).rows[0];
      if (
        !actual ||
        actual.type !== expected.type ||
        actual.enabled !== 'O' ||
        !actual.unconditional ||
        actual.arguments !== 0 ||
        actual.function_name !== expected.function ||
        actual.columns.join(',') !== (expected.columns ?? []).join(',') ||
        actual.function_schema !== 'public'
      )
        fail('baseline_additional_triggers_mismatch');
    }
    for (const expected of manifest.indexes ?? []) {
      const actual = (
        await this.#query(
          `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
          am.amname AS method,pg_get_expr(i.indpred,i.indrelid) AS predicate,
          ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true)
            FROM generate_series(1,i.indnkeyatts) n) AS keys
          FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=c.relam
          WHERE c.relnamespace='public'::regnamespace AND c.relname=$1 AND t.relname=$2`,
          [expected.name, expected.table],
        )
      ).rows[0];
      if (
        !actual ||
        !actual.valid ||
        !actual.ready ||
        actual.unique !== expected.unique ||
        actual.method !== expected.method ||
        actual.keys.join(',') !== expected.keys.join(',') ||
        actual.predicate !== expected.predicate
      )
        fail('baseline_additional_indexes_mismatch');
    }
  }
  async #verifyBaseline(version) {
    const columns = (
      await this.#query(`SELECT c.relname AS table_name,a.attname AS name,t.typname AS type,a.attnotnull AS required,
      pg_get_expr(d.adbin,d.adrelid) AS default_value,c.relkind,c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      JOIN pg_type t ON t.oid=a.atttypid AND t.typnamespace='pg_catalog'::regnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped`)
    ).rows;
    const types = { integer: 'int4', smallint: 'int2', bigint: 'int8', boolean: 'bool' };
    for (const [table, spec] of Object.entries(TABLES)) {
      for (const token of spec.split(' ')) {
        const [name, rawType] = token.split(':');
        const nullable =
            rawType.endsWith('?') ||
            (version >= '0024' && table === 'tasks' && name === 'tzdb_version') ||
            (version >= '0025' && table === 'approvals' && name === 'tzdb_version'),
          type = rawType.replace(/\?$/, '');
        const actual = columns.find((c) => c.table_name === table && c.name === name);
        if (
          !actual ||
          actual.type !== (types[type] ?? type) ||
          actual.required === nullable ||
          actual.relkind !== 'r' ||
          actual.relrowsecurity
        )
          fail('baseline_columns_mismatch');
        const expectedDefault = DEFAULTS[table]?.[name] ?? '';
        if (expression(actual.default_value ?? '') !== expression(expectedDefault))
          fail('baseline_defaults_mismatch');
      }
    }
    const constraints = (
      await this.#query(`SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,k.convalidated AS valid,
      k.condeferrable AS deferred,k.confdeltype AS delete_action,ref.relname AS target,
      (ref.oid IS NULL OR ref.relnamespace='public'::regnamespace) AS target_public,
      (k.conindid=0 OR EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indexrelid=k.conindid AND ix.indisvalid AND ix.indisready)) AS index_valid,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.pos) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,pos) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.pos) AS target_columns,
      pg_get_expr(k.conbin,k.conrelid) AS expression
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_class ref ON ref.oid=k.confrelid WHERE n.nspname='public'`)
    ).rows;
    for (const table of Object.keys(TABLES)) {
      const actual = constraints.filter((c) => c.table_name === table);
      if (actual.some((c) => !c.valid || c.deferred || !c.index_valid || !c.target_public))
        fail('baseline_constraints_mismatch');
      if (!actual.some((c) => c.type === 'p' && c.columns.join(',') === (PRIMARY[table] ?? 'id')))
        fail('baseline_primary_key_missing');
      for (const key of UNIQUE[table] ?? [])
        if (!actual.some((c) => c.type === 'u' && c.columns.join(',') === key))
          fail('baseline_unique_missing');
      const foreign = actual
        .filter((c) => c.type === 'f')
        .map(
          (c) =>
            `${c.columns.join(',')}>${c.target}.${c.target_columns.join(',')}:${c.delete_action}`,
        )
        .sort();
      const additions = this.#migrations
        .filter((m) => m.version <= version && m.verify !== null && typeof m.verify === 'object')
        .flatMap((m) => m.verify.constraints ?? [])
        .filter((c) => c.table === table && c.type === 'f')
        .map(
          (c) =>
            `${c.columns.join(',')}>${c.target}.${c.target_columns.join(',')}:${c.delete_action}`,
        );
      if (foreign.join('|') !== [...(FOREIGN[table] ?? []), ...additions].sort().join('|'))
        fail('baseline_foreign_keys_mismatch');
    }
    // Captured from an isolated PG16 database after the unchanged 0001–0016
    // migrations. Preserve constraint identity and all Boolean grouping/casts.
    const actualChecks = constraints.filter((c) => c.type === 'c' && TABLES[c.table_name]);
    const expectedChecks = new Map(
      this.#baselineChecks.map((check) => [`${check.table}.${check.name}`, check]),
    );
    for (const migration of this.#migrations.filter((item) => item.version <= version)) {
      if (typeof migration.verify !== 'object' || migration.verify === null) continue;
      for (const check of migration.verify.baseline_checks ?? []) {
        const key = `${check.table}.${check.name}`;
        if (!expectedChecks.has(key)) fail('migration_inventory_invalid');
        expectedChecks.set(key, check);
      }
      for (const check of migration.verify.additional_checks ?? []) {
        const key = `${check.table}.${check.name}`;
        if (!TABLES[check.table] || expectedChecks.has(key)) fail('migration_inventory_invalid');
        expectedChecks.set(key, check);
      }
    }
    if (
      actualChecks.length !== expectedChecks.size ||
      [...expectedChecks.values()].some(
        (expected) =>
          !actualChecks.some(
            (actual) =>
              actual.table_name === expected.table &&
              actual.name === expected.name &&
              actual.expression === expected.expression,
          ),
      )
    )
      fail('baseline_checks_mismatch');
    const indexes = (
      await this.#query(`SELECT t.relname AS table_name,c.relname AS name,i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
      am.amname AS method,pg_get_expr(i.indpred,i.indrelid) AS predicate,
      -- Column-mode pg_get_indexdef omits ordering. indoption is zero-based:
      -- bit 0 is DESC; bit 1 is NULLS FIRST. Preserve nondefault NULL ordering.
      ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true)
        || CASE WHEN (i.indoption[n-1] & 1)=1 THEN ' DESC' ELSE '' END
        || CASE WHEN (i.indoption[n-1] & 1)=1 AND (i.indoption[n-1] & 2)=0 THEN ' NULLS LAST'
                WHEN (i.indoption[n-1] & 1)=0 AND (i.indoption[n-1] & 2)=2 THEN ' NULLS FIRST' ELSE '' END
        FROM generate_series(1,i.indnkeyatts) n) AS keys
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace ns ON ns.oid=t.relnamespace JOIN pg_am am ON am.oid=c.relam WHERE ns.nspname='public'`)
    ).rows;
    for (const [table, specs] of Object.entries(INDEXES))
      for (const spec of specs) {
        const [name, unique, keys, predicate = ''] = spec.split('|');
        const actual = indexes.find((i) => i.table_name === table && i.name === name);
        if (
          !actual ||
          !actual.valid ||
          !actual.ready ||
          actual.method !== 'btree' ||
          actual.unique !== Boolean(unique) ||
          expression(actual.keys.join(',')) !== expression(keys) ||
          expression(actual.predicate ?? '') !== expression(predicate)
        )
          fail('baseline_indexes_mismatch');
      }
    const triggers = (
      await this.#query(`SELECT c.relname AS table_name,t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,
      t.tgqual IS NULL AS unconditional,t.tgnargs AS arguments,p.proname AS function_name,p.prosrc AS body,p.prosecdef AS security_definer,
      p.proconfig AS config,nf.nspname AS function_schema,l.lanname AS language
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace nf ON nf.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname='public' AND NOT t.tgisinternal`)
    ).rows;
    const source = this.#migrations.map((m) => m.sql).join('\n');
    for (const [table, name, type, fn] of TRIGGERS) {
      const actual = triggers.find((t) => t.table_name === table && t.name === name);
      const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = source.match(
        new RegExp(
          `CREATE(?: OR REPLACE)? FUNCTION ${escaped}\\s*\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
          'i',
        ),
      )?.[1];
      if (
        !actual ||
        actual.type !== type ||
        actual.enabled !== 'O' ||
        !actual.unconditional ||
        actual.arguments !== 0 ||
        actual.function_name !== fn ||
        actual.function_schema !== 'public' ||
        actual.language !== 'plpgsql' ||
        actual.security_definer ||
        actual.config !== null ||
        !body ||
        // Migration checkout line endings are representation, not guard changes.
        // Preserve every other character and all function/trigger attributes above.
        actual.body.replaceAll('\r\n', '\n').trim() !== body.replaceAll('\r\n', '\n').trim()
      )
        fail('baseline_triggers_mismatch');
    }
    const sequence =
      await this.#query(`SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_sequence s ON s.seqrelid=c.oid JOIN pg_depend d ON d.objid=c.oid AND d.deptype='a'
      JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE n.nspname='public' AND c.relname='run_checkpoints_event_seq_seq' AND s.seqtypid='bigint'::regtype
      AND t.relname='run_checkpoints' AND a.attname='event_seq') AS present`);
    if (!sequence.rows[0].present) fail('baseline_sequence_missing');
    for (const name of [
      'verify-identity.sql',
      'verify-conversation.sql',
      'verify-constraints.sql',
      'verify-agent-support.sql',
    ]) {
      const sql = (await readFile(path.join(ROOT, 'scripts/db', name), 'utf8')).replace(
        /^\\.*$/gm,
        '',
      );
      await this.#query(sql);
    }
  }
  async initialize() {
    const state = await this.classify();
    if (state.kind === 'supported' && state.version === this.targetVersion) return state;
    if (state.kind !== 'empty')
      fail(state.kind === 'supported' ? 'explicit_upgrade_required' : 'unknown_database_refused');
    for (const migration of this.#migrations) await this.#apply(migration);
    const result = await this.classify();
    if (result.kind === 'unknown') fail(result.reason);
    if (result.kind !== 'supported' || result.version !== this.targetVersion)
      fail('initialized_schema_not_verified');
    return result;
  }
  async upgrade() {
    const state = await this.classify();
    if (state.kind !== 'supported') fail('unsupported_upgrade_source');
    for (const migration of this.#migrations.filter((m) => m.version > state.version)) {
      await this.#apply(migration);
      const result = await this.classify();
      if (result.kind !== 'supported' || result.version !== migration.version)
        fail('committed_migration_not_verified');
    }
    return this.classify();
  }
  async #apply(migration) {
    await this.assertLease();
    try {
      await this.#query(migration.sql);
      await this.assertLease();
      if (migration.version >= '0012') {
        const rows = (
          await this.#query('SELECT version FROM public.schema_migrations WHERE version=$1', [
            migration.version,
          ])
        ).rows;
        if (rows.length !== 1) fail('migration_ledger_not_committed');
      }
    } catch {
      if (!this.#lost) {
        try {
          await this.#query('ROLLBACK');
        } catch {
          /* Preserve committed facts; never retry implicitly. */
        }
      }
      if (this.#lost) fail('migration_connection_lost_reconcile_before_retry');
      fail('migration_failed_reconcile_before_retry');
    }
  }
}
