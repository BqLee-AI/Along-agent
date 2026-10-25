import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { databaseUrl } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const migrations = new URL('../../../../infra/migrations/', import.meta.url);
const authorityMigration = new URL('0015_cangjie_harness_authority.sql', migrations);
interface LegacyDatabase {
  pool: Pool;
  close(): Promise<void>;
}

async function legacyDatabase(): Promise<LegacyDatabase> {
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  const schema = `integration_${randomUUID().replaceAll('-', '')}`;
  const management = new Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl);
  const options = url.searchParams.getAll('options').join(' ');
  url.searchParams.set(
    'options',
    `${options ? `${options} ` : ''}-csearch_path=${schema},pg_catalog`,
  );
  const pool = new Pool({ connectionString: url.toString(), max: 3 });
  try {
    await management.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      for (const filename of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql') && name < '0015')
        .sort()) {
        await client.query(await readFile(new URL(filename, migrations), 'utf8'));
      }
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end();
    try {
      await management.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await management.end();
    }
    throw error;
  }
  return {
    pool,
    close: async () => {
      await pool.end();
      try {
        await management.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await management.end();
      }
    },
  };
}

async function seedLegacy(pool: Pool) {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID(),
    attemptId = randomUUID(),
    checkpointId = randomUUID();
  await pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
    ownerId,
    `${ownerId}@along.test`,
  ]);
  await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens)
    VALUES($1,$2,$3,'assistant/r1','chat','done',10,8000)`,
    [runId, ownerId, conversationId],
  );
  await pool.query(
    "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')",
    [attemptId, ownerId, runId],
  );
  await pool.query(
    `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
    VALUES($1,$2,$3,1,'thread.completed',$4::jsonb,'thread/v1')`,
    [
      checkpointId,
      ownerId,
      attemptId,
      JSON.stringify({
        type: 'thread.completed',
        payload: { conversation_id: conversationId, run_id: runId, approval_id: null },
        request_id: randomUUID(),
      }),
    ],
  );
  return { ownerId, conversationId, runId, attemptId, checkpointId };
}

maybe('0015 harness authority forward-only migration', () => {
  it('upgrades actual 0014 business history without fabricated snapshots and preserves append-only/frozen authority', async () => {
    const database = await legacyDatabase();
    try {
      const legacy = await seedLegacy(database.pool);
      const before = (
        await database.pool.query('SELECT * FROM run_checkpoints WHERE id=$1', [
          legacy.checkpointId,
        ])
      ).rows[0];
      const sql = await readFile(authorityMigration, 'utf8');
      await database.pool.query(sql);
      await database.pool.query(sql);
      expect(
        (await database.pool.query("SELECT version FROM schema_migrations WHERE version='0015'"))
          .rows,
      ).toEqual([{ version: '0015' }]);
      expect(
        (
          await database.pool.query(
            `SELECT execution,status,tools_allowlist,frozen_context,input_message_id,
        waiting_checkpoint_id,waiting_invocation_id,waiting_approval_id FROM agent_runs WHERE id=$1`,
            [legacy.runId],
          )
        ).rows,
      ).toEqual([
        {
          execution: 'business',
          status: 'done',
          tools_allowlist: [],
          frozen_context: null,
          input_message_id: null,
          waiting_checkpoint_id: null,
          waiting_invocation_id: null,
          waiting_approval_id: null,
        },
      ]);
      expect(
        (
          await database.pool.query('SELECT * FROM run_checkpoints WHERE id=$1', [
            legacy.checkpointId,
          ])
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM run_checkpoints WHERE kind='harness_snapshot'",
          )
        ).rows[0]?.n,
      ).toBe(0);
      await expect(
        database.pool.query("UPDATE agent_runs SET execution='harness' WHERE id=$1", [
          legacy.runId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.pool.query('DELETE FROM run_checkpoints WHERE id=$1', [legacy.checkpointId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.pool.query("UPDATE run_checkpoints SET payload='{}' WHERE id=$1", [
          legacy.checkpointId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await database.close();
    }
  });

  it('DDL failure rolls back the entire new boundary and leaves legacy facts intact for a clean retry', async () => {
    const database = await legacyDatabase();
    try {
      const legacy = await seedLegacy(database.pool);
      await database.pool.query('CREATE TABLE harness_resumes(fixture integer)');
      const client = await database.pool.connect();
      const sql = await readFile(authorityMigration, 'utf8');
      try {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42P07' });
        await client.query('ROLLBACK');
        expect(
          (await client.query("SELECT version FROM schema_migrations WHERE version='0015'")).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='agent_runs' AND column_name='execution'`)
          ).rows,
        ).toEqual([]);
        expect(
          (await client.query('SELECT status FROM agent_runs WHERE id=$1', [legacy.runId])).rows,
        ).toEqual([{ status: 'done' }]);
        await client.query('DROP TABLE harness_resumes');
        await client.query(sql);
        expect(
          (await client.query('SELECT execution FROM agent_runs WHERE id=$1', [legacy.runId])).rows,
        ).toEqual([{ execution: 'business' }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await database.close();
    }
  });
});
