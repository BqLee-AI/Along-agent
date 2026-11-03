import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createIntegrationDatabase, databaseUrl, seedApproval } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const migrationUrl = new URL(
  '../../../../infra/migrations/0013_approval_revision_requests.sql',
  import.meta.url,
);

maybe('0013 approval revision migration deployment boundaries', () => {
  it('fresh fixture applies all original migrations, ledger makes 0013 once-only and constraints reject invalid reservations', async () => {
    const database = await createIntegrationDatabase();
    const pool = database.pool;
    try {
      const sql = await readFile(migrationUrl, 'utf8');
      await pool.query(sql);
      expect(
        (
          await pool.query(
            "SELECT version FROM schema_migrations WHERE version IN ('0012','0013') ORDER BY version",
          )
        ).rows,
      ).toEqual([{ version: '0012' }, { version: '0013' }]);
      const old = await seedApproval(pool, {});
      const next = await seedApproval(pool, { ownerId: old.ownerId });
      const insert = `INSERT INTO approval_revision_requests(owner_id,idempotency_key,target_approval_id,request_hash,successor_approval_id) VALUES($1,$2,$3,$4,$5)`;
      await expect(
        pool.query(insert, [old.ownerId, randomUUID(), old.id, 'INVALID', null]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(insert, [old.ownerId, randomUUID(), old.id, 'a'.repeat(64), old.id]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(insert, [old.ownerId, randomUUID(), randomUUID(), 'a'.repeat(64), null]),
      ).rejects.toMatchObject({ code: '23503' });
      const key = randomUUID();
      await pool.query(insert, [old.ownerId, key, old.id, 'a'.repeat(64), next.id]);
      await expect(
        pool.query(insert, [old.ownerId, key, next.id, 'b'.repeat(64), null]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        pool.query(insert, [old.ownerId, randomUUID(), old.id, 'b'.repeat(64), next.id]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(pool.query('DELETE FROM approvals WHERE id=$1', [old.id])).rejects.toMatchObject(
        { code: '23503' },
      );
      await expect(
        pool.query('DELETE FROM approvals WHERE id=$1', [next.id]),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await database.close();
    }
  });

  it('existing clean history upgrades atomically without rewriting approvals', async () => {
    const database = await createIntegrationDatabase();
    try {
      const old = await seedApproval(database.pool, { state: 'superseded' });
      const next = await seedApproval(database.pool, { ownerId: old.ownerId });
      await database.pool.query('UPDATE approvals SET supersedes_approval_id=$1 WHERE id=$2', [
        old.id,
        next.id,
      ]);
      // Fixture only: recreate the pre-0013 deployment boundary.
      await database.pool.query(
        "DROP TABLE approval_revision_requests; DROP INDEX approvals_supersedes_approval_id_uniq; DELETE FROM schema_migrations WHERE version='0013'",
      );
      const before = (await database.pool.query('SELECT * FROM approvals ORDER BY id')).rows;
      await database.pool.query(await readFile(migrationUrl, 'utf8'));
      expect((await database.pool.query('SELECT * FROM approvals ORDER BY id')).rows).toEqual(
        before,
      );
      expect(
        (await database.pool.query("SELECT version FROM schema_migrations WHERE version='0013'"))
          .rows,
      ).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  for (const dirty of [
    'duplicate',
    'missing',
    'self',
    'cross-owner',
    'parent-not-superseded',
    'cancel-kind',
    'illegal-task-link',
    'orphan-superseded',
    'cycle',
  ]) {
    it(`dirty ${dirty} history aborts all DDL and preserves original rows`, async () => {
      const database = await createIntegrationDatabase();
      const pool = database.pool;
      const client = await pool.connect();
      try {
        await client.query(
          "DROP TABLE approval_revision_requests; DROP INDEX approvals_supersedes_approval_id_uniq; DELETE FROM schema_migrations WHERE version='0013'",
        );
        const parent = await seedApproval(pool, { state: 'superseded' });
        const child = await seedApproval(pool, { ownerId: parent.ownerId });
        await client.query('UPDATE approvals SET supersedes_approval_id=$1 WHERE id=$2', [
          parent.id,
          child.id,
        ]);
        if (dirty === 'duplicate') {
          const fork = await seedApproval(pool, { ownerId: parent.ownerId });
          await client.query('UPDATE approvals SET supersedes_approval_id=$1 WHERE id=$2', [
            parent.id,
            fork.id,
          ]);
        }
        if (dirty === 'missing')
          await client.query('UPDATE approvals SET supersedes_approval_id=$1 WHERE id=$2', [
            randomUUID(),
            child.id,
          ]);
        if (dirty === 'self')
          await client.query(
            "UPDATE approvals SET supersedes_approval_id=id,state='superseded' WHERE id=$1",
            [child.id],
          );
        if (dirty === 'cross-owner')
          await client.query('UPDATE approvals SET owner_id=$1 WHERE id=$2', [
            randomUUID(),
            child.id,
          ]);
        if (dirty === 'parent-not-superseded')
          await client.query("UPDATE approvals SET state='pending' WHERE id=$1", [parent.id]);
        if (dirty === 'cancel-kind') {
          const taskId = randomUUID();
          await client.query(
            `INSERT INTO tasks(id,owner_id,source_approval_id,fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version)
            SELECT $1,owner_id,$2,fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version FROM approvals WHERE id=$2`,
            [taskId, child.id],
          );
          await client.query(
            "UPDATE approvals SET kind='cancel_task',target_task_id=$1,expected_state_version=1 WHERE id=$2",
            [taskId, child.id],
          );
        }
        if (dirty === 'illegal-task-link')
          await client.query('UPDATE approvals SET consumed_task_id=$1 WHERE id=$2', [
            randomUUID(),
            parent.id,
          ]);
        if (dirty === 'orphan-superseded')
          await client.query('UPDATE approvals SET supersedes_approval_id=NULL WHERE id=$1', [
            child.id,
          ]);
        if (dirty === 'cycle') {
          await client.query("UPDATE approvals SET state='superseded' WHERE id=$1", [child.id]);
          await client.query('UPDATE approvals SET supersedes_approval_id=$1 WHERE id=$2', [
            child.id,
            parent.id,
          ]);
        }
        const before = (await client.query('SELECT * FROM approvals ORDER BY id')).rows;
        await expect(client.query(await readFile(migrationUrl, 'utf8'))).rejects.toMatchObject({
          code: 'P0001',
        });
        await client.query('ROLLBACK');
        expect((await client.query('SELECT * FROM approvals ORDER BY id')).rows).toEqual(before);
        expect(
          (
            await client.query(
              "SELECT to_regclass('approval_revision_requests') AS requests,to_regclass('approvals_supersedes_approval_id_uniq') AS successor_index",
            )
          ).rows[0],
        ).toEqual({ requests: null, successor_index: null });
        expect(
          (await client.query("SELECT version FROM schema_migrations WHERE version='0013'")).rows,
        ).toHaveLength(0);
      } finally {
        client.release();
        await database.close();
      }
    });
  }
});
