import type { Server } from 'node:http';
import { createPool } from '../db/pool.js';
import type { AppDeps } from '../http/contracts.js';
import { serve } from '../http/server.js';
import { createRunDriver, type RunDriver } from '../agent/execution/driver/driver.js';
import { loadHarnessServices } from './harness-services.js';
import { createRoutingRuntime } from '../agent/routing/index.js';
import { conversationMemorySources } from '../features/conversations/public.js';
import { createInvitedAccountService } from '../features/identity/public.js';
import { createMemoryService } from '../features/memory/public.js';
import { createUserModelTransport } from '../features/model-providers/public.js';
import { loadTimeContext } from '../features/time/public.js';
import { loadWorkspaceRegistry } from '../features/workspaces/public.js';
import { startWorkerLoop, type WorkerLoopHandle } from '../worker/loop.js';
import { createConfiguredAccountService } from './identity.js';
import { parseRole, type Role } from './role.js';

export interface Application {
  role: Role;
  stop(): Promise<void>;
}

/** Own one process's resources. Importing this module starts none of them. */
export async function startApplication(): Promise<Application> {
  const role = parseRole(process.env.ROLE);
  const pool = createPool();
  let driver: RunDriver | undefined;
  let server: Server | undefined;
  let worker: WorkerLoopHandle | undefined;
  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    if (!stopping) {
      const { promise: serverClosed, resolve } = Promise.withResolvers<void>();
      if (server) server.close(() => resolve());
      else resolve();
      stopping = (async () => {
        try {
          await Promise.all([
            serverClosed,
            worker?.stop().catch(() => undefined),
            driver?.shutdown().catch(() => undefined),
          ]);
        } finally {
          await pool?.end().catch(() => undefined);
        }
      })();
    }
    return stopping;
  }

  try {
    if (role === 'api' || role === 'all') {
      const registry = await loadWorkspaceRegistry();
      console.info(
        'Workspace registry:',
        registry.state,
        'accepted:',
        registry.accepted,
        'rejected:',
        registry.rejected,
      );
      driver = pool ? createRunDriver(pool) : undefined;
      const deps: AppDeps = {
        pool,
        harness: loadHarnessServices(),
        modelTransport: createUserModelTransport,
        routing: createRoutingRuntime(),
        runDriver: driver,
        timeContext: loadTimeContext(process.env.TZDB_VERSION),
        ...(pool
          ? {
              accountService: createConfiguredAccountService(pool),
              invitedAccountService: createInvitedAccountService(pool),
              memoryService: createMemoryService({ pool, sources: conversationMemorySources }),
            }
          : {}),
      };
      server = serve({ port: Number(process.env.PORT ?? 3000), deps });
    }
    if (role === 'worker' || role === 'all') worker = startWorkerLoop({ pool });
    return { role, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
