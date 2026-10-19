import { parseRole } from "./role.js";
import { serve } from "./http/server.js";
import { startWorkerLoop } from "./worker/loop.js";
import { createPool } from "./db/pool.js";

const role = parseRole(process.env.ROLE);

// One pool per process: main builds it, the worker loop borrows it.
const pool = createPool();

if (role === "api" || role === "all") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ port, pool });
}

if (role === "worker" || role === "all") {
  startWorkerLoop({ pool });
}
