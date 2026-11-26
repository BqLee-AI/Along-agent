import { createPool } from '../db/pool.js';
import { loadTimeContext } from '../features/time/public.js';
import { readiness } from '../http/health/model.js';

// Private command launched by the native host. stdout is the result channel.
const pool = createPool();
try {
  const result = await readiness(pool, loadTimeContext(process.env.TZDB_VERSION));
  process.stdout.write(JSON.stringify(result));
} finally {
  await pool?.end();
}
