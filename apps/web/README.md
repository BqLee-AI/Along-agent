# @along/web

Next.js App Router Web，统一采用自有 LumenUI（shadcn/Base UI）、官方 Linen 主题与 Tailwind CSS v4。顶部导航以「助理」为主，「事项」收纳今日安排、我的提醒、待我确认和活动记录，账户设置放独立菜单；桌面与窄屏使用相同层级，不再常驻侧栏。登录、建号、原身份转正与退出沿用正式账户合同。

## 组件库与主题

基础组件直接从 `@lorelum/lumen-ui/components/*` 导入，不维护本地 `components/ui` 副本、Radix 兼容包装或 shadcn CLI 配置。根布局保留服务端组装，客户端主题边界使用库的 `LumenProvider`，让下拉菜单、选择器和弹窗 portal 继承同一 Linen 主题；CSS 导入官方 `theme.css` 并显式扫描已安装包的样式。应用只负责页面布局和业务状态，外观通过库公开的 variant、color、material 定制，不逐页覆写基础控件。

只使用组件库原生材质与默认 Linen 变量：面板通过 `Card material="panel"`，已有用户消息通过 `Card material="balanced"`，文本域使用原生 `glass`。不定义应用主题 token，不针对库的 surface slot 补描边，也不用背景、阴影或 backdrop-blur 拼造玻璃；库没有的效果不增加。全局 CSS 只保留导入、字体及长正文排版。

包使用固定上游 commit 生成的官方 scoped 分发包，以 `file:vendor/...` 与单一 `bun.lock` 安装，不要求部署机访问私有 GitHub 或依赖 npm 发布。`vendor` 中的 tgz 是有意保留的版本化依赖，不是临时构建日志；Docker 在冻结安装前复制它，本地生命周期将它纳入构建输入摘要。升级时从获准源码版本运行上游官方构建/打包入口，替换归档并更新锁文件，不直接修改归档内的产物。自有代码沿用上游 UNLICENSED 标记，第三方许可包含在分发包中；不对外发布。

容器构建使用独立的 BuildKit Bun 下载缓存，避免冻结依赖变化时重复下载整套依赖；缓存只属于 builder，可随时清理，清理后仍按同一锁文件安装，不改变版本或跳过冻结校验。

固定分发：`@lorelum/lumen-ui@0.0.1-alpha.0`，来源 `lorelum/lumen-ui` commit `337d6c4c5fddc55a0ac5736d500c3cb9d398cace`；归档 `vendor/lorelum-lumen-ui-0.0.1-alpha.0-337d6c4c5fddc55a0ac5736d500c3cb9d398cace.tgz`，928,990字节，SHA-256 `3e231e1208b2107652cc52dfab6274b5c9c7c228e624437358c66807e70b105b`。从该版本运行官方 theme/UI 构建与 `scripts/pack.ts`，不修改上游源码或分发产物。

迁移组件时须显式保留表单提交类型、GET 筛选字段、原冻结批准内容与未选资料状态。链接按钮使用 render、`nativeButton={false}` 与 `role="link"`，保留锚点导航而非被默认识别为按钮。菜单使用库的 render 组合，离开确认保留 alertdialog 语义、取消优先焦点及触发器返回；选择工具、登记、分页和恢复只读，不得顺带发送或继续运行。

`/conversations` 使用独立路由 loading，骨架保持对话栏、消息区及底部输入区的布局，不继承首页欢迎/简报骨架；加载态仅表示读取，不提供假的发送、停止或恢复控件。材质由库在服务端渲染时同步输出，不依赖 hydration 后补样式。

## Run

正式安装请先按 [本机使用指南](../../docs/guides/local-lifecycle.md) 使用原安装的初始化/启动/停止/升级入口。以下分进程命令仅用于开发，不等于受支持安装或真实模型/文件闭环验收。原安装缺私有配置时应定位原配置并由部署者处理，不生成替代秘密、owner、资料根目录或临时安装绕过。

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

- 对话默认进入真实 Agent，无需先选提醒或资料，也不要求工作区登记；输入区在发送和运行结束后保留，同一会话可以连续追问。普通对话使用既有 `harness`，创建提醒快捷入口仍使用 `business`，处理资料使用带显式工作区的 `harness`；不自动 fallback。资料任务必须显式选择服务端读取成功的真实登记；展示完整可读/可写相对范围和受管副本边界，不默认选首项、不接受任意宿主 root。无写范围可只读；空登记与读取失败分别提示，`HARNESS_UNAVAILABLE` 不自动断言为缺模型。
- 聊天使用居中消息区与视口底部输入；左侧「＋」展开提醒、资料和普通对话，已选工具可移除。资料选择和完整范围在输入框内按需展开，未明确选登记不能发送资料任务。低高度窗口中的工具范围和长输入共享有界空间，超出部分内部滚动，保留发送/停止操作而不撑高页面。Enter发送、Shift+Enter换行，输入法确认不误发；生成时显示停止操作。消息只在接近底部时自动跟随，手动向上阅读可通过“回到最新”返回。
- 助手实时增量与最终档案共用安全 Markdown 渲染，支持标题、列表、代码块、链接与表格；不执行原始 HTML，不以逐字动画伪装模型流。运行细节默认折叠，等待批准、明确继续和未知效果的必要提示仍直接可达；助手文本不作为工具效果回执。
- Agent 默认简体中文，用户明确要求其他语言时遵从；代码、标识符与专有名称保持原样。这是原生上下文中的语言指令，不是前端翻译或替代回复。
- 新 Harness 运行接纳时冻结同一用户、同一会话最新 63 条可见 user/assistant 消息与本轮完整输入，总计最多 64 条；这是有界上下文，不是永久记忆。旧工具调用不会作为待执行动作重放；批准恢复使用原冻结引用，不混入后来消息。超过 1MiB 协议帧限制时明确失败，不截断当前输入或切换模型。
- 今日的 `intent=reminder|document` 链接只预选新消息表单，选择/填写不执行；已有会话/Run 身份 query 优先，不改变冻结范围或继续旧 Run。执行中、批准挂起或效果未知时保留输入面并说明不可发送原因，不能靠新消息绕过原运行。
- `thread.started` supplies the conversation and Run IDs. The address becomes
  `/conversations?conversation_id=…&run_id=…`; reopening it reads buffered
  conversation events and the owner-scoped Run view, without starting execution.
  Event sequence IDs deduplicate replay and same-Run continuation.
