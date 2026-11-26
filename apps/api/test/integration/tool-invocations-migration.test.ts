import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { databaseUrl, createIntegrationDatabase } from './setup.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import type { ToolContext } from '../../src/agent/tools/contracts.js';
import {
  executeLocalInvocation,
  reserveInvocation,
} from '../../src/agent/tools/invocations/invocations.js';
import { seedContext } from './tool-invocations-probe.js';

const maybe = databaseUrl ? describe : describe.skip;
const migrations = new URL('../../../../infra/migrations/', import.meta.url);
const migration = new URL('0014_conversation_tool_invocations.sql', migrations);

async function legacyDatabase(): Promise<{ pool: Pool; close(): Promise<void> }> {
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
        .filter((file) => file.endsWith('.sql') && file < '0014')
        .sort()) {
        await client.query(await readFile(new URL(filename, migrations), 'utf8'));
      }
    } finally {
      client.release();
    }
  } catch (error) {
    try {
      await pool.end();
      await management.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await management.end();
    }
    throw error;
  }
  return {
    pool,
    close: async () => {
      try {
        await pool.end();
        await management.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await management.end();
      }
    },
  };
}
async function seedLegacy(pool: Pool): Promise<{ ctx: ToolContext; auditId: string }> {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID(),
    attemptId = randomUUID(),
    auditId = randomUUID();
  await pool.query(
    "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'migration fixture','Asia/Shanghai')",
    [ownerId, `${ownerId}@along.test`],
  );
  await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await pool.query(
    "INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens) VALUES($1,$2,$3,'migration','chat',1,100)",
    [runId, ownerId, conversationId],
  );
  await pool.query('INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)', [
    attemptId,
    ownerId,
    runId,
  ]);
  await pool.query(
    "INSERT INTO tool_calls(id,owner_id,run_id,attempt_id,tool_id,args_hash,decision) VALUES($1,$2,$3,$4,'get_user_prefs',$5,'allow')",
    [auditId, ownerId, runId, attemptId, 'a'.repeat(64)],
  );
  return {
    auditId,
    ctx: {
      ownerId,
      conversationId,
      runId,
      attemptId,
      requestId: randomUUID(),
      allowlist: ['get_user_prefs'],
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: '2026-10-17T00:00:00Z',
      receivedAtUtc: '2026-10-17T00:00:00Z',
      foldChoice: 'none',
      timeContext: loadTimeContext('fixture-v1'),
    },
  };
}

