# 02. 模块化单体与拆分触发器设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：v0 模块清单与所有权、自有 schema/outbox 约定、B03 十服务逐项拆分裁决、拆分触发指标 a–d
- **不包含**：技术栈选型（见 01）、API 路由表（见 10）、表字段明细（见 schema 组）、Spike 标准（见 11）
- **阶段标签**：v0 单体写实；P1 起五缝接口化；拆分按本篇触发指标逐个裁决

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. v0 模块清单（写实，Required）

TS 模块化单体（`apps/api` 内按模块分目录，单镜像 `api|worker|all` 三角色运行）。

| 模块 | 职责 | 所有者（逻辑） | 自有 schema（PG） | 对外接口（P1 起全接口化） |
| --- | --- | --- | --- | --- |
| identity | `GET /me`、会话 actor、Better Auth 集成（Deferred 二选一 P0 定） | identity | `users`、`sessions`（字段 Deferred，不猜） | 内部函数；拆分后为 Auth 服务 |
| conversations | 对话消息写入、`POST /conversations/messages` SSE 流、`GET /conversations/{id}` | conversations | `conversations`、`conversation_messages` | 内部函数 |
| agent-runtime | TsAgentRuntime：run/resume/cancel → AgentEvent（见 09） | agent-runtime | `agent_runs`、`run_attempts`、`run_checkpoints` | `AgentRuntime.run/resume/cancel`（P1 接口化） |
| briefs | `GET /brief`：简报组装（v0 为确定性组装，非 LLM 自由生成） | briefs | 无自有写表（只读 tasks/approvals 投影）；缓存 Deferred | 内部函数 |
| approvals | 确认门：pending→consumed/rejected/expired/superseded；消费+建 Task 同事务（唯一跨模块事务） | approvals | `approvals`（含 `presentation_hash`、`presentation_version`） | P1 接口化（CRUD + consume） |
| tasks | 调度事实：saved→pending_schedule→scheduled→fired/missed；cancel_pending→cancelled；`UNIQUE(task_id,fire_at)`；`task_events` 只追加 | tasks | `tasks`、`task_events`（DB 禁 UPDATE/DELETE） | `Scheduler.schedule/claim/cancel`（P1 接口化） |
| notifications | send→回执+幂等；06 喝水提醒降级为本模块子用例（`task.kind=notify_only`，不走 LLM 先验调度） | notifications | `notifications`（含幂等键、`provider_receipt`） | `Notifier.send`（P1 接口化） |
| tool-gateway | 白名单+zod+风险分级+审计（v0 本地工具版） | tool-gateway | `tool_calls`（审计）、`tool_allowlist` | `ToolGateway.invoke`（P1 接口化） |
| connector-vault | secret 引用不出明文（v0 仅接口 + Fake） | connector-vault | `connector_secrets`（只存引用 `secret://…`） | P1 接口化 |
| time-core | 纯函数 `normalize(wall_time,timezone_id,fold_choice,ruleset)`；LLM 不算时间，展示层不换算 | time-core（零依赖） | 无表（`tzdb_version` 以常量+迁移声明） | 纯函数调用 |
| outbox（横切） | 领域事件外发：`outbox`（DB 事务内写，worker claimer 投递；旧名 `outbox_events` 作废，S0 #14 冻结） | 各模块自写、worker 投递 | `outbox` | 内部 + 契约测试 |

### 所有权表（Required）

- 每个模块目录即所有权边界：`apps/api/src/modules/<name>/` 下含 `routes.ts`、`service.ts`、`schema.ts`（自有表 zod+迁移）、`outbox.ts`、`contracts.test.ts`。
- 跨模块只传 `id`（Required）：如 `approval.consumed_task_id`、`task.approval_id`、`notification.task_id`；禁止跨模块直读对方表（join 写在读取侧投影，不写在写入侧事务）。
- 唯一跨模块事务（Required）：Approval 消费 + Task 创建同事务；其余一律经 outbox 最终一致。

## 2. 模块自有 schema / outbox 约定（Required）

1. 一模块一 schema 前缀，迁移文件按模块命名（`infra/migrations/<seq>_<module>_*.sql`）。
2. 写侧只写自有表；读侧可读他人表做投影，但必须标注 `[跨模块读]` 且经 `contracts` zod 类型。
3. 所有跨模块副作用经 outbox 领域事件：`{event_id, aggregate, aggregate_id, type, payload, occurred_at, request_id, idempotency_key}`；worker claim 后投递，投递幂等（见 10）。
4. `contracts` 契约测试进程内/远程跑同一套（Required）：同一 `contracts.test.ts` 在 `ROLE=all` 进程内跑与拆分后 HTTP 跑断言一致。

