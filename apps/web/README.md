# @along/web

Next.js App Router Web，采用自有 LumenUI 与 Tailwind CSS v4。工作区以对话为主，桌面可展开今日安排和提醒，历史会话位于磨砂玻璃质感的对话侧栏；账户和模型服务通过设置面板访问。登录、建号、原身份转正与退出沿用正式账户合同。

## 组件库与主题

基础组件直接从 `@lorelum/lumen-ui/components/*` 导入，不维护本地 `components/ui` 副本、Radix 兼容包装或 shadcn CLI 配置。根布局保留服务端组装，客户端主题边界使用库的 `LumenProvider`，让下拉菜单、选择器和弹窗 portal 继承同一 Linen 主题；CSS 导入官方 `theme.css` 并显式扫描已安装包的样式。应用只负责页面布局和业务状态，外观通过库公开的 variant、color、material 定制，不逐页覆写基础控件。

工作区使用应用主题令牌统一浅色与深色外观，紧凑控件、分隔线和对话输入区沿用 frontend 的视觉；组件交互仍使用库公开的控件和材质。

包使用固定上游 commit 生成的官方 scoped 分发包，以 `file:vendor/...` 与单一 `bun.lock` 安装，不要求部署机访问私有 GitHub 或依赖 npm 发布。`vendor` 中的 tgz 是有意保留的版本化依赖，不是临时构建日志；Docker 在冻结安装前复制它，本地生命周期将它纳入构建输入摘要。升级时从获准源码版本运行上游官方构建/打包入口，替换归档并更新锁文件，不直接修改归档内的产物。自有代码沿用上游 UNLICENSED 标记，第三方许可包含在分发包中；不对外发布。

容器构建使用独立的 BuildKit Bun 下载缓存，避免冻结依赖变化时重复下载整套依赖；缓存只属于 builder，可随时清理，清理后仍按同一锁文件安装，不改变版本或跳过冻结校验。

固定分发：`@lorelum/lumen-ui@0.0.1-alpha.0`，来源 `lorelum/lumen-ui` commit `b95a5409bfaba0e0f8db65c7a82257425f2ca99e`；归档 `vendor/lorelum-lumen-ui-0.0.1-alpha.0-b95a5409bfaba0e0f8db65c7a82257425f2ca99e.tgz`，1,571,722 字节，SHA-256 `41c9e11666c165e9ca110d807eefdd82ab42d692d7706135b7b9dd3df2acc573`。使用原前端已有的官方分发产物，不修改归档。

迁移组件时须显式保留表单提交类型、GET 筛选字段、原冻结批准内容与未选资料状态。链接按钮使用 render、`nativeButton={false}` 与 `role="link"`，保留锚点导航而非被默认识别为按钮。菜单使用库的 render 组合，离开确认保留 alertdialog 语义、取消优先焦点及触发器返回；选择工具、登记、分页和恢复只读，不得顺带发送或继续运行。

`/conversations` 由工作区 shell 中持续挂载的对话面板承载；切换工作区时保留对话状态。读取态仅表示读取，不提供假的发送、停止或恢复操作。

## 桌面工作台与动效

1024px 起聊天与工作区约等分屏幕，分别滚动；工作区关闭后聊天扩宽。窄屏只显示一个表面，隐藏聊天不卸载其生命周期、草稿和订阅；认证入口使用独立单表面。

工作区主入口是今日、提醒、记忆与助理资料；设置收纳账户、模型、资料与扩展连接。今日提供真实简报及提醒、批准、活动入口；`/tasks` 只表示真实提醒，`/todos` 是未接通的普通待办。记忆页面支持查看、更正和停止使用本人记忆；资料库、日记、助理个人资料、技能、连接、渠道和设备显示未接通边界。已有受管资料登记与文档处理不因资料库未接通而被隐藏。

`conversation_id/run_id` 随工作区链接保留，`surface=chat` 表示保留工作区路径但仅显示聊天；URL、刷新和返回因此可以恢复表面与会话。工作区链接与 GET 筛选沿 Next 客户端导航，切换、筛选和收起不重建控制器、不重复 SSE 或发送。显式新对话与不同历史身份仍遵守在途离开保护。运行检查是同一控制器的只读投影，只定位原批准与结果，不复制操作。

Motion 使用根 `MotionConfig reducedMotion="user"` 与共享的 DOM 特性；仅对局部导航反馈与在途控件提供轻量动画，不做全页进入位移，不逐字动画或重播流式增量，不用动画决定执行。滚动跟随由单个 rAF/ResizeObserver adapter 负责，手动阅读暂停跟随；历史消息、Markdown 和不变运行投影与实时增量隔离。性能结论以同负载测量为准，不能由使用 memo 或 Motion API 推断。结构与边界见[工作台方案](../../docs/demo/desktop-experience-plan.md)。

## 功能所有权