maybe('0014 durable invocation migration stop-write cutover', () => {
  it('fresh migrations register 0014 once and repeated deployment is a no-op', async () => {
    const database = await createIntegrationDatabase();
    try {
      await database.pool.query(await readFile(migration, 'utf8'));
      expect(
        (await database.pool.query("SELECT version FROM schema_migrations WHERE version='0014'"))
          .rows,
      ).toEqual([{ version: '0014' }]);
      expect(
        (await database.pool.query('SELECT count(*)::int AS count FROM tool_invocations')).rows[0]
          ?.count,
      ).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('upgrades the legacy audit unchanged and removes hash uniqueness', async () => {
    const database = await legacyDatabase();
    try {
      const { ctx, auditId } = await seedLegacy(database.pool);
      const before = (await database.pool.query('SELECT * FROM tool_calls WHERE id=$1', [auditId]))
        .rows[0];
      await database.pool.query(await readFile(migration, 'utf8'));
      expect(
        (await database.pool.query('SELECT * FROM tool_calls WHERE id=$1', [auditId])).rows[0],
      ).toEqual({
        ...before,
        invocation_id: null,
        request_id: null,
        record_kind: 'legacy',
        outcome_kind: null,
      });
      expect(
        (await database.pool.query('SELECT count(*)::int AS count FROM tool_invocations')).rows[0]
          ?.count,
      ).toBe(0);
      // A physical duplicate of the legacy hash proves the old uniqueness was
      // removed. New production writers always provide correlated audit fields.
      await database.pool.query(
        "INSERT INTO tool_calls(id,owner_id,run_id,attempt_id,tool_id,args_hash,decision) VALUES($1,$2,$3,$4,'get_user_prefs',$5,'allow')",
        [randomUUID(), ctx.ownerId, ctx.runId, ctx.attemptId, 'a'.repeat(64)],
      );
      await expect(
        database.pool.query("UPDATE tool_calls SET decision='deny' WHERE id=$1", [auditId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.pool.query('DELETE FROM tool_calls WHERE id=$1', [auditId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await database.close();
    }
  });

  it('preserves accepted invocation results and correlated audit in the current schema', async () => {
    const database = await createIntegrationDatabase();
    try {
      const original = await seedContext(database.pool);
      const ctx = { ...original, allowlist: ['get_user_prefs'] };
      const input = { toolId: 'get_user_prefs', args: {} };
      const { invocationId } = await reserveInvocation(database.pool, ctx, {
        ...input,
        callKey: 'completed',
        executionKind: 'read_only',
      });
      const outcome = await executeLocalInvocation(
        database.pool,
        ctx,
        { ...input, invocationId },
        async (client) => {
          const read = await client.query<{ timezone_id: string | null }>(
            'SELECT timezone_id FROM users WHERE id=$1',
            [ctx.ownerId],
          );
          return {
            status: 'ok',
            result: {
              kind: 'prefs',
              timezone_id: read.rows[0]?.timezone_id ?? null,
              alias_version: 'v1',
              quiet_hours: null,
              locale: null,
            },
          };
        },
      );
      expect(outcome.status).toBe('ok');
      const accepted = (
        await database.pool.query('SELECT * FROM tool_invocations WHERE invocation_id=$1', [
          invocationId,
        ])
      ).rows[0];
      await expect(
        database.pool.query(
          "UPDATE tool_invocations SET accepted_result='{}'::jsonb WHERE invocation_id=$1",
          [invocationId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.pool.query('DELETE FROM tool_invocations WHERE invocation_id=$1', [invocationId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      expect(
        (
          await database.pool.query('SELECT * FROM tool_invocations WHERE invocation_id=$1', [
            invocationId,
          ])
        ).rows[0],
      ).toEqual(accepted);
      const reserved = await reserveInvocation(database.pool, ctx, {
        ...input,
        callKey: 'reserved',
        executionKind: 'read_only',
      });
      await expect(
        database.pool.query('UPDATE tool_invocations SET args_hash=$2 WHERE invocation_id=$1', [
          reserved.invocationId,
          'b'.repeat(64),
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.pool.query("UPDATE tool_invocations SET state='unknown' WHERE invocation_id=$1", [
          reserved.invocationId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.pool.query(
          `INSERT INTO tool_invocations(invocation_id,owner_id,conversation_id,run_id,call_key,first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context)
        SELECT $1,owner_id,conversation_id,run_id,call_key,first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context FROM tool_invocations WHERE invocation_id=$2`,
          [randomUUID(), invocationId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      const newAudits = (
        await database.pool.query(
          'SELECT invocation_id,request_id,record_kind,outcome_kind FROM tool_calls WHERE invocation_id=$1',
          [invocationId],
        )
      ).rows;
      expect(newAudits).toEqual([
        {
          invocation_id: invocationId,
          request_id: ctx.requestId,
          record_kind: 'accepted',
          outcome_kind: 'success',
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it('a real error before migration COMMIT rolls every DDL and ledger change back, preserving old history and uniqueness', async () => {
    const database = await legacyDatabase();
    const client = await database.pool.connect();
    try {
      const { ctx, auditId } = await seedLegacy(database.pool);
      const before = (await client.query('SELECT * FROM tool_calls ORDER BY id')).rows;
      const sql = await readFile(migration, 'utf8');
      const withFault = sql.replace(
        /COMMIT;\s*$/,
        "DO $fault$ BEGIN RAISE EXCEPTION 'injected migration pre-commit fault'; END $fault$; COMMIT;",
      );
      await expect(client.query(withFault)).rejects.toMatchObject({ code: 'P0001' });
      await client.query('ROLLBACK');
      expect(
        (
          await client.query(
            "SELECT to_regclass('tool_invocations') AS invocations,to_regclass('tool_calls_invocation_created_idx') AS audit_index",
          )
        ).rows[0],
      ).toEqual({ invocations: null, audit_index: null });
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version='0014'")).rows,
      ).toHaveLength(0);
      expect((await client.query('SELECT * FROM tool_calls ORDER BY id')).rows).toEqual(before);
      await expect(
        client.query(
          "INSERT INTO tool_calls(id,owner_id,run_id,attempt_id,tool_id,args_hash,decision) VALUES($1,$2,$3,$4,'get_user_prefs',$5,'allow')",
          [randomUUID(), ctx.ownerId, ctx.runId, ctx.attemptId, 'a'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client.query('DELETE FROM tool_calls WHERE id=$1', [auditId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      await client.query(sql);
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version='0014'")).rows,
      ).toEqual([{ version: '0014' }]);
    } finally {
      client.release();
      await database.close();
    }
  });
});
