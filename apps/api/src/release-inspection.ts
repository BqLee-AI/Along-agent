import { createPool } from './db/pool.js';
import { inspectReleaseWaiting } from './modules/conversations/harness-authority.js';
import { loadHarnessServices } from './modules/conversations/harness-config.js';
import { loadTimeContext } from './modules/time/context.js';
import { loadWorkspaceRegistry } from './modules/workspaces/service.js';

const pool = createPool();
if (!pool) throw new Error('DATABASE_REQUIRED');
try {
  await loadWorkspaceRegistry();
  const waiting = await inspectReleaseWaiting({
    pool,
    harness: loadHarnessServices(),
    timeContext: loadTimeContext(process.env.TZDB_VERSION),
  });
  console.log(JSON.stringify(waiting));
} finally {
  await pool.end();
}
