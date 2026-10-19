import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createActorResolver, csrfTokenFor, type ActorResolver } from "./auth.js";
import {
  failEnvelope,
  notFound,
  requestIdOf,
  sendJson,
  okEnvelope,
  unauthorized,
} from "./errors.js";
import { handleApprovalRoute } from "../modules/approvals/routes.js";
import { handleConversationRoute } from "../modules/conversations/routes.js";
import { handleTaskRoute } from "../modules/tasks/routes.js";
import { handleBriefRoute } from "../modules/brief/routes.js";

export interface AppDeps {
  pool: Pool | null;
  resolveActor?: ActorResolver;
  tzdbVersion?: string;
}

interface TzdbOnlyOpts {
  tzdbVersion: string | undefined;
}

function isAppDeps(opts: TzdbOnlyOpts | AppDeps): opts is AppDeps {
  return "pool" in opts || "resolveActor" in opts;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (chunks.length === 0) {
      resolve(undefined);
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      resolve(undefined);
    }
  });
  req.on("error", reject);
  return promise;
}

// Async handler with injected deps (pool + actor resolver).
// Keeps /healthz + /readyz behavior from S0.5; /me and the brief/tasks/
// approvals/conversation routes are owner-scoped behind the actor resolver.
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TzdbOnlyOpts | AppDeps,
): Promise<void> {
  const requestId = requestIdOf(req);
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const deps: AppDeps = isAppDeps(opts)
    ? opts
    : { pool: null, tzdbVersion: opts.tzdbVersion };
  const tzdbVersion = deps.tzdbVersion;
  const resolveActor = deps.resolveActor ?? createActorResolver({ pool: deps.pool });

  if (req.method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" }, requestId);
    return;
  }

  if (req.method === "GET" && pathname === "/readyz") {
    if (!tzdbVersion) {
      sendJson(
        res,
        503,
        {
          status: "not_ready",
          reason: "TZDB_UNAVAILABLE",
          details: { missing: ["TZDB_VERSION"] },
        },
        requestId,
      );
      return;
    }
    sendJson(res, 200, { status: "ok" }, requestId);
    return;
  }

  // GET /me: session self-check. Returns the actor snapshot + CSRF token +
  // confirmed timezone with no-store; 401 envelope (code:401) without one.
  if (req.method === "GET" && pathname === "/api/v1/me") {
    const actor = await resolveActor(req);
    if (!actor) {
      sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
      return;
    }
    sendJson(
      res,
      200,
      okEnvelope(
        {
          user: { id: actor.ownerId, display_name: actor.displayName },
          csrf_token: csrfTokenFor(actor),
          confirmed_timezone: actor.timezoneId,
        },
        requestId,
      ),
      requestId,
      { "cache-control": "no-store" },
    );
    return;
  }

  if (pathname === "/api/v1/brief") {
    const handled = await handleBriefRoute(req, res, url, {
      pool: deps.pool,
      resolveActor,
      tzdbVersion,
    });
    if (handled) return;
  }

  // Approvals read routes (PR1) + confirm/reject (PR2).
  if (
    pathname === "/api/v1/approvals" ||
    pathname.startsWith("/api/v1/approvals/")
  ) {
    if (req.method === "GET" || req.method === "POST") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const handled = await handleApprovalRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
      });
      if (handled) return;
    } else {
      const actor = await resolveActor(req);
      if (!actor) {
        sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
        return;
      }
    }
    sendJson(res, 404, failEnvelope(notFound("not found"), requestId), requestId);
    return;
  }

  if (
    pathname === "/api/v1/conversations/messages" ||
    pathname.startsWith("/api/v1/conversations/")
  ) {
    if (req.method === "GET" || req.method === "POST") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const handled = await handleConversationRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
      });
      if (handled) return;
    }
    sendJson(res, 404, failEnvelope(notFound("not found"), requestId), requestId);
    return;
  }

  if (pathname === "/api/v1/tasks" || pathname.startsWith("/api/v1/tasks/")) {
    if (req.method === "GET" || req.method === "POST") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const handled = await handleTaskRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
      });
      if (handled) return;
    }
    sendJson(res, 404, failEnvelope(notFound("not found"), requestId), requestId);
    return;
  }

  // Consume the body for non-GET so sockets drain even on 404.
  if (req.method !== "GET") {
    await readBody(req);
  }

  sendJson(
    res,
    404,
    {
      code: 404,
      data: null,
      msg: "not found",
      error: { code: "NOT_FOUND", message: "not found", request_id: requestId },
      request_id: requestId,
    },
    requestId,
  );
}
