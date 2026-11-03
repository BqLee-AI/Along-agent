import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DeploymentDatabase } from '../local/database.mjs';

const connectionString = process.env.DATABASE_URL;
const databaseTests = connectionString ? describe : describe.skip;

databaseTests('direct reminder source schema admission against PG16', () => {
  const admin = new pg.Pool({ connectionString, max: 1 });
  afterAll(async () => {
    await admin.end();
  });

  async function isolated(action: (url: string) => Promise<void>) {
    const name = `direct_reminder_${randomUUID().replaceAll('-', '')}`;
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

  async function seedInvocation(client: pg.Client, ownerId: string, conversationId = randomUUID()) {
    const invocationId = randomUUID();
    await client.query(
      `INSERT INTO tool_invocations(invocation_id,owner_id,conversation_id,run_id,
        call_key,first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,
        execution_kind,frozen_context)
       VALUES($1,$2,$3,$4,$5,$6,$7,'create_reminder',$8,2,'local','{}')`,
      [
        invocationId,
        ownerId,
        conversationId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        'a'.repeat(64),
      ],
    );
    return invocationId;
  }

  async function seedApproval(client: pg.Client, ownerId: string) {
    const approvalId = randomUUID();
    await client.query(
      `INSERT INTO approvals(id,owner_id,original_text,fire_at_utc,wall_time,
        timezone_id,resolved_utc_offset_seconds,tzdb_version,presentation_hash,
        presentation_version,expires_at)
       VALUES($1,$2,'approved reminder','2030-11-03T01:20:00Z','2030-11-03 09:20',
        'Asia/Shanghai',28800,'frozen-fixture','approval-fixture','v1',
        clock_timestamp()+interval '1 hour')`,
      [approvalId, ownerId],
    );
    return approvalId;
  }

  async function insertTask(
    client: pg.Client,
    ownerId: string,
    approvalId: string | null,
    invocationId: string | null,
  ) {
    const taskId = randomUUID();
    await client.query(
      `INSERT INTO tasks(id,owner_id,source_approval_id,source_invocation_id,
        fire_at_utc,wall_time,timezone_id,resolved_utc_offset_seconds,tzdb_version,original_note)
       VALUES($1,$2,$3,$4,'2030-11-03T01:20:00Z','2030-11-03 09:20',
        'Asia/Shanghai',28800,'frozen-fixture','frozen reminder')`,
      [taskId, ownerId, approvalId, invocationId],
    );
    return taskId;
  }

  it('upgrades 0022 without inventing historical provenance or preventing scheduler updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'direct-reminder-0022-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0022',
      )) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0022');
          },
          directory,
        );
        const taskId = randomUUID();
        const ownerId = randomUUID();
        let original: unknown;
        await sql(url, async (client) => {
          // This pre-0023 row deliberately represents historical missing provenance.
          await client.query(
            `INSERT INTO tasks(id,owner_id,fire_at_utc,wall_time,timezone_id,fold,
              resolved_utc_offset_seconds,tzdb_version,original_note,state,state_version)
             VALUES($1,$2,'2030-11-03T01:20:00Z','2030-11-03 09:20','Asia/Shanghai',1,
              28800,'historical-tzdb','untouched frozen note','saved',4)`,
            [taskId, ownerId],
          );
          original = (
            await client.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1', [taskId])
          ).rows[0].value;
        });
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({
            kind: 'supported',
            version: '0022',
            reason: 'explicit_upgrade_required',
          });
          await expect(database.initialize()).rejects.toMatchObject({
            code: 'explicit_upgrade_required',
          });
          expect((await database.upgrade()).version).toBe('0025');
        });
        await sql(url, async (client) => {
          expect(
            (
              await client.query(
                "SELECT to_jsonb(t)-ARRAY['source_invocation_id','time_basis','display_version'] AS value FROM tasks t WHERE id=$1",
                [taskId],
              )
            ).rows[0].value,
          ).toEqual(original);
          expect(
            (
              await client.query(
                'SELECT source_approval_id,source_invocation_id FROM tasks WHERE id=$1',
                [taskId],
              )
            ).rows[0],
          ).toEqual({ source_approval_id: null, source_invocation_id: null });
          await client.query(
            `UPDATE tasks SET state='scheduled',state_version=state_version+1,
              schedule_receipt='scheduler-receipt' WHERE id=$1`,
            [taskId],
          );
          expect(
            (
              await client.query(
                `SELECT to_jsonb(t)-ARRAY['source_invocation_id','time_basis','display_version','state','state_version','schedule_receipt']
              AS value FROM tasks t WHERE id=$1`,
                [taskId],
              )
            ).rows[0].value,
          ).toEqual(
            Object.fromEntries(
              Object.entries(original as Record<string, unknown>).filter(
                ([key]) => !['state', 'state_version', 'schedule_receipt'].includes(key),
              ),
            ),
          );
          expect(
            (
              await client.query(
                'SELECT state,state_version,schedule_receipt,source_approval_id,source_invocation_id FROM tasks WHERE id=$1',
                [taskId],
              )
            ).rows[0],
          ).toEqual({
            state: 'scheduled',
            state_version: 5,
            schedule_receipt: 'scheduler-receipt',
            source_approval_id: null,
            source_invocation_id: null,
          });
          for (const column of ['source_approval_id', 'source_invocation_id']) {
            await expect(
              client.query(`UPDATE tasks SET ${column}=NULL WHERE id=$1`, [taskId]),
            ).rejects.toMatchObject({ code: '23514', constraint: 'tasks_source_xor_check' });
          }
        });
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0025' });
          expect((await database.initialize()).version).toBe('0025');
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('upgrades 0023 task facts unchanged and enforces elapsed UTC provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elapsed-0023-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0023',
      )) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0023');
          },
          directory,
        );
        const ownerId = randomUUID();
        let taskId = '';
        let original: unknown;
        await sql(url, async (client) => {
          taskId = await insertTask(client, ownerId, null, await seedInvocation(client, ownerId));
          await client.query("UPDATE tasks SET tzdb_version='' WHERE id=$1", [taskId]);
          original = (
            await client.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1', [taskId])
          ).rows[0].value;
        });
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({
            kind: 'supported',
            version: '0023',
            reason: 'explicit_upgrade_required',
          });
          expect((await database.upgrade()).version).toBe('0025');
        });
        await sql(url, async (client) => {
          expect(
            (
              await client.query(
                "SELECT to_jsonb(t)-ARRAY['time_basis','display_version'] AS value FROM tasks t WHERE id=$1",
                [taskId],
              )
            ).rows[0].value,
          ).toEqual(original);
          await client.query(
            "UPDATE tasks SET state='scheduled',state_version=state_version+1 WHERE id=$1",
            [taskId],
          );
          const invocationId = await seedInvocation(client, ownerId);
          const conversationId = (
            await client.query(
              'SELECT conversation_id FROM tool_invocations WHERE invocation_id=$1',
              [invocationId],
            )
          ).rows[0].conversation_id;
          const messageId = randomUUID();
          await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
            conversationId,
            ownerId,
          ]);
          await client.query(
            "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remind me')",
            [messageId, ownerId, conversationId],
          );
          const basis = {
            kind: 'elapsed',
            anchor_utc: '2030-11-03T01:20:00Z',
            duration_seconds: 60,
            source_message_id: messageId,
            revision: 'elapsed/1',
          };
          const elapsedId = randomUUID();
          await client.query(
            `INSERT INTO tasks(id,owner_id,source_invocation_id,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,time_basis,display_version)
            VALUES($1,$2,$3,'2030-11-03T01:21:00Z','2030-11-03 01:21:00','UTC',0,0,NULL,$4,'elapsed/1')`,
            [elapsedId, ownerId, invocationId, basis],
          );
          await client.query(
            "UPDATE tasks SET state='scheduled',state_version=state_version+1 WHERE id=$1",
            [elapsedId],
          );
          for (const assignment of [
            "wall_time='2030-11-03 01:22:00'",
            "timezone_id='Asia/Shanghai'",
            'fold=1',
            'resolved_utc_offset_seconds=1',
            "tzdb_version='changed'",
            'time_basis=NULL',
          ]) {
            await expect(
              client.query(`UPDATE tasks SET ${assignment} WHERE id=$1`, [elapsedId]),
            ).rejects.toMatchObject({ code: '23514' });
          }
          await expect(
            client.query("UPDATE tasks SET time_basis=$2,display_version='elapsed/1' WHERE id=$1", [
              taskId,
              basis,
            ]),
          ).rejects.toMatchObject({ code: '23514' });
          for (const [zone, fold, offset, wall] of [
            ['Asia/Shanghai', 0, 0, '2030-11-03 01:21:00'],
            ['UTC', 1, 0, '2030-11-03 01:21:00'],
            ['UTC', 0, 1, '2030-11-03 01:21:00'],
            ['UTC', 0, 0, '2030-11-03 01:22:00'],
          ] as const) {
            const other = await seedInvocation(client, ownerId, conversationId);
            await expect(
              client.query(
                `INSERT INTO tasks(id,owner_id,source_invocation_id,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,time_basis,display_version)
              VALUES($1,$2,$3,'2030-11-03T01:21:00Z',$4,$5,$6,$7,NULL,$8,'elapsed/1')`,
                [randomUUID(), ownerId, other, wall, zone, fold, offset, basis],
              ),
            ).rejects.toMatchObject({ code: '23514' });
          }
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('upgrades 0024 approvals unchanged and admits only matching UTC elapsed cancellations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'approval-0024-'));
    const migrations = new URL('../../infra/migrations/', import.meta.url);
    try {
      for (const name of (await readdir(migrations)).filter(
        (name) => name.endsWith('.sql') && name.slice(0, 4) <= '0024',
      )) {
        await copyFile(new URL(name, migrations), join(directory, name));
      }
      await isolated(async (url) => {
        await deployment(
          url,
          async (database) => {
            expect((await database.initialize()).version).toBe('0024');
          },
          directory,
        );
        const ownerId = randomUUID();
        const elapsedId = randomUUID();
        let legacyId = '';
        let original: unknown;
        await sql(url, async (client) => {
          legacyId = await seedApproval(client, ownerId);
          original = (
            await client.query('SELECT to_jsonb(a) AS value FROM approvals a WHERE id=$1', [
              legacyId,
            ])
          ).rows[0].value;
          const conversationId = randomUUID();
          const invocationId = await seedInvocation(client, ownerId, conversationId);
          const messageId = randomUUID();
          await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
            conversationId,
            ownerId,
          ]);
          await client.query(
            "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remind me')",
            [messageId, ownerId, conversationId],
          );
          await client.query(
            `INSERT INTO tasks(id,owner_id,source_invocation_id,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,time_basis,display_version)
             VALUES($1,$2,$3,'2030-11-03T01:21:00Z','2030-11-03 01:21:00','UTC',0,0,NULL,$4,'elapsed/1')`,
            [
              elapsedId,
              ownerId,
              invocationId,
              {
                kind: 'elapsed',
                anchor_utc: '2030-11-03T01:20:00Z',
                duration_seconds: 60,
                source_message_id: messageId,
                revision: 'elapsed/1',
              },
            ],
          );
        });
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({
            kind: 'supported',
            version: '0024',
            reason: 'explicit_upgrade_required',
          });
          expect((await database.upgrade()).version).toBe('0025');
        });
        await sql(url, async (client) => {
          expect(
            (
              await client.query('SELECT to_jsonb(a) AS value FROM approvals a WHERE id=$1', [
                legacyId,
              ])
            ).rows[0].value,
          ).toEqual(original);
          const wallTask = await insertTask(client, ownerId, legacyId, null);
          await client.query(
            `INSERT INTO approvals(id,owner_id,fire_at_utc,wall_time,timezone_id,fold,
              resolved_utc_offset_seconds,tzdb_version,presentation_hash,presentation_version,
              expires_at,kind,target_task_id,expected_state_version)
             VALUES($1,$2,'2030-11-03T01:20:00Z','2030-11-03 09:20','Asia/Shanghai',0,
              28800,'frozen-fixture','hash','v1',clock_timestamp()+interval '1 hour',
              'cancel_task',$3,1)`,
            [randomUUID(), ownerId, wallTask],
          );
          const insert = `INSERT INTO approvals(id,owner_id,fire_at_utc,wall_time,timezone_id,fold,
            resolved_utc_offset_seconds,tzdb_version,presentation_hash,presentation_version,expires_at,
            kind,target_task_id,expected_state_version)
            VALUES($1,$2,'2030-11-03T01:21:00Z',$3,$4,$5,$6,NULL,'hash','v1',
              clock_timestamp()+interval '1 hour',$7,$8,$9)`;
          const args = (
            owner: string,
            wall: string,
            zone: string,
            fold: number,
            offset: number,
            kind: string,
            target: string | null,
            version: number | null,
          ) => [randomUUID(), owner, wall, zone, fold, offset, kind, target, version];
          const approvalId = randomUUID();
          await client.query(insert, [
            approvalId,
            ownerId,
            '2030-11-03 01:21:00',
            'UTC',
            0,
            0,
            'cancel_task',
            elapsedId,
            1,
          ]);
          expect(
            (await client.query('SELECT tzdb_version FROM approvals WHERE id=$1', [approvalId]))
              .rows[0].tzdb_version,
          ).toBeNull();
          await client.query("UPDATE approvals SET state='consumed' WHERE id=$1", [approvalId]);
          for (const values of [
            args(ownerId, '2030-11-03 01:21:00', 'UTC', 0, 0, 'create_task', null, null),
            args(
              ownerId,
              '2030-11-03 01:21:00',
              'Asia/Shanghai',
              0,
              0,
              'cancel_task',
              elapsedId,
              1,
            ),
            args(ownerId, '2030-11-03 01:21:00', 'UTC', 1, 0, 'cancel_task', elapsedId, 1),
            args(ownerId, '2030-11-03 01:21:00', 'UTC', 0, 1, 'cancel_task', elapsedId, 1),
            args(ownerId, '2030-11-03 01:22:00', 'UTC', 0, 0, 'cancel_task', elapsedId, 1),
            args(randomUUID(), '2030-11-03 01:21:00', 'UTC', 0, 0, 'cancel_task', elapsedId, 1),
            args(ownerId, '2030-11-03 01:21:00', 'UTC', 0, 0, 'cancel_task', randomUUID(), 1),
            args(ownerId, '2030-11-03 01:21:00', 'UTC', 0, 0, 'cancel_task', wallTask, 1),
          ]) {
            await expect(client.query(insert, values)).rejects.toMatchObject({ code: '23514' });
          }
        });
        await deployment(url, async (database) => {
          expect(await database.classify()).toMatchObject({ kind: 'supported', version: '0025' });
          expect((await database.upgrade()).version).toBe('0025');
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('enforces source cardinality, real invocation references and uniqueness on inserts and source updates', async () => {
    await isolated(async (url) => {
      await deployment(url, async (database) => {
        expect((await database.initialize()).version).toBe('0025');
      });
      await sql(url, async (client) => {
        const ownerId = randomUUID();
        const approvalId = await seedApproval(client, ownerId);
        const invocationId = await seedInvocation(client, ownerId);
        const secondInvocationId = await seedInvocation(client, ownerId);
        const approvalTaskId = await insertTask(client, ownerId, approvalId, null);
        const directTaskId = await insertTask(client, ownerId, null, invocationId);
        const secondDirectTaskId = await insertTask(client, ownerId, null, secondInvocationId);
        const before = (
          await client.query('SELECT jsonb_agg(to_jsonb(t) ORDER BY id) AS value FROM tasks t')
        ).rows[0].value;
        for (const [approval, invocation] of [
          [null, null],
          [approvalId, invocationId],
        ] as const) {
          await expect(insertTask(client, ownerId, approval, invocation)).rejects.toMatchObject({
            code: '23514',
            constraint: 'tasks_source_xor_check',
          });
        }
        await expect(insertTask(client, ownerId, null, randomUUID())).rejects.toMatchObject({
          code: '23503',
          constraint: 'tasks_source_invocation_id_fkey',
        });
        await expect(insertTask(client, ownerId, null, invocationId)).rejects.toMatchObject({
          code: '23505',
          constraint: 'tasks_source_invocation_id_uniq',
        });
        for (const [taskId, assignment, source] of [
          [directTaskId, 'source_invocation_id', null],
          [approvalTaskId, 'source_approval_id', null],
          [directTaskId, 'source_approval_id', approvalId],
          [approvalTaskId, 'source_invocation_id', invocationId],
        ] as const) {
          await expect(
            client.query(`UPDATE tasks SET ${assignment}=$2 WHERE id=$1`, [taskId, source]),
          ).rejects.toMatchObject({ code: '23514', constraint: 'tasks_source_xor_check' });
        }
        await expect(
          client.query('UPDATE tasks SET source_invocation_id=$2 WHERE id=$1', [
            directTaskId,
            randomUUID(),
          ]),
        ).rejects.toMatchObject({ code: '23503', constraint: 'tasks_source_invocation_id_fkey' });
        await expect(
          client.query('UPDATE tasks SET source_invocation_id=$2 WHERE id=$1', [
            secondDirectTaskId,
            invocationId,
          ]),
        ).rejects.toMatchObject({ code: '23505', constraint: 'tasks_source_invocation_id_uniq' });
        expect(
          (await client.query('SELECT jsonb_agg(to_jsonb(t) ORDER BY id) AS value FROM tasks t'))
            .rows[0].value,
        ).toEqual(before);
        const replacementInvocationId = await seedInvocation(client, ownerId);
        await client.query(
          'UPDATE tasks SET source_approval_id=NULL,source_invocation_id=$2 WHERE id=$1',
          [approvalTaskId, replacementInvocationId],
        );
        expect(
          (
            await client.query(
              'SELECT source_approval_id,source_invocation_id FROM tasks WHERE id=$1',
              [approvalTaskId],
            )
          ).rows[0],
        ).toEqual({ source_approval_id: null, source_invocation_id: replacementInvocationId });
        await client.query(
          'UPDATE tasks SET source_approval_id=$2,source_invocation_id=NULL WHERE id=$1',
          [approvalTaskId, approvalId],
        );
        expect(
          (await client.query('SELECT jsonb_agg(to_jsonb(t) ORDER BY id) AS value FROM tasks t'))
            .rows[0].value,
        ).toEqual(before);
        expect(
          (
            await client.query(
              `SELECT t.tgtype AS type,
            ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(num,pos)
              JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num ORDER BY x.pos) AS columns
           FROM pg_trigger t WHERE t.tgrelid='tasks'::regclass AND t.tgname='tasks_creation_source_required'`,
            )
          ).rows,
        ).toEqual([{ type: 23, columns: ['source_approval_id', 'source_invocation_id'] }]);
        expect(
          (
            await client.query(
              `SELECT confrelid::regclass::text AS target,confdeltype AS delete_action
           FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_source_invocation_id_fkey'`,
            )
          ).rows,
        ).toEqual([{ target: 'tool_invocations', delete_action: 'r' }]);
      });
    });
  }, 30000);

  it.each([
    ['missing source column', 'ALTER TABLE tasks DROP COLUMN source_invocation_id CASCADE'],
    ['required source column', 'ALTER TABLE tasks ALTER COLUMN source_invocation_id SET NOT NULL'],
    [
      'invented source default',
      'ALTER TABLE tasks ALTER COLUMN source_invocation_id SET DEFAULT gen_random_uuid()',
    ],
    [
      'missing source foreign key',
      'ALTER TABLE tasks DROP CONSTRAINT tasks_source_invocation_id_fkey',
    ],
    [
      'weakened source delete action',
      `ALTER TABLE tasks DROP CONSTRAINT tasks_source_invocation_id_fkey;
      ALTER TABLE tasks ADD CONSTRAINT tasks_source_invocation_id_fkey FOREIGN KEY(source_invocation_id)
      REFERENCES tool_invocations(invocation_id) ON DELETE SET NULL`,
    ],
    [
      'missing source uniqueness',
      'ALTER TABLE tasks DROP CONSTRAINT tasks_source_invocation_id_uniq',
    ],
    ['missing source check', 'ALTER TABLE tasks DROP CONSTRAINT tasks_source_xor_check'],
    [
      'weakened source check',
      `ALTER TABLE tasks DROP CONSTRAINT tasks_source_xor_check;
      ALTER TABLE tasks ADD CONSTRAINT tasks_source_xor_check CHECK(true)`,
    ],
    ['disabled source trigger', 'ALTER TABLE tasks DISABLE TRIGGER tasks_creation_source_required'],
    [
      'wrong source trigger events',
      `DROP TRIGGER tasks_creation_source_required ON tasks;
      CREATE TRIGGER tasks_creation_source_required BEFORE INSERT ON tasks
      FOR EACH ROW EXECUTE FUNCTION tasks_require_creation_source()`,
    ],
    [
      'missing source update column',
      `DROP TRIGGER tasks_creation_source_required ON tasks;
      CREATE TRIGGER tasks_creation_source_required BEFORE INSERT OR UPDATE OF source_invocation_id ON tasks
      FOR EACH ROW EXECUTE FUNCTION tasks_require_creation_source()`,
    ],
    [
      'unrestricted source update trigger',
      `DROP TRIGGER tasks_creation_source_required ON tasks;
      CREATE TRIGGER tasks_creation_source_required BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION tasks_require_creation_source()`,
    ],
    ['changed source function volatility', 'ALTER FUNCTION tasks_require_creation_source() STABLE'],
    ['unstamped source schema', "DELETE FROM schema_migrations WHERE version='0023'"],
    ['missing elapsed column', 'ALTER TABLE tasks DROP COLUMN time_basis CASCADE'],
    ['required tzdb', 'ALTER TABLE tasks ALTER COLUMN tzdb_version SET NOT NULL'],
    ['missing elapsed check', 'ALTER TABLE tasks DROP CONSTRAINT tasks_time_basis_check'],
    [
      'weakened elapsed UTC check',
      `ALTER TABLE tasks DROP CONSTRAINT tasks_tzdb_version_check;
      ALTER TABLE tasks ADD CONSTRAINT tasks_tzdb_version_check CHECK(true)`,
    ],
    ['disabled elapsed trigger', 'ALTER TABLE tasks DISABLE TRIGGER tasks_elapsed_basis_guard'],
    ['changed elapsed function volatility', 'ALTER FUNCTION tasks_guard_elapsed_basis() STABLE'],
    ['unstamped elapsed schema', "DELETE FROM schema_migrations WHERE version='0024'"],
  ])(
    'refuses %s without repairing schema or rewriting the ledger',
    async (_name, mutation) => {
      await isolated(async (url) => {
        await deployment(url, async (database) => {
          expect((await database.initialize()).version).toBe('0025');
        });
        const snapshot = `SELECT jsonb_build_object(
        'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m),
        'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,contype,convalidated,confdeltype,pg_get_constraintdef(oid)) ORDER BY conname)
          FROM pg_constraint WHERE conrelid='tasks'::regclass),
        'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid='tasks'::regclass AND a.attnum>0 AND NOT a.attisdropped),
        'triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgtype,tgenabled,tgattr::text,tgfoid) ORDER BY tgname)
          FROM pg_trigger WHERE tgrelid='tasks'::regclass AND NOT tgisinternal),
        'functions',(SELECT jsonb_agg(jsonb_build_array(oid,proname,provolatile,proisstrict,prosecdef,proconfig,prosrc) ORDER BY proname)
          FROM pg_proc WHERE oid IN (to_regprocedure('public.tasks_require_creation_source()'),to_regprocedure('public.tasks_guard_elapsed_basis()')))) AS value`;
        let before: unknown;
        await sql(url, async (client) => {
          await client.query(mutation);
          before = (await client.query(snapshot)).rows[0].value;
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
        await sql(url, async (client) => {
          expect((await client.query(snapshot)).rows[0].value).toEqual(before);
        });
      });
    },
    30000,
  );
});
