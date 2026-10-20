# @along/web

Next.js App Router client for the v0 loop: 今日简报 → 确认 → 任务/活动账 → 对话.

## Run

```bash
# API (repo root; DATABASE_URL + TZDB_VERSION required)
bun run build:packages
bun run --filter @along/api dev

# Web on http://localhost:3100
bun run --bun --filter @along/web dev
```

`API_BASE` defaults to `http://127.0.0.1:3000`. Server components forward the
incoming session cookie; the browser talks only to the same-origin proxy at
`/api/v1/*` (SSE is streamed through it).

Local work before the auth decision (#1) can use the API dev bridge:

```bash
ALLOW_DEV_AUTH=1 DEV_OWNER_ID=<seeded-user-uuid> ...
```

## D2

`src/lib/presentation.ts` is the only display projection. It renders frozen
server strings (`fire_at_local`, `echo_text`) and never reads
`snapshot.fire_at_utc`; `test/presentation.test.ts` mutates the UTC instant and
asserts the output is unchanged. Oxlint rejects `new Date(...)`/`Date.now()`
under `apps/web`.

## Scope

- v0 reads `GET /brief`, approvals, tasks, task events, and the
  conversation SSE endpoint. No client-side time conversion, no local task
  writes, no LLM brief.
- Authentication UI is deferred to the auth decision (#1); with a real session
  the existing Better Auth cookie is forwarded unchanged.
