import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DeploymentDatabase } from '../local/database.mjs';
import { copyMigrationsThrough } from './fixtures/migrations.js';

const connectionString = process.env.DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;

databaseTests('0042 personal Bot cutover against isolated PG16', () => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  let directory: string;
  let cleanup: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'along-pre-bot-'));
    await copyMigrationsThrough(directory, '0041');
    cleanup = await readFile(
      new URL('../local/clean-disposable-bot-cutover.sql', import.meta.url),
      'utf8',
    );
  });
  afterAll(async () => {
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function deployment(
    url: string,
    action: (database: DeploymentDatabase) => Promise<void>,
    migrationsDirectory?: string,
  ) {
    const database = new DeploymentDatabase({ connectionString: url, migrationsDirectory });
    try {
      await database.connect();
      await database.acquireLease();
      await action(database);
    } finally {
      await database.close();
    }
  }

  it('refuses untreated history, preserves retained sources and cleans only selected terminal facts', async () => {
    const name = `along_bot_cutover_${randomUUID().replaceAll('-', '')}`;
    const connection = new URL(connectionString!);
    connection.pathname = `/${name}`;
    connection.search = '';
    const url = connection.toString();
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      await deployment(
        url,
        async (database) => {
          expect((await database.initialize()).version).toBe('0041');
        },
        directory,
      );
      const owner = randomUUID();
      const selected = randomUUID();
      const retained = randomUUID();
      const run = randomUUID();
      const attempt = randomUUID();
      const checkpoint = randomUUID();
      const invocation = randomUUID();
      const message = randomUUID();
      const selectedApproval = randomUUID();
      const retainedApproval = randomUUID();
      const task = randomUUID();
      const event = randomUUID();
      const retainedSource = randomUUID();
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query('INSERT INTO users (id,auth_email) VALUES ($1,$2)', [
          owner,
          `${owner}@fixture.test`,
        ]);
        await client.query('INSERT INTO conversations (id,owner_id) VALUES ($1,$3),($2,$3)', [
          selected,
          retained,
          owner,
        ]);
        await client.query(
          `INSERT INTO agent_runs (id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,ended_at)
          VALUES ($1,$2,$3,'historical','chat','done',2,100,now())`,
          [run, owner, selected],
        );
        await client.query(
          `INSERT INTO run_attempts (id,owner_id,run_id,attempt_no,status,ended_at)
          VALUES ($1,$2,$3,1,'done',now())`,
          [attempt, owner, run],
        );
        await client.query(
          `INSERT INTO run_checkpoints (id,owner_id,attempt_id,seq,kind,stream_protocol_version)
          VALUES ($1,$2,$3,1,'thread.started','1')`,
          [checkpoint, owner, attempt],
        );
        await client.query(
          `INSERT INTO messages (id,owner_id,conversation_id,role,content,source_run_id)
          VALUES ($1,$2,$3,'assistant','disposable response',$4)`,
          [message, owner, selected, run],
        );
        await client.query(
          `INSERT INTO approvals (id,owner_id,conversation_id,fire_at_utc,wall_time,timezone_id,
          resolved_utc_offset_seconds,tzdb_version,presentation_hash,presentation_version,state,expires_at)
          VALUES ($1,$3,$4,'2030-01-01Z','2030-01-01 00:00','UTC',0,'fixture','approved-text','v1','rejected',now()),
                 ($2,$3,NULL,'2030-01-01Z','2030-01-01 00:00','UTC',0,'fixture','approved-text','v1','consumed',now())`,
          [selectedApproval, retainedApproval, owner, selected],
        );
        await client.query(
          `INSERT INTO tool_invocations (invocation_id,owner_id,conversation_id,run_id,call_key,
          first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context,state,
          outcome_kind,result_version,accepted_result,approval_id,accepted_attempt_id,accepted_request_id,accepted_at)
          VALUES ($1,$2,$3,$4,'fixture',$5,'fixture','propose_task',repeat('a',64),2,'local','{}','completed',
                  'approval_pending',1,'{}',$6,$5,'fixture',now())`,
          [invocation, owner, selected, run, attempt, selectedApproval],
        );
        await client.query(
          `INSERT INTO tasks (id,owner_id,source_approval_id,fire_at_utc,wall_time,timezone_id,
          resolved_utc_offset_seconds,tzdb_version) VALUES ($1,$2,$3,'2030-01-01Z','2030-01-01 00:00','UTC',0,'fixture')`,
          [task, owner, retainedApproval],
        );
        await client.query(
          `INSERT INTO task_events (id,owner_id,task_id,state_version,type,evidence_ref)
          VALUES ($1,$2,$3,1,'created',$4)`,
          [event, owner, task, retainedSource],
        );
        await client.query(
          `INSERT INTO security_events (id,owner_id,type,evidence_ref)
          VALUES (gen_random_uuid(),$1,'cancel_breach',$2)`,
          [owner, JSON.stringify({ source_message_id: message })],
        );
      } finally {
        await client.end();
      }

      await deployment(url, async (database) => {
        await expect(database.upgrade()).rejects.toMatchObject({
          code: 'migration_failed_reconcile_before_retry',
        });
        expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0041' });
      });

      const maintenance = new pg.Client({ connectionString: url });
      await maintenance.connect();
      try {
        const facts = `SELECT jsonb_build_object(
          'conversations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM conversations x),
          'runs',(SELECT jsonb_agg(to_jsonb(x)) FROM agent_runs x),
          'tasks',(SELECT jsonb_agg(to_jsonb(x)) FROM tasks x),
          'events',(SELECT jsonb_agg(to_jsonb(x)) FROM task_events x),
          'security',(SELECT jsonb_agg(to_jsonb(x)) FROM security_events x)) AS value`;
        const original = (await maintenance.query(facts)).rows[0].value;
        await maintenance.query("SELECT set_config('along.bot_cutover_ids',$1,false)", [selected]);
        await expect(maintenance.query(cleanup)).rejects.toThrow('retained table security_events');
        await maintenance.query('ROLLBACK');
        expect((await maintenance.query(facts)).rows[0].value).toEqual(original);

        // This fixture introduced the blocking reference deliberately. Put it
        // back to the independent provenance it would have in the clean case.
        await maintenance.query('UPDATE security_events SET evidence_ref=$1', [retainedSource]);
        await maintenance.query(cleanup);
        expect((await maintenance.query(facts)).rows[0].value).toMatchObject({
          conversations: [expect.objectContaining({ id: retained })],
          runs: null,
          tasks: original.tasks,
          events: original.events,
        });
        expect(
          (
            await maintenance.query(`SELECT
          (SELECT count(*)::int FROM run_attempts) AS attempts,
          (SELECT count(*)::int FROM run_checkpoints) AS checkpoints,
          (SELECT count(*)::int FROM tool_invocations) AS invocations,
          (SELECT count(*)::int FROM messages) AS messages,
          (SELECT array_agg(id) FROM approvals) AS approvals`)
          ).rows[0],
        ).toEqual({
          attempts: 0,
          checkpoints: 0,
          invocations: 0,
          messages: 0,
          approvals: [retainedApproval],
        });
        await maintenance.query("SELECT set_config('along.bot_cutover_ids',$1,false)", [retained]);
        await maintenance.query(cleanup);
      } finally {
        await maintenance.end();
      }

      await deployment(url, async (database) => {
        expect((await database.upgrade()).version).toBe('0043');
        expect((await database.initialize()).version).toBe('0043');
      });
      const drift = new pg.Client({ connectionString: url });
      await drift.connect();
      try {
        await drift.query(
          'ALTER TABLE conversations DISABLE TRIGGER conversations_personal_bot_immutable',
        );
      } finally {
        await drift.end();
      }
      await deployment(url, async (database) => {
        expect((await database.classify()).kind).toBe('unknown');
      });
    } finally {
      await admin.query(`DROP DATABASE "${name}"`);
    }
  }, 120000);
});
