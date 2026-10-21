# Schema 设计索引

> 状态：v0 可开工（design 真源，prd 跟随）。范围：Postgres 表结构约定的字段/约束/索引/写入规则，不含迁移 SQL 与 ORM 实现。不包含：具体 DDL、API DTO、鉴权方案选型、计费/推送供应商字段。阶段标签：v0 MVP 全链路；P1 起五缝接口化。

## 落地顺序

推荐 migration 落地顺序（v0）[Required]：

1. Identity 表（`users`、`sessions`，随 Better Auth Deferred 方案二选一 P0 定）。
2. Conversation / Runs 表（`conversations`、`messages`、`agent_runs`、`run_attempts`、`run_checkpoints`、`conversation_idempotency`、`tool_calls`、`agent_revisions`、`prompt_versions`）。
3. Commitments 表（`approvals`、`approval_revision_requests`、`tasks`、`task_events`、`outbox`、`notifications`、`task_leases`、`security_events`；统一 `outbox` 名，修改预约归 approvals）。

Content 表（`briefs`、`cards`）为 v1 / Deferred，移出 v0 落地顺序（S0 #14 冻结：v0 简报为只读投影，不建表；详见 [content-schema.md](content-schema.md)）。

原因 [Required]：

- 全业务表依赖 `users.id`（`owner_id`），identity 最先。
- Conversation / Runs 是对话与执行存档底座，commitments 引用 `conversation_id` / `run_id`。
- Commitments 含状态机与 outbox；P1 content（`briefs`/`cards`，只读投影，见 `docs/api/brief/brief_routes.md`）依赖 commitments，移出 v0 不阻塞主链路。

| 分组                              | 文档                                                               | 表                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity                          | [identity-schema.md](identity-schema.md)                           | `users`、`sessions`                                                                                                                                          |
| Conversation / Runs               | [conversation-and-runs-schema.md](conversation-and-runs-schema.md) | `conversations`、`messages`、`agent_runs`、`run_attempts`、`run_checkpoints`、`conversation_idempotency`、`tool_calls`、`agent_revisions`、`prompt_versions` |
| Commitments                       | [commitments-schema.md](commitments-schema.md)                     | `approvals`、`approval_revision_requests`、`tasks`、`task_events`、`outbox`、`notifications`、`task_leases`、`security_events`                               |
| Content（v1 / Deferred，移出 v0） | [content-schema.md](content-schema.md)                             | `briefs`、`cards`                                                                                                                                            |

引用：落地顺序对应 B03 微服务下沉原则与 B06 建表顺序（P3 vertical 切片）[B03][B06]。

## Enum 策略

[Required] PostgreSQL enum 改值成本高，初版统一：

- 全部状态/类型/渠道字段用 `text`，约束说明写“按某某值约束”，落地用 `text + check constraint` 或 service 层校验。
- 受约束的值集合：`task.state` 按 `saved/pending_schedule/scheduled/fired/missed/cancel_pending/cancelled` 约束；`approval.state` 按 `pending/consumed/rejected/expired/superseded` 约束；`task.kind` 按 `notify_only/...` 约束（v0 仅 `notify_only`，其余 Deferred）；`notification.channel` 按 `inapp` 约束（Web Push 仅兜底，Deferred）；`outbox.status` 按 `pending/dispatched/acked_unknown/superseded/failed_deadline` 约束（以 commitments 篇为准）。
- 稳定后如需收紧，再以后续 migration 加 check 约束，不直接改 enum 类型。

## 外键与模块边界

[Required]：

- 模块自有 schema，跨模块只传 id，不跨模块建强 FK。允许的逻辑引用：`tasks.source_approval_id → approvals.id`、`task_events.task_id → tasks.id`、`briefs/cards → task_id/approval_id`，落地时本模块内 FK，跨模块仅逻辑引用 + 应用层校验。
- 历史/审计/事件类表 `on delete restrict` 或禁止删除；主对象删除不级联删历史。
- 避免双向 nullable 外键与循环 FK。`tasks.recreated_from_task_id` 自引用单向 nullable unique，不建反向引用。
- `users` 删除：[Proposed] 禁止物理删除用户行（关联账不可断）；注销以状态标记 + 数据清理流程处理（Deferred，P1 后定）。

## Append-only 与不可变约定

[Required]：

- `task_events` 只追加：DB 禁 `UPDATE`/`DELETE`（trigger 落地，0005 `task_events_no_update_delete`）。
- `agent_revisions`、`prompt_versions` 不可变：建后禁 `UPDATE`/`DELETE`（trigger 落地，0002；错了发新 revision/version）；`run_checkpoints` 只追加（trigger 落地，0002）；`tool_calls` 审计行随 #9 ToolGateway 落表，复用同一 trigger 形状。
- `tasks` 除 `state` / `state_version` 外建后冻结；改时间必须走新 task（先断旧再立新，`recreated_from_task_id` 链接）。
- `approvals` 消费后冻结；`consumed` 后任何字段禁改。
- `outbox` 写后仅允许 `status`/`attempt_no` 流转更新，业务字段禁改。

## 软删与保留

[Required]：

- 事件账（`task_events`）、`outbox` 已发送记录不删。
- `tasks` 取消为终态，不删除；一年后归档流程 Deferred。
- `approvals` 过期按 B06 墓碑语义：清内容留号 30 天（`original_text` 置空保留行）。
- 真实物理删除只允许本地开发或明确维护脚本。

## 敏感信息

[Required]：

- 不保存真实 secret、token、cookie、session 明文、口令、数据库连接串、完整敏感工具参数。
- 需保存敏感配置时保存 `secret://...` 引用（ConnectorVault，v0 仅接口 + Fake，见 design 五缝）。
- API、日志、测试断言、通知 payload 不得输出敏感值原文。
- 完整模型推理链、完整 provider 原始响应、大规模网页快照不进 v0 主线。
- 本目录及 references 下不得复制外部产物 token/DSN/常量。

## owner_id 与多租户约定

[Required]：

- 除 `users` 外全业务表带 `owner_id`（`uuid`，not null，逻辑引用 `users.id`）。
- 所有查询必带 `owner_id = :owner_id`；服务端鉴权后注入，不信任客户端传入。
- 索引：高频表建 `(owner_id, created_at desc)` 或 `(owner_id, state)` 复合索引，详见各篇。

## 时间字段约定

[Required]：

- 触发依据一律 `fire_at_utc`（`timestamptz`）；墙上时间 `wall_time`（`text` 或 `timestamp` 无时区，精确到秒）+ `timezone_id`（IANA 文本）+ `fold` + `resolved_utc_offset_seconds` + `tzdb_version` 同时存（存摆分家，见 B06 §3.7）。
- “明天”= 服务端首次接收时刻 + 已确认时区解析一次并冻结，不再重算 [B06]。
- time-core 为 TS 服务端纯函数 `normalize(wall_time, timezone_id, fold_choice, ruleset)`，LLM 不算时间，展示层不换算（详见 design time-core）。

## 状态机速览（详情见 commitments 篇）

- task：`saved → pending_schedule → scheduled → fired | missed`；`saved/pending_schedule/scheduled → cancel_pending → cancelled`。
- approval：`pending → consumed | rejected | expired | superseded`。
- 唯一跨模块事务：approval 消费 + task 创建同事务；其余跨模块经 outbox。
