# Schema 设计索引

> 状态：v0 可开工（design 真源，prd 跟随）。范围：Postgres 表结构约定的字段/约束/索引/写入规则，不含迁移 SQL 与 ORM 实现。不包含：具体 DDL、API DTO、鉴权方案选型、计费/推送供应商字段。阶段标签：v0 MVP 全链路；P1 起五缝接口化。

> Proposed 演进：新 profile/可信上下文/GoalResult/接续/执行占有归 conversations，新任务来源/time_basis归 tasks，真实偏好归 identity，登记集合/输出目录归 workspaces，接受结果仍归 tools；唯一详细合同见 [design/20 §4–§9](../design/20-goal-scoped-delegation.md)。只新增前向迁移，不改既有 migration 或回填旧授权；本规范不实施 DDL，不新增目标表、语义去重表或 briefs/cards 表。

> Proposed 受邀账户：准入、加密联系人、一次凭证代次、邀请、邮件投递与持久限流归 identity，详见 [identity schema](identity-schema.md) 与 [design/21](../design/21-invited-account-access.md)。它们不是已存在表或已分配迁移；旧 ID/auth_email/credential/secret/owner 保留，生产只经后续获准的前向迁移生效。

## 落地顺序

推荐 migration 落地顺序（v0）[Required]：

