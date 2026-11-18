# 01. 技术栈与仓库结构设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：服务端/前端技术栈选型（已确认 vs 待定）、monorepo 布局、包依赖方向、复用优先级
- **不包含**：模块拆分判据（见 02）、API 路由表（见 10）、表字段（见 schema 组）、Spike 细节（见 11）、CI 死规矩实现（见 13）
- **阶段标签**：v0 TS 业务基线；R1 起仓颉唯一 Harness + 长期 TS 能力层（不是全后端迁移）

> 授权作用域：§6逐项批准/资料先选描述现行/legacy；断流策略也适用于早期request-bound。新目标授权、实际能力和冻结生命周期分别生效，见 [design/20 §1、§3、§7–§9](20-goal-scoped-delegation.md)（Proposed）；仅server-owned承诺离开继续，页面分层、明确发送、真实状态和只读恢复不变，不因规范启用能力。

## 标记约定

- Observed：来自蓝图与开源参考的可确认事实（B00–B06 / AF）
- Required：v0 必须遵守的硬约束
- Proposed：建议做法
- Deferred：推迟决策，本文档不猜字段/不下结论

## 1. 选型总表：已确认 vs 待定

### 1.1 已确认（Required）

| 层级           | 选型                                                    | 来源                                        | 说明                                                                                                                 |
| -------------- | ------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 服务端语言     | TypeScript（Bun 1.4.2 运行）                            | Required（#13）                             | TS 模块化单体，一个镜像 `api\|worker\|all` 三角色；time-core 为服务端纯函数子集                                      |
| 宿主 Harness   | 仓颉（唯一模型/工具循环）                               | Required（#44；ADR 0009）                   | 当前上下文、计划、预算、等待/恢复/停止；TS 保留业务、工具与 Run 存储，见 09/11                                       |
| 唯一事实源     | PostgreSQL 16+                                          | Required；AF 三硬约束之一（Observed, AF§5） | Redis 仅加速且延后（v0 不引入）；业务状态一律以 PG 约束为准                                                          |
| Web 前端       | Next.js（App Router），RSC 开、Turbopack 开（默认配置） | Required（P0 冻结）                         | Web 先行，后用 Electron 套同一份 Next.js；v0 只做 Web 单端；偏离默认配置时另开 docs PR 说明                          |
| Web 组件与样式 | LumenUI（shadcn/Base UI）、Tailwind CSS v4              | Required（R1 Web）                          | 直接消费 `@lorelum/lumen-ui` 固定版本包及官方 Linen 主题；PostCSS 接入，不维护本地基础组件副本或第二应用             |
| 认证           | Better Auth 自建 credential                             | Required（已定）                            | D7 空环境冒烟不依赖外部 IdP；v0 单租户；v0 端点只暴露 `GET /me`                                                      |
| 实时对话       | SSE（`text/event-stream`）                              | Required                                    | WS + `ws-ticket` P2 起；Web Push 仅兜底                                                                              |
| 校验           | zod（前后端同源）                                       | Required                                    | `packages/contracts`、`packages/stream-protocol` 版本化 zod；卡片/事件名开工对照 `thread-stream.schema.json`（AF§7） |
| 部署形态       | 单镜像 + compose 冒烟（起步）                           | Required；AF 自托管（Observed, AF§2/§5）    | 一个镜像三种角色 `api\|worker\|all`（对标 AF `all/control/worker`）；做大后迁 K8s（Deferred 细节）                   |
| 包管理/构建    | Bun 1.4.2 workspaces + 单一 bun.lock                    | Required（ADR 0006，取代 0002）             | 根 scripts 显式依赖优先构建；Oxlint 1.89.0、Oxfmt 0.74.0、bun:test 统一质量入口                                      |
| 可观测         | OpenTelemetry + 结构化日志 + `request_id` 全链路        | Required                                    | v0 先 OTel+日志；PostHog/Sentry 为 Deferred                                                                          |

### 1.2 待定（Deferred，一律不猜）

| 待定项          | 候选                       | 决策点   | 本文档态度                              |
| --------------- | -------------------------- | -------- | --------------------------------------- |
| 目标市场/合规   | 数据驻留、隐私条款         | Deferred | 不设字段                                |
| 推送通道        | Web Push 供应商、邮件/短信 | Deferred | v0 只站内通知 + 活动页                  |
| LLM 供应商/计费 | provider、模型路由、额度   | Deferred | 预算字段只定语义（见 09），不绑定供应商 |
| 向量库/RAG      | pgvector vs 独立向量库     | P2+      | v0 不做 RAG                             |

