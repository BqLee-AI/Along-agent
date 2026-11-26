import { expectApplicationRejection } from '../helpers/application-error.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import type { Pool, PoolClient } from 'pg';
import { sendKeyFor } from '@along/scheduler-core';
import { createActorResolver } from '../../src/http/auth.js';
import {
  hashSessionToken,
  signSessionCookieValue,
} from '../../src/features/identity/session/crypto.js';
import { isActiveOwner } from '../../src/features/identity/profile/preferences.js';
import { getConversationList } from '../../src/features/conversations/history/history-service.js';
import { startConversationRun } from '../../src/agent/run/public.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { getApprovalDetail } from '../../src/features/approvals/reminder/service.js';
import { confirmApproval } from '../../src/features/approvals/reminder/confirm.js';
import { runSchedulePhase } from '../../src/features/tasks/scheduler/schedule.js';
import { runClaimPhase } from '../../src/features/tasks/scheduler/claim.js';
import { runSendPhase } from '../../src/features/tasks/scheduler/send.js';
import { runAckPhase } from '../../src/features/tasks/scheduler/ack.js';
import {
  createLocalInAppProvider,
  type InAppNotice,
  type InAppProvider,
} from '../../src/features/notifications/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('invited account qualification and independent delivery locking', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  let receivePool: Pool;
  let provider: InAppProvider;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    receivePool = database.connect();
    provider = createLocalInAppProvider(receivePool);
  });
  afterAll(async () => {
    await receivePool?.end();
    await database?.close();
  });

  async function user(admitted = true): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO users(id,display_name,auth_email) VALUES($1,'qualification fixture',$2)",
      [id, `${id}@fixture.invalid`],
    );
    if (admitted)
      await pool.query(
        "INSERT INTO identity_account_admissions(user_id,source,admitted_at) VALUES($1,'local_maintenance',clock_timestamp())",
        [id],
      );
    return id;
  }
  async function disable(id: string): Promise<void> {
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [id]);
  }
  async function arm(): Promise<InAppNotice> {
    const ownerId = await user();
    const seed = await seedApproval(pool, { ownerId });
    const { detail } = await getApprovalDetail({ pool }, ownerId, seed.id);
    const confirmed = await confirmApproval({ pool }, ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    });
    await runSchedulePhase(pool);
    const { rows } = await pool.query<{ fire_at_utc: Date }>(
      "UPDATE tasks SET fire_at_utc=date_trunc('milliseconds',now()-interval '10 seconds') WHERE id=$1 RETURNING fire_at_utc",
      [confirmed.task_id],
    );
    await runClaimPhase(pool, randomUUID());
    return {
      ownerId,
      taskId: confirmed.task_id,
      idempotencyKey: sendKeyFor(confirmed.task_id, rows[0]!.fire_at_utc.toISOString()),
    };
  }
  async function state(notice: InAppNotice) {
    return (
      await pool.query(
        `SELECT t.state,o.status,o.last_error,o.provider_receipt_id,
      (SELECT count(*)::int FROM notifications n WHERE n.task_id=t.id) notices,
      (SELECT count(*)::int FROM task_events e WHERE e.task_id=t.id AND e.type='fired') fired
      FROM tasks t JOIN outbox o ON o.task_id=t.id AND o.command->>'kind'='send' WHERE t.id=$1`,
        [notice.taskId],
      )
    ).rows[0]!;
  }
  async function waitBlockedBy(pid: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
        [pid],
      );
      if (result.rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('expected PostgreSQL lock barrier was not reached');
  }
  async function pid(client: PoolClient): Promise<number> {
    return (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  }

  it('requires explicit admission, permits ordinary admitted accounts, and bounds legacy cookies to original claim/status', async () => {
    const id = await user(false);
    const token = randomUUID();
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [id, hashSessionToken(token)],
    );
    const resolver = createActorResolver({ pool });
    const request = (url: string) =>
      ({
        url,
        headers: {
          cookie: `better-auth.session_token=${encodeURIComponent(signSessionCookieValue(token))}`,
        },
      }) as IncomingMessage;
    const client = await pool.connect();
    try {
      expect(await isActiveOwner(client, id)).toBe(false);
    } finally {
      client.release();
    }
    expect(await resolver(request('/api/v1/me'))).toBeNull();
    expect(await resolver(request('/api/v1/auth/status'))).toBeNull();
    expect(
      (await resolver(request('/api/v1/auth/status'), { allowLegacyClaim: true }))?.ownerId,
    ).toBe(id);
    expect(
      (await resolver(request('/api/v1/auth/claim'), { allowLegacyClaim: true }))?.ownerId,
    ).toBe(id);
    expect(await resolver(request('/api/v1/me'), { allowLegacyClaim: true })).toBeNull();
    expect(await resolver(request('/api/v1/auth/sign-out'), { allowLegacyClaim: true })).toBeNull();
    await pool.query(
      "INSERT INTO auth_accounts(user_id,account_id,password_hash) VALUES($1::uuid,$1::text,'existing-password-fixture')",
      [id],
    );
    expect(await resolver(request('/api/v1/auth/claim'), { allowLegacyClaim: true })).toBeNull();
    await pool.query('UPDATE auth_accounts SET password_hash=NULL WHERE user_id=$1', [id]);
    await pool.query(
      "INSERT INTO identity_account_admissions(user_id,source,admitted_at) VALUES($1,'local_maintenance',clock_timestamp())",
      [id],
    );
    expect((await resolver(request('/api/v1/me')))?.ownerId).toBe(id);
    await disable(id);
    expect(await resolver(request('/api/v1/me'))).toBeNull();
    expect(await resolver(request('/api/v1/auth/claim'), { allowLegacyClaim: true })).toBeNull();
    await expectApplicationRejection(getConversationList({ pool }, id, {}), { status: 403 });
    await expectApplicationRejection(
      startConversationRun(
        { pool, timeContext: loadTimeContext('fixture-v1') },
        id,
        randomUUID(),
        { conversation_id: randomUUID(), raw_text: 'hello' },
        null,
      ),
      { status: 403 },
    );
  });

  it('independent new intake rejects an earlier disable without a notification', async () => {
    const notice = await arm();
    await disable(notice.ownerId);
    await expect(provider(notice)).rejects.toThrow('owner_ineligible');
    expect(await state(notice)).toMatchObject({ notices: 0, fired: 0, provider_receipt_id: null });
  });

  it('a prior disable holds the permit barrier and supersedes unsent work without provider calls or fake facts', async () => {
    const notice = await arm();
    const lock = await pool.connect();
    await lock.query('BEGIN');
    try {
      await lock.query("UPDATE users SET status='disabled' WHERE id=$1", [notice.ownerId]);
      let calls = 0;
      const sending = runSendPhase(pool, async () => {
        calls++;
        throw new Error('must not call');
      });
      await waitBlockedBy(await pid(lock));
      await lock.query('COMMIT');
      await sending;
      expect(calls).toBe(0);
      expect(await state(notice)).toMatchObject({
        state: 'scheduled',
        status: 'superseded',
        last_error: 'owner_ineligible',
        notices: 0,
        fired: 0,
        provider_receipt_id: null,
      });
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('user SHARE serializes a later disable and no-lock eligibility remains a read', async () => {
    const id = await user();
    const lock = await pool.connect();
    await lock.query('BEGIN');
    try {
      expect(await isActiveOwner(lock, id, { lock: 'share' })).toBe(true);
      const disabling = disable(id);
      await waitBlockedBy(await pid(lock));
      expect(await isActiveOwner(lock, id)).toBe(true);
      await lock.query('COMMIT');
      await disabling;
      expect(await isActiveOwner(lock, id)).toBe(false);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('a committed permit is spent before disable; independent intake rejects and unknown is never replayed', async () => {
    const notice = await arm();
    let calls = 0;
    let disabling: Promise<void> | undefined;
    const checkpoint = channel('along.scheduler.delivery-checkpoint');
    const observe = (message: unknown) => {
      const event = message as { stage: string; taskId: string };
      if (event.stage === 'permit_committed' && event.taskId === notice.taskId)
        disabling = disable(notice.ownerId);
    };
    checkpoint.subscribe(observe);
    try {
      await runSendPhase(pool, async (input) => {
        calls++;
        await disabling;
        return provider(input);
      });
    } finally {
      checkpoint.unsubscribe(observe);
    }
    expect(calls).toBe(1);
    expect(await state(notice)).toMatchObject({
      state: 'scheduled',
      status: 'acked_unknown',
      notices: 0,
      fired: 0,
    });
    await runSendPhase(pool, async () => {
      calls++;
      throw new Error('spent');
    });
    expect(calls).toBe(1);
  });

  it('receiver SHARE permits independent commit while disable waits, retaining the prior receipt after disable', async () => {
    const notice = await arm();
    const lock = await pool.connect();
    const barrier = 112003;
    await lock.query('SELECT pg_advisory_lock($1)', [barrier]);
    await pool.query(
      `CREATE FUNCTION qualification_receive_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${barrier}); RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER qualification_receive_barrier BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION qualification_receive_barrier()',
    );
    let sending: Promise<unknown> | undefined;
    let disabling: Promise<void> | undefined;
    try {
      sending = runSendPhase(pool, provider);
      await waitBlockedBy(await pid(lock));
      // The trigger is reached only after receiver acquired SHARE; UPDATE must wait.
      const receiver = await pool.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
        [await pid(lock)],
      );
      disabling = disable(notice.ownerId);
      await waitBlockedBy(receiver.rows[0]!.pid);
      await lock.query('SELECT pg_advisory_unlock($1)', [barrier]);
      await sending;
      await disabling;
      const before = await state(notice);
      expect(before).toMatchObject({ state: 'fired', status: 'dispatched', notices: 1, fired: 1 });
      const receipt = await provider(notice);
      expect(receipt.providerReceiptId).toBe(before.provider_receipt_id);
      await runAckPhase(pool);
      expect(await state(notice)).toMatchObject({
        notices: 1,
        fired: 1,
        provider_receipt_id: before.provider_receipt_id,
      });
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [barrier]);
      await sending;
      await disabling;
      await pool.query('DROP TRIGGER qualification_receive_barrier ON notifications');
      await pool.query('DROP FUNCTION qualification_receive_barrier()');
      lock.release();
    }
  });
});