1. Identity 表（`users`、`sessions`、`auth_accounts`；Better Auth 自建 credential）。R1 `installation_admin` 与标准字段适配对应迁移 `0017_identity_account_access.sql`，字段和约束见 [identity-schema 的 R1 章节](identity-schema.md#r1-账户与安装绑定68)，升级与原身份保留证据见[账户验证记录](../verification/account-access-verification-2026-10-27.md)。
2. Conversation / Runs 表（`conversations`、`messages`、`agent_runs`、`run_attempts`、`run_checkpoints`、`conversation_idempotency`、`harness_resumes`、`harness_cancellations`、`tool_invocations`、`tool_calls`、`agent_revisions`、`prompt_versions`）；工具身份/结果归 tools，审计只追加。历史读取复用这些事实，`0018_conversation_history.sql` 仅增加四个非唯一查询索引，含旧原话回退路径的 `conversation_idempotency(run_id)`，结构核验见 `scripts/local/baselines/0018.sql`，投影边界见 [conversation schema](conversation-and-runs-schema.md#r1-历史读取投影与查询索引69)。
3. Commitments 表（`approvals`、`approval_revision_requests`、`tasks`、`task_events`、`outbox`、`notifications`、`task_leases`、`security_events`；统一 `outbox` 名，修改预约归 approvals）。

Content 表（`briefs`、`cards`）为 v1 / Deferred，移出 v0 落地顺序（S0 #14 冻结：v0 简报为只读投影，不建表；详见 [content-schema.md](content-schema.md)）。

原因 [Required]：

- 全业务表依赖 `users.id`（`owner_id`），identity 最先。
- Conversation / Runs 是对话与执行存档底座，commitments 引用 `conversation_id` / `run_id`。
- Commitments 含状态机与 outbox；P1 content（`briefs`/`cards`，只读投影，见 `docs/api/brief/brief_routes.md`）依赖 commitments，移出 v0 不阻塞主链路。

| 分组                              | 文档                                                               | 表                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                          | [identity-schema.md](identity-schema.md)                           | `users`、`sessions`、`auth_accounts`、`installation_admin`；`0024` 准入/加密联系人/邀请/挑战/邮件/持久配额/幂等键，不迁写原身份                         |
| Conversation / Runs               | [conversation-and-runs-schema.md](conversation-and-runs-schema.md) | 对话/消息、冻结 Run/attempt、只追加 checkpoint、conversation_idempotency、harness_resumes/cancellations、tool_invocations/calls、不可变 revision/prompt |
| Commitments                       | [commitments-schema.md](commitments-schema.md)                     | `approvals`、`approval_revision_requests`、`tasks`、`task_events`、`outbox`、`notifications`、`task_leases`、`security_events`                          |
| Documents（R1）                   | [design/14](../design/14-r1-document-task-loop.md)                 | `document_approvals`、`document_approval_decisions`；迁移 `0016`，归 approvals，不占 task 批准表                                                        |
| Content（v1 / Deferred，移出 v0） | [content-schema.md](content-schema.md)                             | `briefs`、`cards`                                                                                                                                       |

引用：落地顺序对应 B03 微服务下沉原则与 B06 建表顺序（P3 vertical 切片）[B03][B06]。

## R1 文档批准

- `0016_document_approvals.sql` 只新增文档批准和只追加决议账，不改旧迁移、已接受工具结果或历史 Run。发布顺序为停旧写者、迁移、同批发布 TS/native/Web。
- `document_approvals` 冻结 owner/conversation/Run、精确 workspace grant、相对目标、已接受全文读的 invocation、基线 SHA-256、确切新内容及其 SHA-256、完整预览和展示哈希。BOM、CRLF、空格均是原文内容，不在保存/确认时归一化。
- 授权状态仅 `pending → approved | rejected`，不可反转；完整展示及目标建后不可改。`apply_invocation_id` 唯一且一旦绑定不可换，`replaces_approval_id` 唯一且限同 owner/Run/工作区/目标的已批准已绑定前驱；后继还须由公共用例核验接受的零写冲突及后来的真实全文读。
- `document_approval_decisions` 以 `(owner_id,idempotency_key)` 为主键，记录目标、动作、请求哈希和原决定，禁止更新/删除。它不复用 task 消费、有效期、调度事件或 outbox。
- 工具执行结果仍只归 `tool_invocations`；文档批准只保存授权和唯一绑定，不另建文件效果账。批准详情和 Run 完成条件通过 tools 的公共只读证据核对 applied/conflict/unknown 及后续新读取，不直读 tools 私表。
- Run 的 workspace grant 和安全摘要放既有 `frozen_context`。摘要用于历史展示，不把登记撤销变成历史 GET/取消失败；新动作与批准后继续须重新核对精确 grant。新执行使用 harness/v5（路由默认 off），快照仍为snapshot2，旧 task snapshot1 仅作不扩权的读取迁移。
- FS 替换与 PG 接受非原子：许可后不确定结果保留 `unknown`，不因文件 hash 相同就补写成功。完整效果及回读规则见 [design/14 §§5–7](../design/14-r1-document-task-loop.md)。

## R2-A 上下文策略

[Required] conversations 的不可变 `run_context_policies` 由0019建立，字段/事务见 [conversation schema](conversation-and-runs-schema.md#r2-a-上下文策略83)，语义见 [design/18 §3](../design/18-r2a-harness-context.md#3-冻结策略及旧-run)。不改 frozen_context、原预算、allowlist 或 snapshot2 引用；旧 Run 仅有效显式恢复补入，GET 零写。生命周期同时核验表、约束和不可变触发器，文档不是已部署证据。

## Enum 策略

[Required] PostgreSQL enum 改值成本高，初版统一：

- 全部状态/类型/渠道字段用 `text`，约束说明写“按某某值约束”，落地用 `text + check constraint` 或 service 层校验。
- 受约束的值集合：`task.state` 按 `saved/pending_schedule/scheduled/fired/missed/cancel_pending/cancelled` 约束；`approval.state` 按 `pending/consumed/rejected/expired/superseded` 约束；`task.kind` 按 `notify_only/...` 约束（v0 仅 `notify_only`，其余 Deferred）；`notification.channel` 按 `inapp` 约束（Web Push 仅兜底，Deferred）；`outbox.status` 按 `pending/dispatched/acked_unknown/superseded/failed_deadline` 约束（以 commitments 篇为准）。
- 稳定后如需收紧，再以后续 migration 加 check 约束，不直接改 enum 类型。

## 外键与模块边界

[Required]：

- 模块自有 schema，跨模块只传 id，不跨模块建强 FK。允许的逻辑引用：`tasks.source_approval_id → approvals.id`、`task_events.task_id → tasks.id`、`briefs/cards → task_id/approval_id`，落地时本模块内 FK，跨模块仅逻辑引用 + 应用层校验。
- 直接创建来源是窄例外：`tasks.source_invocation_id → tool_invocations.invocation_id` 使用 `ON DELETE RESTRICT` FK 和唯一约束，保证冻结创建来源不可悬空、同 invocation 不产生第二条任务；不授权 tasks 读取或修改 tools 私有业务状态。旧 approval 来源不回填或改建引用。
- 历史/审计/事件类表 `on delete restrict` 或禁止删除；主对象删除不级联删历史。
- 避免双向 nullable 外键与循环 FK。`tasks.recreated_from_task_id` 自引用单向 nullable unique，不建反向引用。
- `users` 删除：[Proposed] 禁止物理删除用户行（关联账不可断）；注销以状态标记 + 数据清理流程处理（Deferred，P1 后定）。

## Append-only 与不可变约定

[Required]：

- `task_events` 只追加：DB 禁 `UPDATE`/`DELETE`（trigger 落地，0005 `task_events_no_update_delete`）。
- `agent_revisions`、`prompt_versions`不可变；`run_checkpoints`及`tool_calls`只追加。`tool_invocations`身份/冻结上下文建后不可改，completed结果禁改删；合法状态迁移及新审计关联由0014约束，旧hash唯一不再代表调用身份。
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
- Run：`running → suspended_approval → running → done | failed | cancelled`；等待不是成功，恢复仅限最后有效批准等待点。0015 冻结执行权威，动作关系只追加；取消先提交资格撤销，既成工具/任务不假撤销。
- 受控确认事务覆盖创建任务和取消请求；公共用例可传 DTO/返回只读投影，可靠异步命令才走 outbox（design/02 §1–§2）。D1 不解析 SQL 所有权。Run/checkpoint 存储长期归 TS，仓颉上下文/等待恢复按 design/09/11，事件补读不证明通用执行恢复。