- Fresh plain Agent sends explicitly include `authorization_revision:'delegation/1'`.
  Reminder and document shortcuts omit it and retain legacy authority. Explicit
  same-key retries reuse their original frozen body, including pre-upgrade
  requests without this field; historical reads never add or upgrade authority.
- New non-workspace Agent runs consume SSE `v2` and the matching `RunView`:
  frozen `authorization_revision` and `execution_lifecycle` are not inferred from
  the page version. `request-bound` is shown as connection-bound on admission
  and historical reads, with no background continuation promise. Refresh,
  reconnect and login remain GET-only; accepted timezone settings are not
  rolled back or automatically repeated after disconnect.
- `GoalResult` is the durable source for goal status, item outcomes, accepted
  receipt references, clarification and final answer. Run `done` means execution
  ended, not that the goal completed; partial, blocked, cancelled and unknown
  results retain their own status and already accepted effects. The saved final
  answer replaces a live draft when available and remains inspectable beside
  the structured result. Historical SSE `v1`, reminders, workspace grants and
  inline approval/explicit continuation workflows keep their existing behavior.
- Plain Agent sends do not promote a cached `/me` preference into an explicit
  timezone hint. Admission reads the actual saved preference; legacy shortcuts
  and explicit ambiguity choices retain their original timezone input.
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

- `/` 以个人助理欢迎与开始对话为主，提醒和资料为次级快捷入口；今日简报按需展开，保留真实日期、时区、范围及过期/错误提示，不把摘要称作全量。`/conversations` 提供默认 Agent 对话及按建立时间排列的会话发现。原会话可读取已存消息并明确发送下一轮；原 `conversation_id/run_id` 深链仍可核对指定运行的原话、回复与逐项批准/效果，消息档案不猜与 Run 的对应，也不重复拼接最终助手档案与流式回复。
- `/approvals` 是提醒确认；文档批准从原 Run 的修改与结果打开 `/document-approvals/{id}`，没有虚构的文档批准集合。校样页保留完整 before/after、目标全文、版本与冻结正文；确认直接以原 `preview.body` 为 `seen_content`，不 trim、不从 DOM/diff/摘要生成。
- `/tasks` 和详情只承载提醒；`/activity` 分别分页读取任务范围索引与选中任务事件。会话/消息/事件/批准/提醒各自沿原游标 GET，失败保留先前获取的内容与游标，不声称已加载范围为全量。
- 打开历史、展开操作、分页、刷新、返回及重登恢复不自动发业务 POST。副作用丢响应先读原事实；继续/取消的显式同键恢复沿原合同，不自动换键或新 Run。
- 授权、Run 与效果独立读取：approved/not_started 不称保存，applied 不称全文核对，verified 才表示有新读取核对；unknown 可能已写入，不能盲重做。取消不撤回既成效果，助手回复不是保存回执。
- page/layout 保留 Server Component 组装；交互 View 使用基础组件，功能 controller 分别拥有对话生命周期、批准决议和账户操作；HTTP/解析/纯投影复用 `lib` 与公开 contracts，不建立第二执行事实源。分层真源见 [design/01 §6](../../docs/design/01-tech-stack-and-repo-structure.md#6-r1-web个人助理与职责边界)。
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
- `/login` accepts an admitted account's username or verified contact email.
  Passwords retain leading and trailing spaces, support paste/password managers,
  and are never put in a URL or browser storage. Sessions expire after seven
  fixed days; reads do not extend them.
  All account forms declare native `method="post"` so a submit before hydration
  or with JavaScript disabled cannot put passwords into query parameters. Native
  page POST is not an alternate authentication endpoint and does not imply success.
  Invite, reset and contact-verification links capture fragment tokens only in
  memory and immediately clear them on entry and subsequent token hash changes.
  A new token resets the prior form result; opening a link performs GET reads
  only, and consumption always requires explicit submission.
- 登录页只常驻用户名、密码、输入内显示/隐藏按钮与登录动作；维护及返回位置说明收进登录帮助。新密码提示至少 8 位，最大 128 位是兼容上限，不是建议长度。原口令不因界面改版被替换；服务端通过 Better Auth 使用随机盐和 scrypt 哈希，不存明文口令。
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
