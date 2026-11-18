import { createPool } from '../db/pool.js';
import { inspectInstallationWaiting } from '../bootstrap/release.js';

const pool = createPool();
if (!pool) throw new Error('DATABASE_REQUIRED');
try {
  const waiting = await inspectInstallationWaiting(pool);
  console.log(JSON.stringify(waiting));
} finally {
  await pool.end();
}