## 2. Monorepo 布局（Observed：v0 关键目录）

```text
Along-agent/
  apps/
    api/                    # TS 模块化单体入口：api|worker|all 三角色
      src/
        main.ts             # 进程入口与关闭信号
        bootstrap/          # api|worker|all 角色装配
        http/               # Elysia 装配、请求准入、响应与传输
        features/           # 按业务能力组织控制器、用例、契约及存储
        agent/              # 跨能力操作、Run 执行、仓颉协议与工具调用
        worker/             # 调度、投递及邮件循环
        bin/                # 本机维护入口
    web/                    # Next.js App Router（Web 先行；后被 Electron 套同一份）
      src/app/              # 路由参数、RSC/身份入口与 feature screen 组装
      src/shell/            # model/viewmodel/view：持续聊天与工作区的 URL、表面及框架
      src/features/         # account/brief/approvals/reminders/conversations/capabilities
        <feature>/model/    # 功能类型、数据访问、协议转换与纯业务投影
        <feature>/viewmodel/# 功能状态、命令、异步生命周期与请求清理（按需）
        <feature>/view/     # screen、展示与 DOM adapter
      src/shared/           # http/、session/、无业务 ui/；不承接功能业务
      vendor/               # 按上游 commit 固定的 LumenUI 官方分发包
  packages/
    contracts/              # 跨模块契约：zod + JSON Schema + 契约测试（进程内/远程同一套）
    stream-protocol/        # SSE/AG-UI 投影版本化 zod（对照 thread-stream.schema.json）
    time-core/              # 纯函数 normalize（禁时钟、禁 agent-runtime 依赖）
    scheduler-core/         # schedule/claim/cancel 领域逻辑（worker 角色执行）
    notifier-core/          # send→回执+幂等
  infra/
    docker/                 # 单镜像 Dockerfile
    compose/                # compose 冒烟（见 13）
    migrations/             # PG 迁移（UNIQUE/append-only 约束落此）
  docs/
    design/                 # 本目录（真源）
    prd/                    # 跟随
```

[Observed] 会话、Run 和 checkpoint 的持久事实归 `apps/api/src/features/conversations/`；跨请求执行和 ToolGateway 归 `apps/api/src/agent/`。二者都在独立 Bun API 中，不另设运行时服务。

[Required] API 按功能组织 MVC：Elysia 控制器直接声明路由与 Zod 输入输出契约，并调用具体用例；Service 接收明确参数，持有业务判断、事务与锁，不接收框架 Context；Model 是请求与响应契约，不是数据库实体。JSON、Cookie 和 SSE 编码留在 HTTP 边界。不为目录对称增加空壳层。

`agent/operations/` 编排接纳、暂停、继续与终结；`agent/runtime/` 持有跨请求 Run 的 driver、执行权和单 attempt 会话；`agent/harness/` 负责仓颉进程与帧协议。会话历史和事务内持久化不归 driver。

其他 API 功能按能力和生命周期组织：

- `identity/account/` 负责账户用例及 HTTP；`identity/session/` 管认证与会话，`security/` 管密钥、资格凭据与限流，`delivery/` 管邮件处理及传输，`profile/` 管偏好和资格投影。
- `model-providers/http/` 接入请求，`configuration/` 管配置及密钥，`outbound/` 管网络限制和连接探测，`runtime/` 管 Run 绑定和模型传输。
- `workspaces/registry/` 是工作区与 grant 权威；`read/`、`write/` 分别拥有读取及受控写入，`http/` 和 `mcp/` 是入口。
- `approvals/reminder/` 与 `approvals/document/` 分别持有提醒批准和文档批准；共享决议和 HTTP 装配留在 approvals 根目录。`tasks/cancellation/` 拥有取消用例及存取，`tasks/scheduler/` 拥有调度生命周期。
- `agent/tools/` 按工具能力归置；`invocations/` 管调用账、效果许可和接受结果，文档目标判断复用调用者持有的 Run 锁。
- `memory/recall/` 管召回资格、语义检索及回执；记忆写入服务留在根目录。简报、通知和时间各自只有一个聚合生命周期，控制器、服务和存取保持就近，不建立空子目录。

