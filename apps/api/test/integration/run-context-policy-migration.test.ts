import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { databaseUrl } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const migrations = new URL('../../../../infra/migrations/', import.meta.url);
const target = new URL('0019_conversation_context_policies.sql', migrations);

async function legacyDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  const schema = `integration_${randomUUID().replaceAll('-', '')}`;
  const management = new Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl),
    options = url.searchParams.getAll('options').join(' ');
  url.searchParams.set(
    'options',
    `${options ? `${options} ` : ''}-csearch_path=${schema},pg_catalog`,
  );
  const pool = new Pool({ connectionString: url.toString(), max: 2 });
  const close = async () => {
    await pool.end();
    try {
      await management.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await management.end();
    }
  };
  try {
    await management.query(`CREATE SCHEMA "${schema}"`);
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith('.sql') && name < '0019')
      .sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function seed(pool: Pool) {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    inputId = randomUUID(),
    runId = randomUUID();
  await pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
    ownerId,
    `${ownerId}@migration.test`,
  ]);
  await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await pool.query(
    `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','完整旧输入😀')`,
    [inputId, ownerId, conversationId],
  );
  await pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context,tools_allowlist)
    VALUES($1,$2,$3,'legacy/r1','chat','running',10,8000,'harness',$4,$5::jsonb,'["list_tasks"]')`,
    [
      runId,
      ownerId,
      conversationId,
      inputId,
      JSON.stringify({ messageRefs: [inputId], receivedAtUtc: '2026-10-01T00:00:00Z' }),
    ],
  );
  return { runId, inputId };
}

maybe('0019 immutable context policy forward-only migration', () => {
  it('upgrades actual 0018 facts without backfilling policies, changing frozen context or granting a tool', async () => {
    const database = await legacyDatabase();
    try {
      const { runId, inputId } = await seed(database.pool);
      const beforeRun = (await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId]))
        .rows[0];
      const beforeInput = (
        await database.pool.query('SELECT * FROM messages WHERE id=$1', [inputId])
      ).rows[0];
      const sql = await readFile(target, 'utf8');
      await database.pool.query(sql);
      await database.pool.query(sql);
      expect(
        (await database.pool.query("SELECT version FROM schema_migrations WHERE version='0019'"))
          .rows,
      ).toEqual([{ version: '0019' }]);
      expect((await database.pool.query('SELECT * FROM run_context_policies')).rows).toEqual([]);
      expect(
        (await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0],
      ).toEqual(beforeRun);
      expect(
        (await database.pool.query('SELECT * FROM messages WHERE id=$1', [inputId])).rows[0],
      ).toEqual(beforeInput);
    } finally {
      await database.close();
    }
  });

  it('DDL failure rolls back the policy validator, table and version stamp without touching old facts', async () => {
    const database = await legacyDatabase();
    try {
      const { runId } = await seed(database.pool);
      const before = (await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId]))
        .rows[0];
      await database.pool.query('CREATE TABLE run_context_policies(fixture integer)');
      const sql = await readFile(target, 'utf8'),
        client = await database.pool.connect();
      try {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42P07' });
        await client.query('ROLLBACK');
        expect(
          (await client.query("SELECT version FROM schema_migrations WHERE version='0019'")).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              "SELECT to_regprocedure('run_context_policy_valid(jsonb)') AS validator",
            )
          ).rows[0].validator,
        ).toBeNull();
        expect(
          (await client.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0],
        ).toEqual(before);
        await client.query('DROP TABLE run_context_policies');
        await client.query(sql);
        expect((await client.query('SELECT * FROM run_context_policies')).rows).toEqual([]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await database.close();
    }
  });
});
