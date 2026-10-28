# PRD 索引与依赖链

> 状态：草案 / 范围：v0 MVP 全链路的产品需求入口，串起简报→活动账八步 / 不包含：路由表、表字段、状态机细节（见 api/schema）、实现代码 / 阶段：P1（v0）

## 依赖链（v0 唯一主链路）

- [Required] 八步按序推进，前一步未完成不得进入下一步（B06 §1–§2）：
- `简报`（GET /brief 聚合今日任务与待确认）→ `卡片`（任务/提议的结构化呈现）→ `对话`（POST /conversations/messages，SSE 流式）→ `提议`（Agent 产出待确认方案 + presentation 冻结）→ `确认`（approval confirm/reject，确认门一等公民）→ `调度`（Scheduler.schedule，拿回执才算已排期）→ `通知`（Notifier.send，到点 15 分钟内触发一次）→ `活动账`（task_events 只追加，用户可核对已记录步骤）。
- [Required] 确认门是唯一放行点：确认前不创建正式 task、不排期；草稿可留，钟不可进（B06 §2 总闸 1）。
- [Required] 确认消费与创建 Task/created/outbox 或与公共取消用例单事务；同步公共用例/显式 DTO/只读投影合法，可靠异步命令走 outbox，五缝不是所有模块唯一通道（design/02 §1–§2）。
- 该链路形态以自家可测指标为准。

## Required 列表（PRD 层硬约束）

- [Required] v0 切片 = 简报→卡片→对话→确认→调度→触发→通知→活动页，Web 单端；06 喝水提醒降级为调度子用例（task.kind=notify_only，不走 LLM 先验调度 + time-core）。
- [Required] v0 业务端点 13 个：GET /me；GET /brief；POST /conversations/messages（SSE）；GET /conversations/{id}；GET /approvals；GET /approvals/{id}；POST /approvals/{id}/actions/confirm；POST …/reject；POST …/revise（显式修改 pending 提议）；GET /tasks；GET /tasks/{id}；POST /tasks/{id}/actions/cancel；GET /tasks/{id}/events；另有探针 /healthz、/readyz（路由细节见 api）。
- [Required] task 状态机：saved→pending_schedule→scheduled（回执）→fired|missed，→cancel_pending→cancelled；approval：pending→consumed|rejected|expired|superseded。
- [Required] task_events 只追加（DB 禁 UPDATE/DELETE）；UNIQUE(task_id,fire_at)；recreated_from 唯一。
- [Required] 时间由服务端 time-core 纯函数 normalize 唯一确定；LLM 不算时间，展示层不换算；"明天" = 服务端首次接收时刻 + 已确认时区并冻结。
- [Required] 错误码口径 8 个：PRESENTATION_MISMATCH / APPROVAL_EXPIRED(410) / APPROVAL_SUPERSEDED / NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME（带两候选）/ TZDB_UNAVAILABLE / UNKNOWN_TIMEZONE / BUDGET_EXCEEDED。
- [Required] 对外只说已记录步骤，不承诺必达；取消后触发数 = 0 为一级指标；超 15 分钟标 missed 不补发。
- [Required] 实时对话 v0 用 SSE；WS + ws-ticket 自 P2 起；Web Push 仅兜底。
- [Required] Redis 延后；Postgres 唯一事实源；单镜像 api|worker|all。
- [Required] Web：Next.js App Router，保留 RSC/Turbopack 默认边界；R1 蓝墨任务书桌采用 shadcn/ui new-york、Radix primitives、Tailwind CSS v4，功能 View/controller/data 分责，全站入口与原批准/恢复合同见 [design/01 §6](../design/01-tech-stack-and-repo-structure.md#6-r1-web蓝墨任务书桌与职责边界)。Electron 套壳在后。
- [Required] 鉴权：Better Auth 自建 credential（D7 空环境冒烟不依赖外部 IdP；v0 单租户）；v0 端点只暴露 `GET /me`。
- [Required] 仓颉唯一宿主 Harness（模型/工具循环、当前上下文、计划、预算、等待/恢复/停止）；TS 长期保留工具/业务/worker/API/Web 与 Run 存储。R1 未实现，不迁移整个 TS 后端，也不在 TS 工具内藏第二 Agent（design/09/11、ADR 0009）。

## 本目录导读

| 文档                                                          | 回答的问题                                    |
| ------------------------------------------------------------- | --------------------------------------------- |
| [01 概览与范围](01-overview-and-scope.md)                     | 做什么、不做什么、P0–P5 切片、差异化三点      |
| [02 核心循环与页面](02-core-loop-and-pages.md)                | 八步闭环、R1 全站资源入口、精确批准与只读恢复 |
| [03 风险约束与阶段门](03-risk-constraints-and-stage-gates.md) | 怕什么、量什么、何时准入准出、对外怎么说      |
| [04 验收与待决事项](04-acceptance-open-questions.md)          | v0 如何算过、哪些事延后、什么条件重开         |

## 与 design 的关系

- design 为真源、prd 跟随：本目录任何表述与 design 冲突时，以 design 为准并随后修订本目录。
- 本目录允许出现 Proposed（评审中方案）与 Deferred（延后事项）；design 真源层不收录未确认事项。
- 字段名、状态机、错误码以 api/schema 目录为准；本目录只保留产品语义可读的摘要。