`http/app.ts` 组装 Elysia 功能控制器；`access.ts` 和 `request/` 保持认证、端点识别、CSRF、连接资格与有限 body 解析的顺序。未匹配交给 `routing/fallback-controller.ts`，不执行另一套业务路由。`transport/` 负责 Node socket 与 Web Request/Response 桥接、连接收尾和 SSE 背压；`errors.ts` 映射公共错误。Next.js 继续提供同源代理，JSON 网关通过 Eden 从 API 声明推导类型，SSE 继续使用独立事件协议。

Harness 会话初始化在原 Run 事务内读取续接快照和冻结路由资格；路由事实校验独立于帧分发。模型流、暂停许可与终态仍由同一会话协调，不复制其可变状态。

[Required] 仓颉 Harness 的具体目录/传输适配随 R1 决定，不再限制为 `spikes/` 候选第二实现；TS 长期保留 ToolGateway、tools、memory/grep、MCP、PC/browser、办公连接器、身份/批准/时间/任务/worker/API/Web 与 Run/checkpoint 持久存储。尚未实现的能力不能据目录设计宣称已存在。

### Electron 套壳预留（Proposed，v0 不做）

- 远期用 Electron 套同一份 Next.js；v0 只做 Web 单端。
- `apps/web` 构建产物可被 Electron `web-runtimes/` 直接 serve；IPC 命名预留 `along-<domain>:<action>`，v0 不实现任何 IPC。

## 3. 依赖方向（Required，CI 死规矩前身）

```text
apps/api ──depends──▶ packages/{contracts, stream-protocol,
                        scheduler-core, notifier-core, time-core}
仓颉 Harness ──服务契约──▶ TS ToolGateway / Run 存储接口（目标，未实现）
packages/scheduler-core ──depends──▶ packages/{contracts, time-core}
packages/notifier-core ──depends──▶ packages/contracts
packages/time-core ──depends──▶ （零依赖：只用 IANA TZDB 只读数据 + 纯函数）
packages/contracts ──depends──▶ zod（仅此）
```

死规矩（在 13 落 CI）：

1. `time-core` 禁止导入 `agent-runtime`、禁止读取系统时钟、禁止访问 `process.env`/网络（纯函数）。
2. 展示层（`apps/web` + SSE 投影）禁止调用 `normalize` 之外的任何时间换算，禁止自行 `Date` 运算拼 `fire_at_utc`。
3. 仓颉不得直连业务库或导入 TS 存储实现，不直接调 MCP/PC/browser（经 TS 网关，见 11）。
4. 身份/资源关联 ID-first；公共用例可接收显式 DTO、返回只读投影，受控确认事务与可靠异步 outbox 分别定义（见 02 §1–§2）。D1 只证明静态导入边界，不解析 SQL 所有权。

## 4. 复用优先（Proposed → Required）

| 优先级  | 内容                                                                    | 说明                                                                   |
| ------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0 复用 | zod 契约、`code/data/msg/error` envelope、`request_id`+幂等键           | 全接口统一（见 10）                                                    |
| P0 复用 | `normalize(wall_time,timezone_id,fold_choice,ruleset)` 签名与四基准测例 | B06§4 开工版冻结                                                       |
| P1 复用 | `packages/stream-protocol` 事件词汇                                     | AG-UI 待对照 `thread-stream.schema.json`（AF§7）；事件名开工前对照一次 |
| P1 复用 | a13n `agent/skill/prompt revision` 不可变思想                           | 落 `agent_runs/run_attempts/run_checkpoints`（见 09）                  |
| 始终    | 不复制外部产物原文/token/DSN/PostHog key                                | 写作规范硬约束；任何硬编码第三方 secret 一律禁止入库                   |

## 5. 端口与环境（Required，细节见 13）

- `apps/api`：`PORT=3000`（`ROLE=all` 本地一键起）；`apps/web`：`PORT=3100`，`NEXT_PUBLIC_API_BASE` 指向 api。
- PG：`DATABASE_URL`；`TZDB_VERSION` 显式声明（缺失则 `/readyz` 类型化失败，见 10/13）。
- 模型 key、向量库地址（如有）一律环境变量/Secret，不进代码（Observed, B03§6）。
- 工具链：`bun install --frozen-lockfile`；`bun run build:packages` 构建共享包，`bun run build` 先包后应用，`bun run build:api` 构建 API 及依赖。开发、类型检查与测试同样须满足包产物前置，不依赖旧 `dist/`。
- 本地入口：`bun run dev`、`bun run typecheck`、`bun run lint`、`bun run verify`；格式修复与阻塞检查为 `bun run format` / `bun run format:check`。完整测试分组见 [贡献指南](../../CONTRIBUTING.md)。
- Docker 使用固定 Bun、冻结安装与依赖优先构建，以 Bun 启动三角色服务；真实 Dockerfile 从源码与 `bun.lock` 构建，不借宿主机产物或容器内旧工具旁路。D7 健康/就绪行为不变（见 13 §4）。

