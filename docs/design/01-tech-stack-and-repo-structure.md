# 01. 技术栈与仓库结构设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：服务端/前端技术栈选型（已确认 vs 待定）、monorepo 布局、包依赖方向、复用优先级
- **不包含**：模块拆分判据（见 02）、API 路由表（见 10）、表字段（见 schema 组）、Spike 细节（见 11）、CI 死规矩实现（见 13）
- **阶段标签**：v0 TS 业务基线；R1 起仓颉唯一 Harness + 长期 TS 能力层（不是全后端迁移）

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
        main.ts             # ROLE=api|worker|all 分发
        http/               # HTTP 入口、认证与 SSE 响应
        modules/            # conversations/tools/业务模块与存储
        worker/             # Scheduler claim/lease/fencing + Notifier 投递
    web/                    # Next.js App Router（Web 先行；后被 Electron 套同一份）
      src/app/              # Next.js 页面
      src/lib/              # HTTP 客户端与展示辅助
      vendor/               # 按上游 commit 固定的 LumenUI 官方分发包
      src/features/         # 对话、批准、提醒与账户的功能 View/controller
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

[Observed] 对话运行、ToolGateway 与业务存储在 `apps/api/src/modules/conversations|tools|approvals|tasks|notifications|identity|time|brief`，不是独立 `agent-runtime` 包。上图为关键目录摘要，不要求每个模块建立同名空壳层。

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

组件从 `@lorelum/lumen-ui/components/*` 直接导入，采用单套 Base UI 底层，不保留 Radix 或本地 shadcn 基础组件副本。包由上游官方构建和打包入口生成，固定源码 commit、包 SHA-256 与单一 bun.lock；分发包随 Web 源码保留，冻结安装与 Docker 构建不依赖私有 GitHub 登录或在线发布。`postcss.config.mjs` 使用 `@tailwindcss/postcss`，`src/app/globals.css` 导入 Tailwind v4、官方 theme.css 并扫描包内样式；LumenProvider 统一页面与 portal 的默认 Linen 主题。布局和业务状态由应用拥有；控件与面板直接使用库原生玻璃材质，不新增主题 token、surface slot 样式或手工模糊/阴影，不用 CSS 仿造库外效果。对话独立 loading 保持对话栏、消息区与底部输入布局，不借用首页骨架。RSC 仍负责页面组装，交互组件按实际需要进入 Client 边界；菜单与离开确认迁移须保留键盘、焦点和活动 SSE 保护。现代浏览器基线随 Tailwind v4（Chrome 111+、Safari 16.4+、Firefox 128+）；窄屏布局不意味着支持旧浏览器。

### 页面与资源入口

- 桌面和窄屏共用顶部导航：「助理」进入对话 `/conversations`；「事项」菜单收纳今日安排 `/`、我的提醒 `/tasks`、待我确认 `/approvals` 和活动记录 `/activity`；账户 `/account` 放独立头像菜单。首页以开始对话为主，提醒/资料为次级入口，今日简报按需展开。登录 `/login` 只常驻必要字段与动作，帮助说明收纳；首次建号 `/setup`、原身份转正 `/claim`、退出 `/logout` 保留各自确认与保护。品牌回首页，提供跳到正文入口，不将资源链接并排铺成一层。
- 对话默认使用已有无 workspace 的 `harness`；居中消息区独立滚动，输入框常驻视口底部，同一会话可以明确发起下一轮。提醒/资料工具位于输入框左侧「＋」菜单并可移除，分别固定 `business` / `harness`；`intent=reminder|document` 只预选新消息表单，身份 query 优先。选择、填写、切换目标不发送；资料必须显式选择读取成功的登记，不默选首项、不接受任意宿主 root。完整可读/可写相对范围与受管副本说明按需展开，空登记与读取失败分开；无写范围可执行只读资料任务。
- 会话按建立时间发现，沿原 `conversation_id/run_id` 深链读取连续消息、多个 Run、批准和效果；消息档案不猜与某 Run 的对应，不重复拼接同一回复的流式与最终存储文本。主动执行、批准挂起、发送结果或工具效果未知时保留输入及真实原因，不允许新发送绕过原运行；历史恢复只 GET，下一轮必须明确发送。文档批准从原 Run 进入 `/document-approvals/{id}`，不伪造文档批准集合。提醒确认与提醒任务不冒充资料历史；活动是任务范围索引与选中任务的事件账，不是全局 Agent 审计。
- 会话、消息、事件、提醒确认、任务及活动相关分页沿各自服务端游标 GET，保留先前获取的内容、局部错误和未推进游标。打开、展开、刷新、回退与重登恢复均不自动发业务 POST，不宣称首批或已加载范围为全量。

