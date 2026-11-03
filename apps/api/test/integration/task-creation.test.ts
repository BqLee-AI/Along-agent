import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { withClient, withTransaction } from '../../src/db/transaction.js';
import { confirmApproval } from '../../src/modules/approvals/confirm.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import {
  createTaskWithinTransaction,
  readCreatedTaskReceipt,
} from '../../src/modules/tasks/create.js';
import { getTaskNotificationSource } from '../../src/modules/tasks/notification-source.js';
import { runSchedulePhase } from '../../src/modules/tasks/scheduler/schedule.js';
import { getTaskDetail, listTasksForOwner } from '../../src/modules/tasks/service.js';
import { createIntegrationDatabase, databaseUrl, seedApproval } from './setup.js';
import type { IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const migrationUrl = new URL(
  '../../../../infra/migrations/0023_tasks_direct_creation.sql',
  import.meta.url,
);
const elapsedMigrationUrl = new URL(
  '../../../../infra/migrations/0024_tasks_elapsed_basis.sql',
  import.meta.url,
);
const approvalMigrationUrl = new URL(
  '../../../../infra/migrations/0025_approval_utc_cancellation.sql',
  import.meta.url,
);

async function seedInvocation(pool: Pool, ownerId: string): Promise<string> {
  const invocationId = randomUUID();
  await pool.query(
    `INSERT INTO tool_invocations(invocation_id,owner_id,conversation_id,run_id,
      call_key,first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,
      execution_kind,frozen_context)
     VALUES($1,$2,$3,$4,$5,$6,$7,'create_reminder',$8,2,'local','{}')`,
    [
      invocationId,
      ownerId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'a'.repeat(64),
    ],
  );
  return invocationId;
}

async function frozenInput(pool: Pool, ownerId = randomUUID()) {
  const invocationId = await seedInvocation(pool, ownerId);
  const clock = await pool.query<{ fire_at: Date }>(
    "SELECT clock_timestamp()+interval '1 day' AS fire_at",
  );
  return {
    ownerId,
    source: { invocationId },
    fireAtUtc: clock.rows[0]!.fire_at.toISOString(),
    wallTime: '2030-11-03 09:20:00',
    timezoneId: 'Asia/Shanghai',
    fold: 1 as const,
    resolvedUtcOffsetSeconds: 28800,
    tzdbVersion: 'frozen-fixture',
    originalNote: ' frozen original note ',
    idempotencyKey: `create:${invocationId}`,
  };
}

async function ownerEffects(pool: Pool, ownerId: string) {
  const { rows } = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM tasks WHERE owner_id=$1) AS tasks,
      (SELECT count(*)::int FROM task_events WHERE owner_id=$1) AS events,
      (SELECT count(*)::int FROM outbox WHERE owner_id=$1) AS commands`,
    [ownerId],
  );
  return rows[0];
}

maybe('task creation provenance', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('rejects a newly created task with neither approval nor invocation provenance', async () => {
    await expect(
      pool.query(
        `INSERT INTO tasks(id,owner_id,fire_at_utc,wall_time,timezone_id,
          resolved_utc_offset_seconds,tzdb_version)
         VALUES($1,$2,clock_timestamp()+interval '1 day','2030-11-03 09:20:00',
          'Asia/Shanghai',28800,'fixture-v1')`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'tasks_source_xor_check' });
  });

  it('creates frozen direct facts visible to task, schedule and notification consumers', async () => {
    const input = await frozenInput(pool);
    const result = await withTransaction(pool, (client) =>
      createTaskWithinTransaction(client, input),
    );
    expect(result).toEqual({
      task_id: expect.any(String),
      state: 'saved',
      wall_time: input.wallTime,
      timezone_id: input.timezoneId,
      fold: input.fold,
      resolved_utc_offset_seconds: input.resolvedUtcOffsetSeconds,
      tzdb_version: input.tzdbVersion,
      fire_at_utc: input.fireAtUtc,
      original_note: input.originalNote,
    });
    expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 1, events: 1, commands: 1 });
    const readReceipt = (ownerId: string) =>
      withClient(pool, (client) =>
        readCreatedTaskReceipt(client, { ownerId, invocationId: input.source.invocationId }),
      );
    expect(await readReceipt(input.ownerId)).toEqual(result);
    expect(await readReceipt(randomUUID())).toBeNull();
    expect(await getTaskDetail({ pool }, input.ownerId, result.task_id)).toMatchObject({
      source_approval_id: null,
      source_invocation_id: input.source.invocationId,
      fire_at_local: input.wallTime,
    });
    const list = await listTasksForOwner({ pool }, input.ownerId, {});
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      task_id: result.task_id,
      source_invocation_id: input.source.invocationId,
    });
    expect(await runSchedulePhase(pool)).toMatchObject({ scheduled: 1 });
    expect(
      await withClient(pool, (client) =>
        getTaskNotificationSource(client, input.ownerId, result.task_id),
      ),
    ).toMatchObject({
      state: 'scheduled',
      wallTime: input.wallTime,
      timezoneId: input.timezoneId,
      originalNote: input.originalNote,
      scheduleReceipt: expect.any(String),
    });
    // The receipt describes accepted creation, not the current task state.
    expect(await readReceipt(input.ownerId)).toEqual(result);
    expect(
      (await pool.query('SELECT count(*)::int n FROM approvals WHERE owner_id=$1', [input.ownerId]))
        .rows[0],
    ).toEqual({ n: 0 });
  });
  it('persists elapsed provenance and frozen UTC seconds in receipts, list and detail', async () => {
    const input = await frozenInput(pool);
    const invocation = (
      await pool.query('SELECT conversation_id FROM tool_invocations WHERE invocation_id=$1', [
        input.source.invocationId,
      ])
    ).rows[0];
    const messageId = randomUUID();
    await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      invocation.conversation_id,
      input.ownerId,
    ]);
    await pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remind me')",
      [messageId, input.ownerId, invocation.conversation_id],
    );
    const anchor = (
      await pool.query<{ anchor: Date }>(
        "SELECT date_trunc('second',clock_timestamp()) + interval '1 day' AS anchor",
      )
    ).rows[0]!.anchor;
    const fire = new Date(anchor.getTime() + 180_000);
    const timeBasis = {
      kind: 'elapsed' as const,
      anchor_utc: anchor.toISOString().replace('.000Z', 'Z'),
      duration_seconds: 180,
      source_message_id: messageId,
      revision: 'elapsed/1' as const,
    };
    const elapsed = {
      ...input,
      fireAtUtc: fire.toISOString(),
      wallTime: fire.toISOString().slice(0, 19).replace('T', ' '),
      timezoneId: 'UTC',
      fold: 0 as const,
      resolvedUtcOffsetSeconds: 0,
      tzdbVersion: null,
      timeBasis,
    };
    const receipt = await withTransaction(pool, (client) =>
      createTaskWithinTransaction(client, elapsed),
    );
    expect(receipt).toMatchObject({
      time_basis: timeBasis,
      display_version: 'elapsed/1',
      tzdb_version: null,
    });
    expect(
      await withClient(pool, (client) =>
        readCreatedTaskReceipt(client, {
          ownerId: input.ownerId,
          invocationId: input.source.invocationId,
        }),
      ),
    ).toEqual(receipt);
    const frozen = {
      time_basis: timeBasis,
      display_version: 'elapsed/1',
      tzdb_version: null,
      fold: 0,
      resolved_utc_offset_seconds: 0,
      fire_at_local: elapsed.wallTime,
    };
    expect(await getTaskDetail({ pool }, input.ownerId, receipt.task_id)).toMatchObject(frozen);
    expect((await listTasksForOwner({ pool }, input.ownerId, {})).items[0]).toMatchObject(frozen);
    expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 1, events: 1, commands: 1 });
    await expect(
      pool.query('UPDATE tasks SET time_basis=NULL WHERE id=$1', [receipt.task_id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("UPDATE tasks SET fire_at_utc=fire_at_utc+interval '1 second' WHERE id=$1", [
        receipt.task_id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    // Every invalid attempt is rolled back before task/event/outbox effects.
    for (const changes of [
      { timeBasis: { ...timeBasis, duration_seconds: 0 } },
      { timeBasis: { ...timeBasis, duration_seconds: 181 } },
      { timeBasis: { ...timeBasis, source_message_id: randomUUID() } },
      { timezoneId: 'Asia/Shanghai' },
      { fold: 1 as const },
      { resolvedUtcOffsetSeconds: 3600 },
      { tzdbVersion: '' },
      { wallTime: '2030-01-01 00:00:00' },
      { timeBasis: null },
    ]) {
      await expect(
        withTransaction(pool, (client) =>
          createTaskWithinTransaction(client, { ...elapsed, ...changes }),
        ),
      ).rejects.toThrow();
    }
    expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 1, events: 1, commands: 1 });
    const localInvocation = await seedInvocation(pool, input.ownerId);
    const localConversation = (
      await pool.query('SELECT conversation_id FROM tool_invocations WHERE invocation_id=$1', [
        localInvocation,
      ])
    ).rows[0].conversation_id;
    const localMessage = randomUUID();
    await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      localConversation,
      input.ownerId,
    ]);
    await pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remind me')",
      [localMessage, input.ownerId, localConversation],
    );
    const localTime = new Date(fire.getTime() + 8 * 3600_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const local = await withTransaction(pool, (client) =>
      createTaskWithinTransaction(client, {
        ...elapsed,
        source: { invocationId: localInvocation },
        idempotencyKey: `create:${localInvocation}`,
        timezoneId: 'Asia/Shanghai',
        wallTime: localTime,
        resolvedUtcOffsetSeconds: 28800,
        tzdbVersion: 'real-fixture',
        timeBasis: { ...timeBasis, source_message_id: localMessage },
      }),
    );
    expect(local).toMatchObject({
      wall_time: localTime,
      tzdb_version: 'real-fixture',
      display_version: 'elapsed/1',
    });
  });

  it('preserves pre-elapsed tasks during an idempotent 0024 upgrade', async () => {
    const upgrade = await createIntegrationDatabase();
    const db = upgrade.pool;
    try {
      await db.query(`DROP TRIGGER tasks_elapsed_basis_guard ON tasks;
        DROP FUNCTION tasks_guard_elapsed_basis();
        ALTER TABLE tasks DROP CONSTRAINT tasks_time_basis_check,
          DROP CONSTRAINT tasks_display_version_check, DROP CONSTRAINT tasks_tzdb_version_check,
          DROP COLUMN time_basis, DROP COLUMN display_version;
        ALTER TABLE tasks ALTER COLUMN tzdb_version SET NOT NULL;
        DELETE FROM schema_migrations WHERE version='0024'`);
      const input = await frozenInput(db);
      await db.query(
        `INSERT INTO tasks(id,owner_id,source_invocation_id,fire_at_utc,wall_time,
        timezone_id,fold,resolved_utc_offset_seconds,tzdb_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          input.ownerId,
          input.source.invocationId,
          input.fireAtUtc,
          input.wallTime,
          input.timezoneId,
          input.fold,
          input.resolvedUtcOffsetSeconds,
          input.tzdbVersion,
        ],
      );
      const before = (await db.query('SELECT to_jsonb(t) facts FROM tasks t')).rows;
      const migration = await readFile(elapsedMigrationUrl, 'utf8');
      await db.query(migration);
      await db.query(migration);
      expect(
        (
          await db.query(
            "SELECT to_jsonb(t)-ARRAY['time_basis','display_version'] facts FROM tasks t",
          )
        ).rows,
      ).toEqual(before);
      expect((await db.query('SELECT time_basis,display_version FROM tasks')).rows).toEqual([
        { time_basis: null, display_version: null },
      ]);
      await db.query("UPDATE tasks SET state='pending_schedule' WHERE owner_id=$1", [
        input.ownerId,
      ]);
    } finally {
      await upgrade.close();
    }
  });

  it('rejects both sources, missing invocation, duplicate invocation and clearing a source', async () => {
    const input = await frozenInput(pool);
    const approval = await seedApproval(pool, { ownerId: input.ownerId });
    const inserted = await withTransaction(pool, (client) =>
      createTaskWithinTransaction(client, input),
    );
    await expect(
      pool.query(
        `INSERT INTO tasks(id,owner_id,source_approval_id,source_invocation_id,
          fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          input.ownerId,
          approval.id,
          input.source.invocationId,
          input.fireAtUtc,
          input.wallTime,
          input.timezoneId,
          input.resolvedUtcOffsetSeconds,
          input.tzdbVersion,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'tasks_source_xor_check' });
    await expect(
      pool.query('UPDATE tasks SET source_approval_id=$1 WHERE id=$2', [
        approval.id,
        inserted.task_id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'tasks_source_xor_check' });
    await expect(
      pool.query('UPDATE tasks SET source_invocation_id=NULL WHERE id=$1', [inserted.task_id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'tasks_source_xor_check' });
    await expect(
      withTransaction(pool, (client) =>
        createTaskWithinTransaction(client, {
          ...input,
          source: { invocationId: randomUUID() },
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTransaction(pool, (client) =>
        createTaskWithinTransaction(client, { ...input, idempotencyKey: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 1, events: 1, commands: 1 });
  });

  it('preserves nullable original notes as frozen facts', async () => {
    const input = { ...(await frozenInput(pool)), originalNote: null };
    const result = await withTransaction(pool, (client) =>
      createTaskWithinTransaction(client, input),
    );
    expect(result.original_note).toBeNull();
    expect(
      await withClient(pool, (client) =>
        readCreatedTaskReceipt(client, {
          ownerId: input.ownerId,
          invocationId: input.source.invocationId,
        }),
      ),
    ).toEqual(result);
  });

  for (const provenance of ['invocation', 'approval'] as const) {
    for (const table of ['tasks', 'task_events', 'outbox'] as const) {
      it(`rolls back ${provenance} creation when ${table} write fails`, async () => {
        const input = await frozenInput(pool);
        const approval = await seedApproval(pool, { ownerId: input.ownerId });
        await pool.query(
          `CREATE FUNCTION fail_task_creation() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.owner_id='${input.ownerId}'::uuid THEN
               RAISE EXCEPTION 'injected task creation failure';
             END IF;
             RETURN NEW;
           END; $$;
           CREATE TRIGGER fail_task_creation AFTER INSERT ON ${table}
             FOR EACH ROW EXECUTE FUNCTION fail_task_creation()`,
        );
        try {
          await expect(
            withTransaction(pool, (client) =>
              createTaskWithinTransaction(client, {
                ...input,
                source: provenance === 'invocation' ? input.source : { approvalId: approval.id },
              }),
            ),
          ).rejects.toThrow('injected task creation failure');
          expect(await ownerEffects(pool, input.ownerId)).toEqual({
            tasks: 0,
            events: 0,
            commands: 0,
          });
        } finally {
          await pool.query(
            `DROP TRIGGER fail_task_creation ON ${table}; DROP FUNCTION fail_task_creation()`,
          );
        }
      });
    }
  }

  it('rolls back shared creation if the enclosing caller fails after the outbox write', async () => {
    const input = await frozenInput(pool);
    await expect(
      withTransaction(pool, async (client) => {
        await createTaskWithinTransaction(client, input);
        throw new Error('outer acceptance failed');
      }),
    ).rejects.toThrow('outer acceptance failed');
    expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 0, events: 0, commands: 0 });
  });

  it('rolls back task/event/outbox when legacy consumed update fails', async () => {
    const approval = await seedApproval(pool, {});
    const { detail } = await getApprovalDetail({ pool }, approval.ownerId, approval.id);
    await pool.query(
      `CREATE FUNCTION fail_task_consume() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id='${approval.id}'::uuid AND NEW.state='consumed' THEN
           RAISE EXCEPTION 'injected consume failure';
         END IF;
         RETURN NEW;
       END; $$;
       CREATE TRIGGER fail_task_consume AFTER UPDATE ON approvals
         FOR EACH ROW EXECUTE FUNCTION fail_task_consume()`,
    );
    try {
      await expect(
        confirmApproval({ pool }, approval.ownerId, approval.id, {
          presentation_hash: approval.presentationHash,
          seen_content: detail.echo_text,
          idempotency_key: randomUUID(),
        }),
      ).rejects.toThrow('injected consume failure');
      expect(await ownerEffects(pool, approval.ownerId)).toEqual({
        tasks: 0,
        events: 0,
        commands: 0,
      });
      expect(
        (await pool.query('SELECT state FROM approvals WHERE id=$1', [approval.id])).rows[0],
      ).toEqual({ state: 'pending' });
    } finally {
      await pool.query(
        'DROP TRIGGER fail_task_consume ON approvals; DROP FUNCTION fail_task_consume()',
      );
    }
  });

  it('rejects a frozen fire instant already past the database clock without rewriting it', async () => {
    const input = await frozenInput(pool);
    await expect(
      withTransaction(pool, (client) =>
        createTaskWithinTransaction(client, { ...input, fireAtUtc: '2000-01-01T00:00:00Z' }),
      ),
    ).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
      details: { reason: 'FIRE_TIME_PASSED' },
    });
    expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 0, events: 0, commands: 0 });
  });

  it('rechecks the live database clock after a schedule write crosses the frozen instant', async () => {
    const input = await frozenInput(pool);
    await pool.query(
      `CREATE SEQUENCE creation_clock_crossing;
       CREATE FUNCTION cross_creation_fire_time() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE fire_time timestamptz;
       BEGIN
         IF NEW.owner_id='${input.ownerId}'::uuid THEN
           PERFORM nextval('creation_clock_crossing');
           SELECT fire_at_utc INTO fire_time FROM tasks WHERE id=NEW.task_id;
           PERFORM pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM fire_time-clock_timestamp()))+0.02);
         END IF;
         RETURN NEW;
       END; $$;
       CREATE TRIGGER cross_creation_fire_time AFTER INSERT ON outbox
         FOR EACH ROW EXECUTE FUNCTION cross_creation_fire_time()`,
    );
    try {
      await expect(
        withTransaction(pool, async (client) => {
          const { rows } = await client.query<{ fire_at: Date }>(
            "SELECT clock_timestamp()+interval '1 second' AS fire_at",
          );
          return createTaskWithinTransaction(client, {
            ...input,
            fireAtUtc: rows[0]!.fire_at.toISOString(),
          });
        }),
      ).rejects.toMatchObject({ details: { reason: 'FIRE_TIME_PASSED' } });
      // Sequence increments survive rollback, proving the outbox boundary ran.
      expect((await pool.query('SELECT is_called FROM creation_clock_crossing')).rows[0]).toEqual({
        is_called: true,
      });
      expect(await ownerEffects(pool, input.ownerId)).toEqual({ tasks: 0, events: 0, commands: 0 });
    } finally {
      await pool.query(
        `DROP TRIGGER cross_creation_fire_time ON outbox;
         DROP FUNCTION cross_creation_fire_time(); DROP SEQUENCE creation_clock_crossing`,
      );
    }
  });

  it('upgrades frozen legacy and unknown-source history without rewriting or disabling state updates', async () => {
    const upgrade = await createIntegrationDatabase();
    const db = upgrade.pool;
    try {
      // Restore the actual 0022 task shape inside this isolated fixture only.
      await db.query(
        `DROP TRIGGER approvals_null_tzdb_guard ON approvals;
         DROP FUNCTION approvals_guard_null_tzdb();
         ALTER TABLE approvals DROP CONSTRAINT approvals_tzdb_version_check;
         ALTER TABLE approvals ALTER COLUMN tzdb_version SET NOT NULL;
         DELETE FROM schema_migrations WHERE version='0025';
         DROP TRIGGER tasks_elapsed_basis_guard ON tasks;
         DROP FUNCTION tasks_guard_elapsed_basis();
         ALTER TABLE tasks DROP CONSTRAINT tasks_time_basis_check,
           DROP CONSTRAINT tasks_display_version_check, DROP CONSTRAINT tasks_tzdb_version_check,
           DROP COLUMN time_basis, DROP COLUMN display_version;
         ALTER TABLE tasks ALTER COLUMN tzdb_version SET NOT NULL;
         DELETE FROM schema_migrations WHERE version='0024';
         DROP TRIGGER tasks_creation_source_required ON tasks;
         DROP FUNCTION tasks_require_creation_source();
         ALTER TABLE tasks DROP CONSTRAINT tasks_source_xor_check;
         ALTER TABLE tasks DROP COLUMN source_invocation_id;
         DELETE FROM schema_migrations WHERE version='0023'`,
      );
      const legacy = await seedApproval(db, {});
      const pending = await seedApproval(db, { ownerId: legacy.ownerId });
      const { detail } = await getApprovalDetail({ pool: db }, legacy.ownerId, legacy.id);
      // The shared implementation requires 0023, so seed the real pre-0023
      // legacy shape directly instead of exercising new code on an old schema.
      const legacyTaskId = randomUUID();
      await db.query(
        `INSERT INTO tasks(id,owner_id,source_approval_id,fire_at_utc,wall_time,timezone_id,
          fold,resolved_utc_offset_seconds,tzdb_version,original_note)
         SELECT $1,owner_id,id,fire_at_utc,wall_time,timezone_id,fold,
          resolved_utc_offset_seconds,tzdb_version,original_text FROM approvals WHERE id=$2`,
        [legacyTaskId, legacy.id],
      );
      await db.query("UPDATE approvals SET state='consumed',consumed_task_id=$1 WHERE id=$2", [
        legacyTaskId,
        legacy.id,
      ]);
      const unknownId = randomUUID();
      await db.query(
        `INSERT INTO tasks(id,owner_id,fire_at_utc,wall_time,timezone_id,
          resolved_utc_offset_seconds,tzdb_version)
         VALUES($1,$2,clock_timestamp()+interval '1 day','2030-11-03 09:20:00',
          'Asia/Shanghai',28800,'frozen-old')`,
        [unknownId, legacy.ownerId],
      );
      const tasksBefore = (await db.query('SELECT to_jsonb(t) AS facts FROM tasks t ORDER BY id'))
        .rows;
      const approvalsBefore = (await db.query('SELECT * FROM approvals ORDER BY id')).rows;
      const migration = await readFile(migrationUrl, 'utf8');
      await db.query(migration);
      await db.query(migration);
      expect(
        (
          await db.query(
            "SELECT to_jsonb(t)-'source_invocation_id' AS facts FROM tasks t ORDER BY id",
          )
        ).rows,
      ).toEqual(tasksBefore);
      await db.query(await readFile(elapsedMigrationUrl, 'utf8'));
      await db.query(await readFile(approvalMigrationUrl, 'utf8'));
      expect((await db.query('SELECT * FROM approvals ORDER BY id')).rows).toEqual(approvalsBefore);
      await db.query("UPDATE tasks SET state='pending_schedule',state_version=2 WHERE id=$1", [
        unknownId,
      ]);
      expect((await db.query('SELECT state FROM tasks WHERE id=$1', [unknownId])).rows[0]).toEqual({
        state: 'pending_schedule',
      });
      expect(
        await confirmApproval({ pool: db }, legacy.ownerId, legacy.id, {
          presentation_hash: legacy.presentationHash,
          seen_content: detail.echo_text,
          idempotency_key: randomUUID(),
        }),
      ).toMatchObject({ task_id: legacyTaskId, duplicate: true });
      expect(
        (await db.query('SELECT state FROM approvals WHERE id=$1', [pending.id])).rows[0],
      ).toEqual({
        state: 'pending',
      });
    } finally {
      await upgrade.close();
    }
  });
});
