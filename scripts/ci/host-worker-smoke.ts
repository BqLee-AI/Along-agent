import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { confirmApproval } from '../../apps/api/src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../apps/api/src/features/approvals/reminder/service.js';
import { requestCancel } from '../../apps/api/src/features/tasks/public.js';
import { createIntegrationDatabase, seedApproval } from '../../apps/api/test/integration/setup.js';

const database = await createIntegrationDatabase();
const workers: ReturnType<typeof Bun.spawn>[] = [];
async function createReminder() {
  const seed = await seedApproval(database.pool, { fireInHours: 0.013 });
  const { detail } = await getApprovalDetail(database, seed.ownerId, seed.id);
  const created = await confirmApproval(database, seed.ownerId, seed.id, {
    presentation_hash: seed.presentationHash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  });
  return { id: created.task_id, ownerId: seed.ownerId };
}

try {
  const due = await createReminder();
  const overdue = await createReminder();
  const cancelled = await createReminder();
  await database.pool.query(
    "UPDATE tasks SET fire_at_utc=now()-interval '20 minutes' WHERE id=$1",
    [overdue.id],
  );
  await requestCancel(database, cancelled.ownerId, cancelled.id, {
    idempotency_key: randomUUID(),
  });
  const challengeId = randomUUID();
  const deliveryId = randomUUID();
  await database.pool.query(
    `INSERT INTO identity_challenges
      (id,purpose,user_id,token_digest,token_key_id,lookup_digest,lookup_key_id,generation,masked_email,created_at,expires_at)
     VALUES($1,'verify_contact',$2,$3,'fixture',$3,'fixture',1,'r***@example.test',
       now()-interval '10 minutes',now()+interval '10 minutes')`,
    [challengeId, due.ownerId, Buffer.alloc(32)],
  );
  await database.pool.query(
    `INSERT INTO identity_mail_deliveries
      (id,challenge_id,generation,purpose,status,attempt_count,created_at,updated_at,
       payload_ciphertext,payload_nonce,payload_tag,encryption_key_id)
     VALUES($1,$2,1,'verify_contact','submitting',1,now()-interval '5 minutes',
       now()-interval '3 minutes',$3,$4,$5,'fixture')`,
    [deliveryId, challengeId, Buffer.alloc(1), Buffer.alloc(12), Buffer.alloc(16)],
  );
  for (let index = 0; index < 2; index++) {
    workers.push(
      Bun.spawn(['/app/host/bin/along-host'], {
        env: { ...process.env, ROLE: 'worker', DATABASE_URL: database.connectionString },
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    );
  }
  const until = performance.now() + 120_000;
  while (true) {
    const result = await database.pool.query(
      `SELECT id, state, schedule_receipt,
        (SELECT count(*)::int FROM notifications WHERE task_id = tasks.id) AS notices,
        (SELECT count(*)::int FROM task_events WHERE task_id = tasks.id AND type = 'fired') AS fired
      FROM tasks WHERE id = ANY($1::uuid[])`,
      [[due.id, overdue.id, cancelled.id]],
    );
    const fired = result.rows.find((row) => row.id === due.id);
    const missed = result.rows.find((row) => row.id === overdue.id);
    const revoked = result.rows.find((row) => row.id === cancelled.id);
    if (fired?.state === 'fired' && missed?.state === 'missed' && revoked?.state === 'cancelled') {
      assert.ok(fired.schedule_receipt);
      assert.deepEqual([fired.notices, fired.fired], [1, 1]);
      assert.deepEqual([missed.schedule_receipt, missed.notices, missed.fired], [null, 0, 0]);
      assert.deepEqual([revoked.notices, revoked.fired], [0, 0]);
      break;
    }
    if (workers.some((worker) => worker.exitCode !== null) || performance.now() >= until) {
      throw new Error(`native Worker did not reconcile reminders: ${JSON.stringify(result.rows)}`);
    }
    await Bun.sleep(500);
  }
  const mail = await database.pool.query(
    `SELECT status,attempt_count,failure_code,payload_ciphertext,payload_erased_at
     FROM identity_mail_deliveries WHERE id=$1`,
    [deliveryId],
  );
  const { payload_erased_at: erased, ...receipt } = mail.rows[0];
  assert.deepEqual(receipt, {
    status: 'unknown',
    attempt_count: 1,
    failure_code: 'abandoned_submitting',
    payload_ciphertext: null,
  });
  assert.ok(erased);
  await Promise.all(
    workers.map(async (worker) => {
      worker.kill('SIGTERM');
      const timeout = setTimeout(() => worker.kill('SIGKILL'), 5_000);
      try {
        assert.equal(await worker.exited, 0);
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  console.log(
    'Two native Workers recorded one reminder delivery and recovered an abandoned mail effect.',
  );
} finally {
  await Promise.all(
    workers.map(async (worker) => {
      if (worker.exitCode === null) worker.kill('SIGKILL');
      await worker.exited;
    }),
  );
  await database.close();
}