### Server / Client / controller / data

| 边界                                     | 职责                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app` 的 page/layout（Server Component） | 解析路由身份、服务端读取和页面组装；不因共享布局或交互组件而将全站客户端化                                                                                                                                   |
| Client View / 基础组件                   | 底部输入、工具菜单、保留阅读位置的聊天滚动、安全 Markdown、完整审阅、焦点与展开；例如 `task-views.tsx`，不编排执行生命周期                                                                                   |
| 功能 controller/hook                     | `use-conversation-task.ts` 归属发送、原 Run SSE、GET、继续/取消在途及原幂等键；历史分页独立，文档决议由 `useDocumentApproval` 归属，提醒与账户操作各有独立控制                                               |
| 数据访问与纯投影                         | `lib/api.ts` 服务端 HTTP，`conversation-run.ts` 传输/解析/事件聚合，`document-loop.ts` 精确批准与效果投影，功能数据模块负责对应只读分页；复用 contracts/stream-protocol，不导入 API 私有实现、不复制领域授权 |

URL 拥有选中资源身份；controller 清理所属 GET/SSE，隔离迟到响应。继续绑定原 Run/checkpoint/请求键，取消以服务端事实为准，断开连接不等于成功取消或回滚既成效果。活动连接的离开语义沿原取消合同，不承诺后台继续；批准链接独立新标签，避免因审阅提前断开原流。

### 批准、效果与错误

文档审阅为可深链完整页面，展示完整 before/after、`exact_new_content`、版本及冻结 `preview.body`。确认由 `documentConfirmBody` 直接取原字符串为 `seen_content`，不 trim、不从 DOM/diff/摘要重新生成；排版只展示，不改变提交内容。批准只授权，不 apply、不自动 resume；用户回原 Run 读取资格后显式继续。`can_resume=false` 仅表示当前不可继续，不能一概解释为尚未批准。

授权、Run 和效果分别读取，非原子快照：approved/not_started 不称保存；reserved 为结果待确认；applied 不称全文核对；verified 才显示保存并核对。unknown 可能已写入，不提供盲重做；取消不撤回已发生效果。模型回复不充当工具回执或进度证据。

真实受保护 HTTP 401 引导安全站内返回的正式重登，返回只 GET；403 保留权限/CSRF 含义，不跳登录掩盖；404 不假报空集合；网络/503 不擅自命名为模型缺配置，仅有明确领域 code 才解释具体依赖原因。局部失败保留成功内容和诊断，不自动重放副作用。

账户复用原认证、Cookie/CSRF 与原 owner；只有核验的 `setup_required` 才开放初始化。建号/转正后的 `pending_local_configuration` 不代表工作区或模型就绪；本机登记与重载经原安装 `local:account` 完成，不重建身份、root 或秘密，退出以服务端撤销为准。使用步骤见 [Web 使用说明](../../apps/web/README.md) 与[本机指南](../local-lifecycle.md)。

上述为源码职责和使用合同，不是验收结论。受控 HTTP 页面证据不能证明正式安装、真实模型、唯一文件写入或新全文回读闭环；这些须在同一受支持原安装单独取证，不用临时配置或夹具代替。

## 引用

- B00 总览、B03 架构、B05 路线图、B06 v0-spec §4/§12；AF §2–§7。
