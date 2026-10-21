# v0-safety-contract

Issue: #14（S0 契约冻结：v0 安全内核 5 项裁决）

## Purpose

冻结 v0 安全内核的唯一行为契约：错误码 HTTP、事件词封闭集、表名、confirm 三件套、取消计时点、按钮确认、简报只读。实现（#4/#7a/#7b/#8/#9/#10）只认本契约 + design，不认旧 api/schema 别名。

## Requirements

### Requirement 1: 错误码 HTTP 唯一

系统 SHALL 以 `docs/design/10 §6` numeric `40xxxx` 为码，以 `docs/api/README.md §5` HTTP 表为传输语义：`PRESENTATION_MISMATCH 409`、`APPROVAL_EXPIRED 410`、`APPROVAL_SUPERSEDED 409`、时间四错 `422`、`BUDGET_EXCEEDED 429`、`TZDB_UNAVAILABLE/NOT_READY 503`。

#### Scenario 1.1 回显对不上停住

- WHEN confirm 的 `presentation_hash` 与快照重建预期不一致
- THEN 返回 `409 PRESENTATION_MISMATCH`，不建 task（映射 A2）

#### Scenario 1.2 时间四错只澄清

- WHEN normalize 返回 `NONEXISTENT/AMBIGUOUS/UNKNOWN_TZ`
- THEN 走流内 `thread.failed`（422 语义），不建 approval（映射 A4）

#### Scenario 1.3 规则缺失不开张

- WHEN `TZDB_VERSION`/alias/ruleset 缺失
- THEN `/readyz` 返回 `503 TZDB_UNAVAILABLE/NOT_READY`，不降级（映射 F3）

### Requirement 2: 事件账封闭集

系统 SHALL 只写 `created/scheduled/fired/missed/cancel_requested/cancelled/reconciliation_run` 七类；`ACK_UNKNOWN/FAILED_DEADLINE_WINDOW/SUPERSEDED` 只进 `outbox.status`。

#### Scenario 2.1 一态一事件

- WHEN task 状态跃迁提交
- THEN 同一事务恰好一条对应事件，无合成行（映射 A1/A3）

#### Scenario 2.2 非法 type 拒绝

- WHEN 写入 `saved/schedule_confirmed/superseded/ack_unknown` 作为 `task_events.type`
- THEN check 约束拒绝（映射 D5）

### Requirement 3: 表名与约束

系统 SHALL 用 `outbox`（废 `outbox_events`），`task_leases` 承载 fencing，`security_events` 记录取消破 0（一年留存、不留内容）。

#### Scenario 3.1 并发双写唯一

- WHEN 同 `(task_id, fire_at_utc)` 并发双写
- THEN 一成一 `23505`，无第二条 scheduled（映射 D3）

#### Scenario 3.2 取消破 0 有行

- WHEN 取消提交后仍发出触发请求
- THEN `security_events` 记 `cancel_breach`，人复核（映射 D9）

### Requirement 4: confirm 单事务与按钮确认

系统 SHALL 只认按钮确认；同一事务验 owner/pending/有效期→比 hash→建 task→写 created→写 outbox→consumed；任一失败全回滚；重复回同一 task。

#### Scenario 4.1 并发双击同一 task

- WHEN 同一 approval 并发 confirm 两次
- THEN 仅 1 task/1 created/1 outbox，两次 200 同 `task_id`（映射 A2）

#### Scenario 4.2 三错零 task

- WHEN `PRESENTATION_MISMATCH/EXPIRED/SUPERSEDED` 任一发生
- THEN 建 task 数为 0（映射 A2）

### Requirement 5: 取消计时与回执门

系统 SHALL 以 `cancel_pending` 提交事务落定为取消已提交计时点；无 `schedule_receipt` 不标 `scheduled`，无撤销回执不标 `cancelled`。

#### Scenario 5.1 取消竞争两终局

- WHEN 取消与到点并发
- THEN 或 `cancelled` 后无 `fired`，或 `fired` 后取消 `409`，无中间态；取消已提交后触发数为 0（映射 F2）

#### Scenario 5.2 kill 后恰好一次

- WHEN worker `kill -9` 后 resume
- THEN 通知恰好一条，事件账仅一条 `fired`（映射 F1/A3）

### Requirement 6: 简报只读投影

系统 SHALL 以 `GET /brief` 只读投影 tasks/approvals，不建 `briefs`/`cards` 表；展示只读冻结字段；口径只说已记录步骤。

#### Scenario 6.1 点卡不建 task

- WHEN 点击简报卡片
- THEN 不产生 task，须走确认门（映射 A1）

#### Scenario 6.2 改 UTC 展示不变

- WHEN 快照 `fire_at_utc` 改 1 小时
- THEN 展示输出不变（映射 D2）

### Requirement: 任务详情只读站内通知投影

系统 SHALL 在既有任务详情成功响应及 Web 任务详情提供仅属于当前 owner 与该任务的站内通知只读投影，遵循 `docs/design/03-v0-vertical-slice.md` §3.1 与 `docs/api/tasks/tasks_routes.md` §2.1 的 DTO、空态、错误和模块所有权；不得新增通知路由或任务列表字段，不得把读取变成发送、重试或已读操作，展示只报告已记录步骤。映射 A1、D1/D2/D8/D10；取消与真实七步安全要求继续引用主 spec Requirement 5 及 design/03 §3.2，不在本增量重定义。

#### Scenario: owner 与既有详情错误边界

- WHEN 已认证 owner 读取本人、他人、不存在或非 UUID 的任务详情
- THEN 本人成功响应只含该 owner/任务的通知，其他情况沿用详情既有 `403` 或 `404` 而不返回通知；未认证仍为 `401`，通知读取由通知模块公开 service 承接，tasks/Web 不绕过存储边界（映射 D1/D8）

#### Scenario: 尚无通知的明确空态

- WHEN 本人任务存在但尚无已持久化的站内通知记录
- THEN 详情返回必有的空通知数组，Web 明示无记录，不从任务状态或事件合成通知；通知查询失败沿用详情错误而不伪装成功空态，任务列表保持原形状（映射 A1/D8）

#### Scenario: 冻结展示与无副作用读取

- WHEN 重复读取任务详情，或只改变触发 UTC/展示环境而未改变通知存储文本
- THEN 已存通知标题/正文保持原样，读取不调用 provider、不发送/重试/标已读，不新增或改写任务、通知、事件、outbox；展示不宣称设备送达或用户已读（映射 D2/D8/D10）

#### Scenario: 真实通知持久化后可见

- WHEN 已确认任务由真实 worker 到点处理并提交站内通知记录，随后 owner 成功读取详情与 Web 任务页
- THEN API 与页面显示同一已存通知及其实际状态/可空发送时间，不以 fired 文案冒充通知，不多造通知或触发请求；本地记录不被表述成用户收悉证明（映射 A1/D8/D10）
