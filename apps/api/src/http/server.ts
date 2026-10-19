import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { handleRequest, type AppDeps } from "./app.js";
import { createActorResolver } from "./auth.js";

export interface ServeOptions {
  port?: number;
  tzdbVersion?: string;
  pool?: Pool | null;
}

export function serve(options: ServeOptions = {}): Server {
  const port = options.port ?? 3000;
  const tzdbVersion = options.tzdbVersion ?? process.env.TZDB_VERSION;
  const pool = options.pool ?? null;
  const resolveActor = createActorResolver({ pool });
  const deps: AppDeps = { pool, resolveActor, tzdbVersion };
  const server = createServer((req, res) => {
    void handleRequest(req, res, deps).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      try {
        res.end(JSON.stringify({ code: 500, data: null, msg: "internal error" }));
      } catch {
        // socket already gone
      }
    });
  });
  server.listen(port);

  const shutdown = () => {
    server.close(() => {
      void (async () => {
        await pool?.end().catch(() => undefined);
        process.exit(0);
      })();
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}