## 6. R1 Web：个人助理与职责边界

组件从 `@lorelum/lumen-ui/components/*` 直接导入，采用单套 Base UI 底层，不保留 Radix 或本地 shadcn 基础组件副本。包由上游官方构建和打包入口生成，固定源码 commit、包 SHA-256 与单一 bun.lock；分发包随 Web 源码保留，冻结安装与 Docker 构建不依赖私有 GitHub 登录或在线发布。`postcss.config.mjs` 使用 `@tailwindcss/postcss`，`src/app/globals.css` 导入 Tailwind v4、官方 theme.css 并扫描包内样式；`shared/ui/app-theme.tsx` 通过 LumenProvider 固定浅色 Linen，并统一页面、portal 与减少动态效果策略。不新增平行主题、字体或控件库，不手工仿造玻璃。标题 24px/32px、正文 16px/28px、辅助 14px/22px，以间距和分隔组织内容，不为每段消息套卡片。现代浏览器基线随 Tailwind v4（Chrome 111+、Safari 16.4+、Firefox 128+）；窄屏布局不意味着支持旧浏览器。

### 持续聊天与工作区

全应用覆盖今日、聊天及历史、提醒、批准、活动、完整文档校样、账户及认证；不是代表页或只读关联区方案，不保留旧顶部导航作为并行实现。桌面 1024px 起左侧持续聊天、右侧真实工作区，展开时约等分，两区独立滚动；工作区收起后聊天扩宽，正文保持可读行宽。工作区内部按自身容器布局，不再依据整个视口添加固定侧栏。

工作区主入口为「今日」「提醒」「记忆」「助理」（助理资料），设置独立可达。今日提供真实提醒、待我确认和活动记录入口；批准和活动不是全局 Agent 审计。窄屏只有聊天或工作区一个可见表面，主要导航固定为「聊天、今日、提醒、记忆、助理」五项；隐藏区不可聚焦，不覆盖输入。跳到主要内容、表面切换后的焦点与键盘操作由 shell/view 负责。

| 页面 / 路由                                  | 内容与边界                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 今日 `/`                                     | 真实日期/时区、简报、提醒、待确认与活动入口；只读聚合，不是全部任务                      |
| 聊天及历史 `/conversations`                  | 新对话、连续消息、会话发现、原 Run/批准/效果与历史分页；历史筛选仅覆盖已读取记录         |
| 提醒 `/tasks`、`/tasks/{id}`                 | 真实定时提醒、状态、调度及取消回执、通知与事件；不是普通待办                             |
| 提醒确认 `/approvals`、`/approvals/{id}`     | 冻结提醒列表/详情、确认、拒绝及显式修改；不混入文档批准                                  |
| 活动 `/activity`                             | 任务范围索引与选中任务事件，各有游标；不是全局全量时间线                                 |
| 文档批准 `/document-approvals/{id}`          | 从原 Run 可深链审阅完整冻结全文，独立新标签；没有文档批准集合路由                        |
| 账户 `/account`                              | 原身份、认证状态、已有受管资料登记及本机维护边界                                         |
| 认证 `/login`、`/setup`、`/claim`、`/logout` | 正式登录、核验空安装后建号、原身份转正、明确退出；使用独立认证表面，不显示聊天工作区     |
| 设置 `/settings`                             | 分类进入账户、模型、资料及扩展；模型配置使用真实 API，未接通能力不提供虚构设置或保存动作 |
| 记忆 `/memories`                             | 查看本人来源记忆，可显式更正或停止使用；来源可追溯不代表内容已核实                       |
| 资料 `/materials`                            | 资料库管理未接通；不影响聊天资料工具显式选择已有受管登记                                 |
| 日记 `/journal`、助理资料 `/profile`         | 读取/编辑未接通，无自动归档或无法保存的编辑表单                                          |
| 技能 `/skills`、连接 `/connectors`           | 管理未接通，无可安装目录、启用动作、外部授权或虚构已连接服务                             |
| 渠道 `/channels`、设备 `/devices`            | 接入/管理未接通，无配对码、注册、在线或可控制状态承诺                                    |
| 普通待办 `/todos`                            | 未接通，与真实提醒 `/tasks` 分开，不暗含排期、通知或执行                                 |

