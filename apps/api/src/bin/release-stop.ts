import { readFileSync } from 'node:fs';
import { createPool } from '../db/pool.js';
import { stopReleaseWaiting } from '../agent/operations/public.js';
import { loadTimeContext } from '../features/time/public.js';

const pool = createPool();
if (!pool) throw new Error('DATABASE_REQUIRED');
try {
  const selection: unknown = JSON.parse(readFileSync(0, 'utf8'));
  console.log(
    JSON.stringify(
      await stopReleaseWaiting(
        { pool, timeContext: loadTimeContext(process.env.TZDB_VERSION) },
        selection,
      ),
    ),
  );
} finally {
  await pool.end();
}
