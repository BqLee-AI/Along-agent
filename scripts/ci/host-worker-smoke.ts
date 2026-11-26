import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { confirmApproval } from '../../apps/api/src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../apps/api/src/features/approvals/reminder/service.js';
import { createIntegrationDatabase, seedApproval } from '../../apps/api/test/integration/setup.js';

const database = await createIntegrationDatabase();
let worker: ReturnType<typeof Bun.spawn> | undefined;
try {
  const seed = await seedApproval(database.pool, { fireInHours: 0.013 });
  const { detail } = await getApprovalDetail(database, seed.ownerId, seed.id);
  const created = await confirmApproval(database, seed.ownerId, seed.id, {
    presentation_hash: seed.presentationHash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  });
  worker = Bun.spawn(['/app/host/bin/along-host'], {
    env: { ...process.env, ROLE: 'worker', DATABASE_URL: database.connectionString },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const until = performance.now() + 120_000;
  while (true) {
    const result = await database.pool.query(
      `SELECT state, schedule_receipt,
        (SELECT count(*)::int FROM notifications WHERE task_id = tasks.id) AS notices,
        (SELECT count(*)::int FROM task_events WHERE task_id = tasks.id AND type = 'fired') AS fired
      FROM tasks WHERE id = $1`,
      [created.task_id],
    );
    const row = result.rows[0];
    if (row.state === 'fired') {
      assert.ok(row.schedule_receipt);
      assert.equal(row.notices, 1);
      assert.equal(row.fired, 1);
      break;
    }
    if (worker.exitCode !== null || performance.now() >= until) {
      throw new Error(`native worker did not fire the reminder: ${JSON.stringify(row)}`);
    }
    await Bun.sleep(500);
  }
  worker.kill('SIGTERM');
  const timeout = setTimeout(() => worker?.kill('SIGKILL'), 5_000);
  try {
    assert.equal(await worker.exited, 0);
  } finally {
    clearTimeout(timeout);
  }
  console.log('Native worker recorded scheduling, notification and one fired event.');
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGKILL');
    await worker.exited;
  }
  await database.close();
}