这些未接通页由 `features/capabilities/model/capabilities.ts` 定义边界与关联入口，`view` 负责展示，不因存在路由而声明后台能力。`app/api/[...path]/route.ts` 是原同源 HTTP/SSE 传输入口，不是新增业务页面或授权层。

### URL、身份与唯一生命周期

`app/layout.tsx` 的 RSC 读取身份并组装 `shell/view/app-shell.tsx`；shell 只持有一个不以路径为 key 的 `ConversationPane`，`/conversations/page.tsx` 不再创建第二个会话实例。工作区切换、收起/展开和窄屏表面切换保留同一聊天实例与草稿，不重挂载、不重连原 SSE、不重发、不取消。显式新对话、选中另一会话/Run、真正离开应用或转入认证，仍按原在途离开保护处理；不因此承诺服务端后台执行。

选中身份由 `conversation_id` 与可选 `run_id` 表达。`shell/model/navigation.ts` 的 `shellLocation` 解析身份及表面，`isWorkspacePath`/`workspaceHref` 配合 `WorkspaceLink` 只为工作区目的地继承当前身份；显式新对话、历史身份深链和认证目的地保留自己的 URL 语义。`surface=chat` 保留工作区路径与身份，但只显示聊天；重新展开恢复对应路径，不新建会话。刷新、直接深链与返回依 URL 恢复身份/表面，无效身份不读取或执行其中的操作。

对话默认使用已有无 workspace 的 `harness`；消息区独立滚动，输入常驻聊天区底部。同一会话可以明确发送下一轮；提醒/资料工具位于「＋」菜单并可移除，分别固定 `business` / `harness`。`intent=reminder|document` 只预选新消息表单，身份 query 优先；选择、填写、切换目标不发送。资料必须显式选择读取成功的登记，不默选首项、不接受任意宿主 root；完整可读/可写相对范围与受管副本说明按需展开，空登记与读取失败分开，无写范围仍可执行只读资料任务。

执行中仍可编辑草稿，但发送资格继续受原 Run、批准挂起、未知发送及未知效果限制；不得用新消息绕过原运行。成功结束仅在输入仍等于本次提交文本时清空，不清除 SSE 期间新编辑的草稿。消息档案不猜与某 Run 的对应，不重复拼接同一回复的流式与最终存储文本。会话、消息、事件、提醒确认、任务和活动分页沿各自服务端游标 GET，保留既有内容、局部错误和未推进游标；打开、展开、刷新、回退与重登恢复均不自动业务 POST，不把首批/已加载范围称为全量。

### Feature-owned MVVM 与 RSC 边界

| 边界                                                                               | 职责与实际入口                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `app/` page/layout（RSC）                                                          | 解析路由参数、身份入口与 feature screen 组装；不拥有业务页面编排、分页状态或第二个会话控制器，不将全站客户端化           |
| `shell/model`                                                                      | 路由、导航项目、身份与表面 URL 投影；不拥有 Run、批准或领域资格                                                          |
| `shell/viewmodel/use-workspace-shell.ts`                                           | 持续会话身份、表面与工作区导航状态；不重复执行生命周期                                                                   |
| `shell/view`                                                                       | 双区框架、五项窄屏导航、可见性和焦点；`WorkspaceLink` 处理工作区身份继承                                                 |
| `features/*/model`                                                                 | 功能类型、数据访问、协议校验/转换、冻结内容和纯业务投影；复用 contracts/stream-protocol，不依赖 view/组件或 API 私有实现 |
| `features/*/viewmodel`                                                             | 功能状态、显式命令、异步生命周期、迟到响应隔离和请求清理；无交互状态的功能不设空壳层                                     |
| `features/*/view`                                                                  | RSC screen、Client 展示及 DOM adapter；负责布局、焦点、完整审阅和局部反馈，不直接客户端 fetch 或编排业务执行             |
| `shared/http/{client,server,result,page,use-page}`                                 | 通用 HTTP、envelope/错误结果及只读分页基础设施，不承接领域资格                                                           |
| `shared/session/{identity,navigation}`、`shared/ui/{app-theme,page,read-controls}` | 跨功能身份/安全返回与无业务 UI、主题/Motion 策略；不另立根业务 `lib/` 或组件实现                                         |