- `app/` 只负责路由、RSC 与身份入口；`shell/model`、`shell/viewmodel`、`shell/view` 管理工作区 URL、表面和持续框架。
- `features/{conversations,brief,reminders,approvals,account,capabilities,model-settings}` 按功能归属。`model/` 管类型、数据访问、转换和纯投影；`viewmodel/` 管状态、命令与异步生命周期；`view/` 管展示和 DOM adapter。
- `features/conversations/viewmodel/use-conversation-task.ts` 是会话生命周期唯一 owner；批准、提醒和账户各有独立状态所有者，不复制领域授权。
- 持续挂载的对话面板共享一份历史会话列表，侧栏和历史弹窗使用相同的分页与读取状态；会话运行、事件和命令互斥仍归同一个对话生命周期 owner。
- 资料登记读取与只读事件跟随分别由独立 Hook 管理请求和清理；事件仍交由对话 owner 校验并接纳，资料必须显式选择。会话内批准结果归批准域，确认与继续仍由对话 owner 协调。
- 对话与模型设置共享已保存的模型目录；未保存的地址、Key 和检测状态只属于设置页，刷新目录不应清除设置草稿。已关闭设置页的迟到写入完成时重新读取服务端目录，避免旧响应覆盖新设置。批准的冻结核验与提交归批准域，内联批准后仅在原等待点仍有效时经对话协调者继续。
- `shared/http` 是基础传输与游标读取；`shared/session` 是跨功能身份/认证跳转传输；`shared/ui` 是无业务基础 UI、主题与局部 Motion 策略。被替代的业务根文件与兼容 re-export 不保留。
- 依赖门禁保护 model 不反向依赖展示、功能不导入路由、shared 不导入业务；view 禁止直接 fetch。门禁必须解析真实 `@/` 调用，不靠文件名或源文本断言冒充架构验证。

## Run

正式安装请先按 [本机使用指南](../../docs/guides/local-lifecycle.md) 使用原安装的初始化/启动/停止/升级入口。以下分进程命令仅用于开发，不等于受支持安装或真实模型/文件闭环验收。原安装缺私有配置时应定位原配置并由部署者处理，不生成替代秘密、owner、资料根目录或临时安装绕过。

```bash
# API (repo root; DATABASE_URL + TZDB_VERSION required)
bun run build:packages
bun run --filter @along/api dev

# Web on http://localhost:3100
bun run --filter @along/web dev
```

开发服务器允许 `localhost` 和 `127.0.0.1` 访问 Next 的开发资源；其他主机名需显式配置可信开发来源。不要给 Web 的开发命令加 `--bun`：该选项设置的 `NODE_OPTIONS=--bun` 会使使用真正 Node.js 的 PostCSS 子进程启动失败。

`API_BASE` defaults to `http://127.0.0.1:3000`. Server components forward the
incoming session cookie; the browser talks only to the same-origin proxy at
`/api/v1/*` (SSE is streamed through it).

Controlled local development can explicitly enable the API dev bridge:

```bash
ALLOW_DEV_AUTH=1 DEV_OWNER_ID=<seeded-user-uuid> ...
```

## D2

`src/features/reminders/model/presentation.ts` renders frozen
server strings (`fire_at_local`, `echo_text`) and never reads
`snapshot.fire_at_utc`; `test/presentation.test.ts` mutates the UTC instant and
asserts the output is unchanged. Oxlint rejects `new Date(...)`/`Date.now()`
under `apps/web`.

## 模型设置与对话选模

设置面板中的模型服务通过同源 API 管理多个个人接入。可直接填写地址和 Key；保存后 Key 不回显，留空沿用，输入新值替换。修改地址时不能沿用已保存 Key，须替换或明确清除；清除会撤销相关旧版本的后续凭据使用。密钥旁的服务商连接检测使用未保存草稿，检查接口是否响应，不保证任何模型可用，也不代表已验证密钥。模型列表中可直接检测各个模型，并在通知中查看文本流、工具往返和 usage 的实测状态；检测通知在 10 秒后自动关闭。两种检测均支持无需密钥的端点。模型同步只使用已保存配置，合并发现结果，不删除手动模型。列表发现不保证模型调用权限。

手动添加模型或从模型列表打开设置时，可在独立的磨砂面板中为每个模型配置上下文窗口 token 数；留空沿用系统默认值。面板动效遵循系统的减少动态效果设置。修改只影响之后新建的运行，已接纳的运行使用冻结的窗口设置。

模型设置提供智谱 BigModel、Z.AI、DeepSeek、Kimi、阿里云百炼、SiliconFlow、OpenAI 和 OpenRouter 的常用接入预设。点击服务商名称只查看信息，点击加号或详情中的添加按钮才创建接入并在草稿中填入标准 API 地址，仍需用户保存并按服务商要求提供密钥；地址可修改，自定义接入仍可使用。品牌图标来自 Lobe Icons，许可随图标保存。百炼预设使用北京地域的通用地址，其他地域或业务空间专属域名需自行调整；GLM Coding Plan 有单独的端点及使用范围，不等同于普通 API。

