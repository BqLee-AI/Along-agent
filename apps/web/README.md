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

Controlled local development can explicitly enable the API dev bridge:

```bash
ALLOW_DEV_AUTH=1 DEV_OWNER_ID=<seeded-user-uuid> ...
```

## D2

`src/lib/presentation.ts` is the only display projection. It renders frozen
server strings (`fire_at_local`, `echo_text`) and never reads
`snapshot.fire_at_utc`; `test/presentation.test.ts` mutates the UTC instant and
asserts the output is unchanged. Oxlint rejects `new Date(...)`/`Date.now()`
under `apps/web`.

## Conversation Runs

- The execution selector defaults to business and sends the selected execution
  explicitly. Harness uses the real native service; a `HARNESS_UNAVAILABLE`
  response is shown without falling back to business or a fixture.
- `thread.started` supplies the conversation and Run IDs. The address becomes
  `/conversations?conversation_id=…&run_id=…`; reopening it reads buffered
  conversation events and the owner-scoped Run view, without starting execution.
  Event sequence IDs deduplicate replay and same-Run continuation.
- Approval links retain those original IDs and open a separate tab. Keep the
  original conversation open: an approval may arrive before its native snapshot
  commits, and ordinary disconnection still cancels active execution. After
  confirm/reject/revise, read the original Run on the approval page, return to it
  and explicitly click **继续原运行**. An early decision may still show a running
  Run: read again after suspension. Pending approval is not resumable, and
  ordinary suspension stream EOF is not success or cancellation.
- Resume retries retain the same checkpoint and idempotency key in this tab's
  session storage, including across reload. **重试原继续请求（不重复确认）**
  retries that request, not approval confirmation, a successor, or a fresh
  message. **读取运行状态** is read-only.
- **停止原运行** first posts the durable cancel action with a retained
  idempotency key, then aborts the stream. It does not undo accepted effects.
  The proxy forwards actual Next request cancellation and downstream reader
  cancellation to upstream fetch and its reader.
- Session reads use the canonical `Me` and envelope contracts. An explicitly
  enabled dev bridge may return `csrf_token:null`; this remains a valid actor and
  omits only that header. Signed sessions retain their CSRF token and server-side
  validation. Successful envelopes use `error:null`.

`test/conversation-run.test.ts` covers schema-validated fragmented suspension
events, replay sequence deduplication, request-abort and downstream-reader
cancellation. Browser acceptance must also
exercise the real approval/continue/stop/reload surface against the native/API
stack; unit coverage alone is not provider or complete R1 evidence.

## Scope

- v0 reads `GET /brief`, approvals, tasks, task events, and the
  conversation SSE endpoint. No client-side time conversion, no local task
  writes, no LLM brief.
- Authentication UI is outside this surface; the existing signed Better Auth
  session cookie is forwarded unchanged.