功能所有权分别归 `account`、`brief`、`approvals`、`reminders`、`conversations`、`capabilities`。例如 `approvals/model/{approval,approvals.server,document-loop}` 拥有冻结批准与精确提交，`reminders/model/{data,reminder-server,types,presentation}` 拥有提醒读取和投影，`account/model` 与 `account/viewmodel/account-screen.ts` 拥有账户读取/资格与操作；RSC screen 可调用自己的服务端数据边界，不把领域规则放回 `app/`。被替代的根业务文件及兼容 re-export 不作为第二条调用路径保留。

`features/conversations/viewmodel/use-conversation-task.ts` 的 `useConversationTask` 是发送、原 Run SSE、GET、显式继续/取消、未知发送保护与原幂等键的唯一所有者；历史读取与纯派生分别由同 feature 的 viewmodel/model 承接。文档决议由 `features/approvals/viewmodel/useDocumentApproval.ts` 归属，提醒和账户操作拥有各自 viewmodel。继续绑定原 Run/checkpoint/请求键；取消以服务端事实为准，断开连接不等于成功取消或回滚既成效果。批准链接独立新标签，避免因审阅提前断开原流。

### DOM、Markdown 与 Motion

`features/conversations/viewmodel/use-conversation-scroll.ts` 是聊天 DOM 滚动跟随的单一 adapter：只观察聊天内容和 viewport 的 ResizeObserver 将变化合并到 animation frame，先读取几何信息再按跟随状态写滚动位置；手动阅读不强拉到底，支持回到最新及定位本聊天范围内的原卡片。工作区另有独立滚动容器，不用全页滚动驱动聊天执行。

`view/assistant-markdown.tsx` 的 `AssistantMarkdown` 与 `view/conversation-messages.tsx` 的 `MessageRow` 使用 memo，历史 Markdown 与实时增量共用安全渲染但保持独立更新边界。Motion 通过共享主题统一尊重减少动态效果，只做导航选中等局部反馈；无全页进入位移，首屏正文不等待动画，动画不控制请求、恢复资格或完成状态。这些是实现结构与约束，不是性能改善或检查通过的证据；同负载测量、真实路由往返、长历史/节点定位与 SSE/输入并发的取证方法见[持续对话与工作区方案](../demo/desktop-experience-plan.md)。

### 批准、效果与错误

文档审阅为可深链完整页面，展示完整 before/after、`exact_new_content`、版本及冻结 `preview.body`。确认由 `documentConfirmBody` 直接取原字符串为 `seen_content`，不 trim、不从 DOM/diff/摘要重新生成；排版只展示，不改变提交内容。批准只授权，不 apply、不自动 resume；用户回原 Run 读取资格后显式继续。`can_resume=false` 仅表示当前不可继续，不能一概解释为尚未批准。

授权、Run 和效果分别读取，非原子快照：approved/not_started 不称保存；reserved 为结果待确认；applied 不称全文核对；verified 才显示保存并核对。unknown 可能已写入，不提供盲重做；取消不撤回已发生效果。模型回复不充当工具回执或进度证据。

真实受保护 HTTP 401 引导安全站内返回的正式重登，返回只 GET；403 保留权限/CSRF 含义，不跳登录掩盖；404 不假报空集合；网络/503 不擅自命名为模型缺配置，仅有明确领域 code 才解释具体依赖原因。局部失败保留成功内容和诊断，不自动重放副作用。

账户复用原认证、Cookie/CSRF 与原 owner；只有核验的 `setup_required` 才开放初始化。建号/转正后的 `pending_local_configuration` 不代表工作区或模型就绪；本机登记与重载经原安装 `local:account` 完成，不重建身份、root 或秘密，退出以服务端撤销为准。使用步骤见 [Web 使用说明](../../apps/web/README.md) 与[本机指南](../guides/local-lifecycle.md)。

上述为源码职责和使用合同，不是验收结论。受控 HTTP 页面证据不能证明正式安装、真实模型、唯一文件写入或新全文回读闭环；这些须在同一受支持原安装单独取证，不用临时配置或夹具代替。

## 引用

- B00 总览、B03 架构、B05 路线图、B06 v0-spec §4/§12；AF §2–§7。