每个服务商分别保存默认模型；在该服务商的模型列表上方选择本接入的模型，或选择“未设置默认模型”取消。接入需启用并保存地址，无密钥端点可用。设置某个服务商默认时，该模型同时成为对话的全局默认；清除其他服务商的默认不改变当前全局默认。对话也可显式选择启用接入中的完整模型 ID，只影响下一次新 Run。使用默认时请求省略选模字段，由服务端在接纳时决定。重试保留原请求意图；历史展示服务端冻结的接入名称和模型，不从当前设置推测旧运行。模型设置及冻结投影依赖服务端实现对应 API；不可用或读取失败时页面显示错误。

## Conversation Runs

- 对话默认进入真实 Agent，无需先选提醒或资料，也不要求工作区登记；输入区在发送和运行结束后保留，同一会话可以连续追问。普通对话使用既有 `harness`，创建提醒快捷入口仍使用 `business`，处理资料使用带显式工作区的 `harness`；不自动 fallback。资料任务必须显式选择服务端读取成功的真实登记；展示完整可读/可写相对范围和受管副本边界，不默认选首项、不接受任意宿主 root。无写范围可只读；空登记与读取失败分别提示，`HARNESS_UNAVAILABLE` 不自动断言为缺模型。
- 聊天使用居中消息区与视口底部输入；左侧「＋」展开提醒、资料和普通对话，已选工具可移除。模型选择控件悬停时显示背景，发送按钮在可用状态变化时保持位置和尺寸。资料选择和完整范围在输入框内按需展开，未明确选登记不能发送资料任务。低高度窗口中的工具范围和长输入共享有界空间，超出部分内部滚动，保留发送/停止操作而不撑高页面。Enter发送、Shift+Enter换行，输入法确认不误发；生成时显示停止操作。消息只在接近底部时自动跟随，手动向上阅读可通过“回到最新”返回。
- 空会话以品牌标识、轻柔背景和快捷入口呈现；输入框聚焦时显示品牌色描边，用户消息以浅品牌色区分。
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
- When a Run actually reports `server-owned`, the page displays that lifecycle
  rather than the connection-bound warning. Running Runs are followed through
  `GET /conversations/{cid}/runs/{rid}/events?after_seq=…` after history is
  read. The stream carries existing SSE events; persisted sequence cursors
  deduplicate reconnects. Three bounded GET attempts are made before offering
  a manual read; 401/403/404 stop retries. Leaving only detaches the view.
  Admission and execution authority remain server-side decisions; the page
  displays the lifecycle frozen for that Run rather than inferring it.
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
- Approval links retain those original IDs and open a separate tab. An approval
  may arrive before its native snapshot commits. Request-bound execution retains
  its disconnect cancellation contract; server-owned execution only detaches
  the subscription.
  confirm/reject/revise 后返回原标签页或原 Run 深链，先读取状态，再在“此运行的操作”中明确继续。文档批准页只授权，不写文件、不自动 resume；批准早于挂起或 `can_resume=false` 时保留授权事实，不能一概解释为尚未批准。普通挂起 EOF 不是成功或取消。
- Resume requests retain the checkpoint and idempotency key in session storage.
  After an uncertain result, read the original Run first. If the fresh state
  still permits continuing the same checkpoint, the user may explicitly retry
  with the same key; refresh and reconnect never resend it automatically.
  **读取运行状态** is read-only.
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

- `/` 是今日工作区，展示真实简报日期、时区、读取范围与过期/错误，不把摘要称作全量。`/conversations` 选择持续聊天及按建立时间排列的历史发现。原会话读取已存消息并可明确发送下一轮；`conversation_id/run_id` 深链保留原话、回复、批准与效果，消息档案不猜 Run 对应，也不重复拼接最终档案与流式回复。
- `/approvals` 是提醒确认；文档批准从原 Run 的修改与结果打开 `/document-approvals/{id}`，没有虚构的文档批准集合。校样页保留完整 before/after、目标全文、版本与冻结正文；确认直接以原 `preview.body` 为 `seen_content`，不 trim、不从 DOM/diff/摘要生成。
- `/tasks` 和详情只承载提醒；`/activity` 分别分页读取任务范围索引与选中任务事件。会话/消息/事件/批准/提醒各自沿原游标 GET，失败保留先前获取的内容与游标，不声称已加载范围为全量。
- 打开历史、展开操作、分页、刷新、返回及重登恢复不自动发业务 POST。副作用丢响应先读原事实；继续/取消的显式同键恢复沿原合同，不自动换键或新 Run。
- 授权、Run 与效果独立读取：approved/not_started 不称保存，applied 不称全文核对，verified 才表示有新读取核对；unknown 可能已写入，不能盲重做。取消不撤回既成效果，助手回复不是保存回执。
- page/layout 保留 Server Component 组装；交互 View 使用基础组件，功能 controller 分别拥有对话生命周期、批准决议和账户操作；HTTP、解析与纯投影复用 `shared`、各功能 model 与公开 contracts，不建立第二执行事实源。分层真源见 [design/01 §6](../../docs/design/01-tech-stack-and-repo-structure.md#6-r1-web个人助理与职责边界)。
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
  not overwritten by claim/admission and other owners are not merged. A
  forgotten password of an admitted account is reset only through
  `local:account --reset-password` on the trusted local terminal.
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
- 账户设置不显示登录会话列表；保留批量撤销登录会话的操作。
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
