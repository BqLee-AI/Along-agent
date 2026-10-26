import { parseRole } from './role.js';
import { serve } from './http/server.js';
import { startWorkerLoop } from './worker/loop.js';
import { createPool } from './db/pool.js';
import { loadHarnessServices } from './modules/conversations/harness-config.js';
import { loadWorkspaceRegistry } from './modules/workspaces/service.js';

const role = parseRole(process.env.ROLE);

// Main owns the request/scheduler pool; the worker owns its receive pool.
const pool = createPool();
if (role === 'api' || role === 'all') {
  await loadWorkspaceRegistry().catch(() => {
    console.error('Workspace registry unavailable; workspace access is disabled.');
  });
}
const server =
  role === 'api' || role === 'all'
    ? serve({ port: Number(process.env.PORT ?? 3000), pool, harness: loadHarnessServices() })
    : null;
const worker = role === 'worker' || role === 'all' ? startWorkerLoop({ pool }) : null;

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Preserve the service's existing upper bound, including open SSE clients.
  setTimeout(() => process.exit(0), 5000).unref();
  const serverClosed = new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  void (async () => {
    try {
      await Promise.all([serverClosed, worker?.stop().catch(() => undefined)]);
    } finally {
      await pool?.end().catch(() => undefined);
      process.exit(0);
    }
  })();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
