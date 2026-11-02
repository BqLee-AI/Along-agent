import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';
import { handleRequest, type AppDeps } from './app.js';
import { createActorResolver } from './auth.js';
import { loadTimeContext } from '../modules/time/context.js';
import type { HarnessServices } from '../modules/conversations/harness-process.js';
import type { RoutingRuntime } from '../modules/conversations/routing/index.js';

export interface ServeOptions {
  port?: number;
  tzdbVersion?: string;
  pool?: Pool | null;
  harness?: HarnessServices | null;
  routing?: RoutingRuntime;
}

export function serve(options: ServeOptions = {}): Server {
  const port = options.port ?? 3000;
  const tzdbVersion = options.tzdbVersion ?? process.env.TZDB_VERSION;
  const pool = options.pool ?? null;
  const resolveActor = createActorResolver({ pool });
  const deps: AppDeps = {
    pool,
    resolveActor,
    tzdbVersion,
    timeContext: loadTimeContext(tzdbVersion),
    harness: options.harness ?? null,
    routing: options.routing,
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res, deps).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      try {
        res.end(JSON.stringify({ code: 500, data: null, msg: 'internal error' }));
      } catch {
        // socket already gone
      }
    });
  });
  server.listen(port);

  return server;
}
