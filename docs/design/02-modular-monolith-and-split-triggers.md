# 02. 模块化单体与拆分触发器设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：v0 模块清单与所有权、自有 schema/outbox 约定、B03 十服务逐项拆分裁决、拆分触发指标 a–d
- **不包含**：技术栈选型（见 01）、API 路由表（见 10）、表字段明细（见 schema 组）、Spike 标准（见 11）
- **阶段标签**：v0 TS 单体；R1 仓颉 Harness 边界单独接入；业务模块拆分仍按证据裁决，不强制全模块远程化

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. 模块职责（Observed 现状与 Required 目标分列）

TS 模块化单体（`apps/api` 内按模块分目录，单镜像 `api|worker|all` 三角色运行）。

| 模块               | 职责                                                                                                                               | 所有者（逻辑）                       | 自有 schema（PG）                                            | 对外接口（P1 起全接口化）                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| identity           | `GET /me`、会话 actor、Better Auth 集成（Deferred 二选一 P0 定）                                                                   | identity                             | `users`、`sessions`（字段 Deferred，不猜）                   | 内部函数；拆分后为 Auth 服务                          |
| conversations      | 对话消息写入、`POST /conversations/messages` SSE 流、`GET /conversations/{id}`                                                     | conversations                        | `conversations`、`conversation_messages`                     | 内部函数                                              |
| Harness / Run 存储 | [Required] 仓颉负责唯一 Agent 循环；[Observed] v0 确定性 turn 与消息/Run/事件存储在 conversations                                  | 仓颉执行控制；TS conversations 存储  | `agent_runs`、`run_attempts`、`run_checkpoints` 继续 TS 所有 | run/resume/cancel 为目标语义，非现有远程 API（见 09） |
| briefs             | `GET /brief`：简报组装（v0 为确定性组装，非 LLM 自由生成）                                                                         | briefs                               | 无自有写表（只读 tasks/approvals 投影）；缓存 Deferred       | 内部函数                                              |
| approvals          | 确认门、显式修改的唯一后继及持久幂等；消费批准与创建任务或取消请求同事务                                                           | approvals；取消规则归 tasks 公共用例 | `approvals`、`approval_revision_requests`                    | 确认用例，不开放跨模块存储导入                        |
| tasks              | 调度事实：saved→pending_schedule→scheduled→fired/missed；cancel_pending→cancelled；`UNIQUE(task_id,fire_at)`；`task_events` 只追加 | tasks                                | `tasks`、`task_events`（DB 禁 UPDATE/DELETE）                | `Scheduler.schedule/claim/cancel`（P1 接口化）        |
| notifications      | send→回执+幂等；06 喝水提醒降级为本模块子用例（`task.kind=notify_only`，不走 LLM 先验调度）                                        | notifications                        | `notifications`（含幂等键、`provider_receipt`）              | `Notifier.send`（P1 接口化）                          |
| tool-gateway       | 白名单、strict zod、逻辑调用身份、接受结果与只追加审计；本地工具不直接建 task                                                      | tools                                | `tool_invocations`（身份/结果）、`tool_calls`（审计）        | 预约与执行公共函数；跨语言消费合同见 09               |
| connector-vault    | secret 引用不出明文（v0 仅接口 + Fake）                                                                                            | connector-vault                      | `connector_secrets`（只存引用 `secret://…`）                 | P1 接口化                                             |
| time-core          | 纯函数 `normalize(wall_time,timezone_id,fold_choice,ruleset)`；LLM 不算时间，展示层不换算                                          | time-core（零依赖）                  | 无表（`tzdb_version` 以常量+迁移声明）                       | 纯函数调用                                            |
| outbox（横切）     | 领域事件外发：`outbox`（DB 事务内写，worker claimer 投递；旧名 `outbox_events` 作废，S0 #14 冻结）                                 | 各模块自写、worker 投递              | `outbox`                                                     | 内部 + 契约测试                                       |

### 所有权表（Required）

- [Required] 目录表达规则所有权，沿现有具体函数、service/repository 组织；不强制每模块生成 routes/schema/outbox/接口的空壳层。
- [Required] ID-first 约束身份与资源关联（如 task/approval/run ID），不是禁止 DTO：公共用例可接收显式参数并返回只读投影。写侧不任意操作他人表；跨模块读取优先所属模块公共入口，明确只读投影可在读取侧 join 并保留 owner 过滤。
- [Required] 受控跨模块写事务是确认消费：创建批准消费 + task/created/outbox；取消批准消费 + tasks 公共取消用例的状态/事件/取消命令与旧工作失效。不得为旧“只有创建例外”的文字拆开取消事务；失败全回滚，撤销回执仍由 tasks 裁决。
- [Required] 本地工具提议是另一项限定原子边界：tools 持有调用引用，经 conversations 公共用例锁定执行资格，同一 client 调用 approvals 创建/取得批准，再接受结果并追加审计；任一步失败全部回滚。此事务不消费批准、不建 task，也不把任意外部副作用纳入 PG 原子性；具体合同见 04 §3、06 §10。
- [Observed] `conversations/service.ts` 同步调用 `tools/gateway.ts`；`tasks/service.ts#getTaskDetail` 同步调用 `notifications/service.ts#getTaskNotifications` 返回 DTO。这些公共调用不经 outbox，通知读取也不创建副作用。

## 2. 模块自有 schema / outbox 约定（Required）