## 3. 拆分判据 a–d（Required，量化触发指标）

任一判据命中即启动拆分评审；评审结论只能是拆/不拆/延后，不降级。

| 判据 | 定义 | 触发指标（任一命中即评审） |
| --- | --- | --- |
| a. 故障隔离 | 单模块故障不应拖垮登录/会话/简报读路径 | 该模块 P1 错误预算连续 2 周耗尽；或单次故障导致 `/me`、`GET /brief` 可用性 < 99.5%（周窗口） |
| b. 负载特征分叉 | CPU/内存/耗时分布与其他模块显著不同 | p95 延迟连续 2 周 > 2× 单体中位数；或内存/耗时波动系数（p99/p50）> 5 且与推理/投递强相关 |
| c. 发版节奏分叉 | 某模块发版频率或回滚率显著高于整体 | 该模块变更占全量发版 > 50% 连续 4 周；或其回滚次数 > 其余模块总和 |
| d. 安全/合规边界 | secret、鉴权、审计需要独立进程/权限面 | 需要独立 Secret 访问面；或审计要求独立只读库/独立留存策略；或 pen-test 要求缩小信任边界 |

评审输出：拆分方案（接口契约= P1 接口原样 HTTP 化）、数据归属（表随模块走）、回滚计划、`/readyz` 类型化错误清单增补。

## 4. B03 十服务逐项裁决（Observed B03§2 → 裁决，Required）

| B03 服务 | 裁决 | 理由与触发指标映射 |
| --- | --- | --- |
| Web 前端 | P0 即独立（`apps/web`） | 迭代最快、独立发版；Electron 套壳同一份 Next.js |
| API 网关/BFF | v0 为单体内路由层，不独立进程 | 统一 envelope/幂等/SSE 聚合；命中判据 b（SSE 长连接 p95 分叉）再拆为网关角色 |
| 用户与鉴权 auth | 最早可拆（首个拆分候选） | 安全边界（判据 d）；触发：需独立 Secret 面或合规要求，或 auth 发版占比 > 50%（判据 c） |
| 会话服务 | 永不拆（合并入 conversations/identity） | 对话状态唯一 owner 拆出去只增分布式事务；除非判据 a 命中且证明会话读是瓶颈，否则不拆 |
| Agent 编排（TS 侧 TsAgentRuntime） | 首个业务拆分候选 | 推理长耗时、有状态 loop（Observed B04§1）；触发：判据 b（p95/波动分叉）或判据 a（拖垮读路径） |
| 工具网关 | P1 接口化，P2+ 可独立 | 风险收口点；触发：判据 d（MCP 外部进程隔离）或判据 b（外部工具延迟分叉） |
| 记忆服务 | v0 不做；P2+ 按需 | 读写策略复杂独立演进（Observed B03§2）；触发前置：记忆检索 p95 成为对话延迟主因 |
| 知识库 RAG | 不做（v0/v1 均不做） | 疼还没到（B06§11）；触发：有真实检索需求且 pgvector 方案验证通过后另行立项 |
| 任务调度 Scheduler | P1 接口化；独立进程候选（worker 角色先行） | 主动能力发动机；触发：判据 b（claim 轮询/长任务与 api 延迟分叉）或错过率（missed）与 api 发版强相关 |
| 通知推送 Notifier | P1 接口化；渠道增多时拆 | 触达渠道多变（Observed B03§2）；触发：判据 c（渠道适配发版占比）或判据 d（推送凭证独立面） |
| media-pipeline | P4（远期），本文档只留名 | 录音/多媒体链路；v0–P3 无表、无接口 |
| sandbox | P5（远期），本文档只留名 | 任意代码执行/浏览进隔离；MVP 直接不给这类工具（Observed B03§7）；触发：首个需执行不可信代码的工具立项 |

## 5. 拆分执行顺序（Proposed）

`auth（d 先行）→ agent-runtime（b 首个业务拆）→ scheduler worker（b）→ tool-gateway（d/b）→ notifier（c）`；会话永不拆；RAG 不做；media-pipeline P4 / sandbox P5 只留名。

## 引用

- B03§1–§7、B05、B06§11；AF§5（单镜像三角色、三硬约束）。
