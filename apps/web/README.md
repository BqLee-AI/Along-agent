# @along/web

Next.js App Router Web：蓝墨任务书桌，统一采用 shadcn/ui new-york / Radix primitives 和 Tailwind CSS v4。桌面侧栏与窄屏 Sheet 提供今日、对话、提醒确认、提醒任务、活动及账户入口；登录、建号、原身份转正与退出沿用正式账户合同。

## Run

正式安装请先按 [本机使用指南](../../docs/local-lifecycle.md) 使用原安装的初始化/启动/停止/升级入口。以下分进程命令仅用于开发，不等于受支持安装或真实模型/文件闭环验收。原安装缺私有配置时应定位原配置并由部署者处理，不生成替代秘密、owner、资料根目录或临时安装绕过。

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

- 新任务先明确选择 **创建提醒 / 处理资料**，分别固定映射 `business` / `harness`，不要求用户选内部执行器，不自动 fallback。资料任务必须显式选择服务端读取成功的真实登记；展示完整可读/可写相对范围和受管副本边界，不默认选首项、不接受任意宿主 root。无写范围可只读；空登记与读取失败分别提示，`HARNESS_UNAVAILABLE` 不自动断言为缺模型。
- 今日的 `intent=reminder|document` 链接只预选新任务表单，选择/填写不执行；已有会话/Run 身份 query 优先，不改变冻结范围或继续旧 Run。
- `thread.started` supplies the conversation and Run IDs. The address becomes
  `/conversations?conversation_id=…&run_id=…`; reopening it reads buffered
  conversation events and the owner-scoped Run view, without starting execution.
  Event sequence IDs deduplicate replay and same-Run continuation.
- Approval links retain those original IDs and open a separate tab. Keep the
  original conversation open: an approval may arrive before its native snapshot
  commits, and ordinary disconnection still cancels active execution.
  confirm/reject/revise 后返回原标签页或原 Run 深链，先读取状态，再在“此运行的操作”中明确继续。文档批准页只授权，不写文件、不自动 resume；批准早于挂起或 `can_resume=false` 时保留授权事实，不能一概解释为尚未批准。普通挂起 EOF 不是成功或取消。
- Resume retries retain the same checkpoint and idempotency key in this tab's
  session storage, including across reload. 显式同键重试
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

## Pages and read-only recovery

- `/` 展示今日提醒与待确认摘要，不把摘要称作全量；`/conversations` 按建立时间发现会话，沿 `conversation_id/run_id` 读取原话、回复与逐项批准/效果，消息档案不猜与 Run 的对应。
- `/approvals` 是提醒确认；文档批准从原 Run 的修改与结果打开 `/document-approvals/{id}`，没有虚构的文档批准集合。校样页保留完整 before/after、目标全文、版本与冻结正文；确认直接以原 `preview.body` 为 `seen_content`，不 trim、不从 DOM/diff/摘要生成。
- `/tasks` 和详情只承载提醒；`/activity` 分别分页读取任务范围索引与选中任务事件。会话/消息/事件/批准/提醒各自沿原游标 GET，失败保留先前获取的内容与游标，不声称已加载范围为全量。
- 打开历史、展开操作、分页、刷新、返回及重登恢复不自动发业务 POST。副作用丢响应先读原事实；继续/取消的显式同键恢复沿原合同，不自动换键或新 Run。
- 授权、Run 与效果独立读取：approved/not_started 不称保存，applied 不称全文核对，verified 才表示有新读取核对；unknown 可能已写入，不能盲重做。取消不撤回既成效果，助手回复不是保存回执。
- page/layout 保留 Server Component 组装；交互 View 使用基础组件，功能 controller 分别拥有对话生命周期、批准决议和账户操作；HTTP/解析/纯投影复用 `lib` 与公开 contracts，不建立第二执行事实源。分层真源见 [design/01 §6](../../docs/design/01-tech-stack-and-repo-structure.md#6-r1-web蓝墨任务书桌与职责边界)。
- 键盘、窄屏与长正文是交付要求；源码描述、测试文件存在或受控 HTTP 浏览器观察均不能替代正式安装、真实 provider、唯一 apply 与新全文 read 的端到端证据。

## Scope

- v0 reads `GET /brief`, approvals, tasks, task events, and the
  conversation SSE endpoint. No client-side time conversion, no local task
  writes, no LLM brief.
- Account access uses the reviewed narrow `/auth/status`, `/auth/initialize`,
  `/auth/claim`, `/auth/sign-in`, `/auth/sign-out` endpoints and `GET /me`.

## Accounts and recovery

- Open **账户** (`/account`) to read installation and workspace state. Only a
  verified `setup_required` status enables the `/setup` administrator form;
  unavailable/invalid status never implies an empty installation.
- `/claim` explicitly confirms only the current eligible signed legacy actor.
  A development bridge cannot claim. Without an eligible old session, the
  deployer must use the original installation's `local:account` command to
  explicitly select and confirm the original account. Existing passwords are
  not overwritten and other owners are not merged.
- `/login` uses the bound administrator's credentials. Passwords retain leading
  and trailing spaces, support paste/password managers, and are never put in a
  URL or browser storage. Sessions expire after seven fixed days; reads do not
  extend them.
- `/logout` requires an explicit submission and reports success only after the
  API confirms revocation. A failed/unknown response is not a completed logout;
  keep the page and inspect the actual state rather than assuming closing a tab
  revokes the session.
- Protected server reads, client actions and initial SSE HTTP 401 responses go
  to login with a safe in-site original path/query. Login's own 401 stays a form
  error; 403, 503 and established stream failures keep their actual meaning.
  Re-login restores only GET reads. It never saves or automatically replays a
  message, confirmation, cancellation or resume; existing same-tab explicit
  action retry keys are removed at the expired-session boundary.
- Account setup/claim success explicitly reports `pending_local_configuration`.
  This is not workspace/model readiness. `/account` distinguishes unconfigured,
  loaded, invalid and unreadable registration. The deployer completes/checks
  registration and reload through `local:account`, preserving the original
  owner, directories and secrets; file/reload failure does not undo the account.
- The proxy forwards the real request Origin without constructing one, preserves
  multiple Set-Cookie/no-store, and retains the existing streaming/abort path.
  `test/account-navigation.test.ts` covers navigation boundaries and actual
  protected/SSE response consumers; proxy regressions extend the existing real
  HTTP proxy tests. Real browser keyboard/paste/error/re-login and zero business
  POST replay still require integration acceptance.