1. [Required] 表/迁移按领域归属管理；现有物理布局以已合并迁移为准，不为文档对齐改迁移。
2. [Required] 写入规则归所属模块；只读投影必须明确跨模块来源、owner 范围和输出契约，不把存储行当可写共享对象。受控事务沿 §1，不是任意跨模块事务豁免。
3. [Required] 需要事务后可靠异步执行的命令/领域事件（如 schedule/cancel/send）在业务事务内写 outbox，由 worker claim、核对版本和回执；不是所有同步用例、读取、流事件和工具请求都改 outbox。幂等投递不证明任意外部效果恰好一次。
4. [Required] 真实新增/变化的跨进程合同在既有 contracts-dual 入口验证；[Observed] 当前 D8 是最小 healthz 双跑/partial，不证明仓颉合同已通过。

### D1 与 SQL 所有权（Observed / Required）

`.dependency-cruiser.cjs` 动态发现模块，禁止跨模块导入 repository/schema 等存储实现（含 type import），允许公共函数调用；它不解析 SQL，不证明表所有权或 owner 过滤完整。`tools/gateway.ts#runGetUserPrefs` 仍直接查询 users，这是现存边界债务，不是新增写侧直读许可。触及相关能力时向所属公共用例/明确只读投影归位；SQL 表归属、owner、锁与事务范围仍需人工审查和行为测试，不用 D1 绿色代替。

## 3. 拆分判据 a–d（Required，量化触发指标）

任一判据命中即启动拆分评审；评审结论只能是拆/不拆/延后，不降级。

| 判据             | 定义                                   | 触发指标（任一命中即评审）                                                                   |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| a. 故障隔离      | 单模块故障不应拖垮登录/会话/简报读路径 | 该模块 P1 错误预算连续 2 周耗尽；或单次故障导致 `/me`、`GET /brief` 可用性 < 99.5%（周窗口） |
| b. 负载特征分叉  | CPU/内存/耗时分布与其他模块显著不同    | p95 延迟连续 2 周 > 2× 单体中位数；或内存/耗时波动系数（p99/p50）> 5 且与推理/投递强相关     |
| c. 发版节奏分叉  | 某模块发版频率或回滚率显著高于整体     | 该模块变更占全量发版 > 50% 连续 4 周；或其回滚次数 > 其余模块总和                            |
| d. 安全/合规边界 | secret、鉴权、审计需要独立进程/权限面  | 需要独立 Secret 访问面；或审计要求独立只读库/独立留存策略；或 pen-test 要求缩小信任边界      |

评审输出：拆分方案（接口契约= P1 接口原样 HTTP 化）、数据归属（表随模块走）、回滚计划、`/readyz` 类型化错误清单增补。

## 4. B03 十服务逐项裁决（Observed B03§2 → 裁决，Required）

| B03 服务                   | 裁决                                         | 理由与触发指标映射                                                                                    |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Web 前端                   | P0 即独立（`apps/web`）                      | 迭代最快、独立发版；Electron 套壳同一份 Next.js                                                       |
| API 网关/BFF               | v0 为单体内路由层，不独立进程                | 统一 envelope/幂等/SSE 聚合；命中判据 b（SSE 长连接 p95 分叉）再拆为网关角色                          |
| 用户与鉴权 auth            | 最早可拆（首个拆分候选）                     | 安全边界（判据 d）；触发：需独立 Secret 面或合规要求，或 auth 发版占比 > 50%（判据 c）                |
| 会话服务                   | 永不拆（合并入 conversations/identity）      | 对话状态唯一 owner 拆出去只增分布式事务；除非判据 a 命中且证明会话读是瓶颈，否则不拆                  |
| Agent 编排（仓颉 Harness） | R1 已确定的语言边界，不是 TS 第二 Agent 拆分 | TS 长期保留 API/worker/业务与存储；仅 Harness 跨进程，不据此拆全部模块                                |
| 工具网关                   | P1 接口化，P2+ 可独立                        | 风险收口点；触发：判据 d（MCP 外部进程隔离）或判据 b（外部工具延迟分叉）                              |
| 记忆服务                   | v0 不做；P2+ 按需                            | 读写策略复杂独立演进（Observed B03§2）；触发前置：记忆检索 p95 成为对话延迟主因                       |
| 知识库 RAG                 | 不做（v0/v1 均不做）                         | 疼还没到（B06§11）；触发：有真实检索需求且 pgvector 方案验证通过后另行立项                            |
| 任务调度 Scheduler         | P1 接口化；独立进程候选（worker 角色先行）   | 主动能力发动机；触发：判据 b（claim 轮询/长任务与 api 延迟分叉）或错过率（missed）与 api 发版强相关   |
| 通知推送 Notifier          | P1 接口化；渠道增多时拆                      | 触达渠道多变（Observed B03§2）；触发：判据 c（渠道适配发版占比）或判据 d（推送凭证独立面）            |
| media-pipeline             | P4（远期），本文档只留名                     | 录音/多媒体链路；v0–P3 无表、无接口                                                                   |
| sandbox                    | P5（远期），本文档只留名                     | 任意代码执行/浏览进隔离；MVP 直接不给这类工具（Observed B03§7）；触发：首个需执行不可信代码的工具立项 |

## 5. 拆分执行顺序（Proposed）

TS 业务拆分仍按 a–d 证据逐项评审；仓颉 Harness 由已确定语言分工接入，不等待“TS Agent 拆出”或要求 TS 后端退役。旧 P 阶段不作为 R1 实现完成证据。

## 引用

- B03§1–§7、B05、B06§11；AF§5（单镜像三角色、三硬约束）。
