# Commitments Schema 设计

> 状态：v0 可开工。范围：`approvals`、`tasks`、`task_events`、`outbox`、`notifications` 全字段。不包含：重复提醒、日历授权、投递对账网关（v1 盒子）。阶段标签：v0 MVP 全链路。

## 设计依据

- B06 §5 确认/C 草稿、`pending_confirmation` 一行定义；§6 R 正式表与状态机；§9 取消优先与安全指标 [B06]。
- Contract 状态机：task `saved→pending_schedule→scheduled(回执)→fired|missed →cancel_pending→cancelled`；approval `pending→consumed|rejected|expired|superseded`；`UNIQUE(task_id,fire_at)`；`recreated_from` 唯一；`task_events` 只追加；Approval 消费 + 建 Task 同事务是唯一跨模块事务。
- v0 切片：06 喝水提醒降级为调度子用例（`task.kind = notify_only`，不走 LLM 先验调度 + time-core）。

## 旧称映射

B06 旧称 → 本体系新称：`C`（确认草稿/回显）→ `Approval`；`R`（正式提醒）→ `Task`。下文一律用新称，旧称仅本节出现。

## 表关系

```text
approvals 1 ── 0..1 tasks   (tasks.source_approval_id，同事务创建)
tasks 1 ── 0..n task_events (append-only)
tasks 1 ── 0..n outbox
tasks 1 ── 0..n notifications
tasks 1 ── 0..1 tasks       (recreated_from_task_id 自引用)
```

- 唯一跨模块事务：`approvals` 消费 + `tasks` 创建同事务（验 owner、验 pending、验 `now < expires_at`）。
- 其余跨模块经 `outbox` 领域事件，不开分布式事务。

## `approvals`

### 用途

[Required] 确认门一等公民。回显绑定此行；只有整句确认或点确认按钮才消费。

### 字段

| 字段                          | 类型          | 约束                              | 说明                                                           |
| ----------------------------- | ------------- | --------------------------------- | -------------------------------------------------------------- |
| `id`                          | `uuid`        | primary key                       | approval ID（对外短号映射只定位不授权，映射表 Deferred）       |
| `owner_id`                    | `uuid`        | not null                          | 所属用户，查询必带                                             |
| `conversation_id`             | `uuid`        | nullable                          | 所属会话（逻辑引用）                                           |
| `original_text`               | `text`        | nullable                          | 用户原话（过期墓碑后置空，30 天留号）                          |
| `fire_at_utc`                 | `timestamptz` | not null                          | 触发依据（归一输出）                                           |
| `wall_time`                   | `text`        | not null                          | 墙上时间（精确到秒，如 `2026-10-17 09:20:00`），展示用         |
| `timezone_id`                 | `text`        | not null                          | IANA 时区                                                      |
| `fold`                        | `smallint`    | not null, default `0`             | 歧义时刻选择（`0` 非歧义，`1` 第二次出现）                     |
| `resolved_utc_offset_seconds` | `integer`     | not null                          | 归一偏移（秒，如 `+08:00` → `28800`）                          |
| `tzdb_version`                | `text`        | not null                          | 时区库版本                                                     |
| `occurrence`                  | `text`        | not null, default `'single'`      | 按 `single` 约束（v0 仅单次）                                  |
| `presentation_hash`           | `text`        | not null                          | 回显规范编码哈希（排版空格不算，原话空格算，时间先归一再编码） |
| `presentation_version`        | `text`        | not null                          | 回显模板版本（冻结，旧 approval 用旧模板）                     |
| `state`                       | `text`        | not null, default `'pending'`     | 按 `pending/consumed/rejected/expired/superseded` 约束         |
| `created_at`                  | `timestamptz` | not null, default `now()`         | 创建时间                                                       |
| `expires_at`                  | `timestamptz` | not null                          | 回显有效 24h（`created_at + 24h`）                             |
| `consumed_task_id`            | `uuid`        | nullable                          | 消费后创建的 task ID（逻辑引用）                               |
| `supersedes_approval_id`      | `uuid`        | nullable                          | 被替代链（改字段重回显，旧键作废，新行指旧行）                 |
| `kind`                        | `text`        | not null, default `'create_task'` | `create_task` / `cancel_task`（迁移 0011）                     |
| `target_task_id`              | `uuid`        | nullable                          | 取消目标；`cancel_task` 必填，`create_task` 必为 NULL          |
| `expected_state_version`      | `integer`     | nullable                          | 取消提案校验时的 task 版本，仅审计；确认以当前状态机为准       |

### 约束与索引

- `index(owner_id, state)`，待确认列表。
- `index(expires_at)`，过期顺路清。
- `unique(consumed_task_id)`（非 NULL 唯一），一个 approval 只产一个 task。

### 写入规则

- [Required] 状态流 `pending → consumed | rejected | expired | superseded`；消费与建 task 同事务。
- [Required] 消费后冻结全行；重复确认回原 task（“这是重复确认，没有新建第二条”）。
- [Required] 服务端按快照重建预期比对 `presentation_hash`，对不上停在待核对（`PRESENTATION_MISMATCH`）。
- [Required] 过期顺路清（启动/读取/确认时），不另养后台进程；过期清内容留号 30 天。
- 快照自检（墙上+时区+偏移推不出 UTC）→ 待修复，不怪用户，修好换新 approval 重来。

## `tasks`

### 用途

[Required] 正式调度对象（旧称 R）。确认后才创建；触发门禁三查（对得上 + `scheduled` + 登记凭据绑同一 task）。

### 字段

| 字段                          | 类型          | 约束                              | 说明                                                                             |
| ----------------------------- | ------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `id`                          | `uuid`        | primary key                       | task ID，永不复用                                                                |
| `owner_id`                    | `uuid`        | not null                          | 所属用户，查询必带                                                               |
| `kind`                        | `text`        | not null, default `'notify_only'` | 按 `notify_only` 约束（v0 仅此值；06 喝水=调度子用例，不走 LLM 先验调度）        |
| `source_approval_id`          | `uuid`        | nullable                          | 来源 approval（逻辑引用，同事务创建）                                            |
| `recreated_from_task_id`      | `uuid`        | nullable                          | 重约来源（自引用，唯一；只保证找得回去，不继承授权）                             |
| `fire_at_utc`                 | `timestamptz` | not null                          | 触发瞬间（归一输出，出差不改）                                                   |
| `wall_time`                   | `text`        | not null                          | 墙上时间（精确到秒）                                                             |
| `timezone_id`                 | `text`        | not null                          | IANA 时区                                                                        |
| `fold`                        | `smallint`    | not null, default `0`             | 歧义选择冻结                                                                     |
| `resolved_utc_offset_seconds` | `integer`     | not null                          | 归一偏移（秒）                                                                   |
| `tzdb_version`                | `text`        | not null                          | 时区库版本                                                                       |
| `occurrence`                  | `text`        | not null, default `'once'`        | 按 `once` 约束（v0 仅单次）                                                      |
| `state`                       | `text`        | not null, default `'saved'`       | 按 `saved/pending_schedule/scheduled/fired/missed/cancel_pending/cancelled` 约束 |
| `state_version`               | `integer`     | not null, default `1`             | 本机发，提交时原子递增（outbox 验版本依据）                                      |
| `schedule_receipt`            | `text`        | nullable                          | 登记回执凭据（有回执才标 `scheduled`）                                           |
| `original_note`               | `text`        | nullable                          | 原话备注（接口不读，仅展示候选）                                                 |
| `created_at`                  | `timestamptz` | not null, default `now()`         | 创建时间                                                                         |

### 约束与索引

- `unique(recreated_from_task_id)`（非 NULL 唯一），同一旧号只有一个后继。
- Contract `UNIQUE(task_id, fire_at)` 落为 `unique(id, fire_at_utc)`（防同一 task 双触发点分叉；以本行为准）。
- `index(owner_id, state)`，调度/列表查询。
- `index(fire_at_utc)`，到点扫描（claim lease 用）。
- `index(owner_id, fire_at_utc)`，用户时间线。

### 写入规则

- [Required] 除 `state` / `state_version` 外建后冻结；改时间必须走新 task（先断旧再立新）。
- [Required] 状态与事件同一事务写（写 `tasks` + 追加 `task_events` 原子）。
- [Required] `scheduled` 必须有登记回执；无回执停在 `pending_schedule`。
- [Required] 超 15min 标 `missed` 不补发；取消后触发数 = 0 为一级指标（`security_events` v0 落表，一年留存、不跟 task 走，S0 #14 冻结）。
- [Required] 取消赢过一切：取消提交（`cancel_pending` 提交即算，S0 #14 冻结）后排队重试全作废；触发门禁照拦。

## `task_events`

### 用途

[Required] 只追加事件账。可解释主动行为的证据链。

### 字段

| 字段              | 类型          | 约束                                                | 说明                                                                                                                                                                                            |
| ----------------- | ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | `uuid`        | primary key                                         | 事件 ID                                                                                                                                                                                         |
| `owner_id`        | `uuid`        | not null                                            | 所属用户，查询必带                                                                                                                                                                              |
| `task_id`         | `uuid`        | not null, references `tasks(id)` on delete restrict | 所属 task                                                                                                                                                                                       |
| `state_version`   | `integer`     | not null                                            | 对应 task 版本（事件与状态同一事务）                                                                                                                                                            |
| `type`            | `text`        | not null                                            | 按 `created/scheduled/fired/missed/cancel_requested/cancelled/reconciliation_run` 约束（S0 #14 冻结，以 design/07 §1 为准；`ACK_UNKNOWN/FAILED_DEADLINE_WINDOW/SUPERSEDED` 只进 outbox.status） |
| `recorded_at_utc` | `timestamptz` | not null, default `now()`                           | 记录时间（服务端钟）                                                                                                                                                                            |
| `evidence_ref`    | `text`        | not null, default `'local'`                         | 凭据号；无凭据写 `local`（本机记录），有则写回执号                                                                                                                                              |

### 约束与索引

- `index(task_id, state_version)`，按 task 回放。
- `index(owner_id, recorded_at_utc desc)`，用户事件流。

### 写入规则

- [Required] 只追加：DB 禁 `UPDATE`/`DELETE`。
- [Required] 与 `tasks` 状态同一事务写，要么全成要么全不成。
- 对外口径只说已记录步骤，不承诺必达。

## `outbox`

### 用途

[Required] 跨边界垫单。Scheduler 30 秒扫一次；验版本 → 发请求 → 记结果。

### 字段

| 字段                     | 类型          | 约束                                                | 说明                                                                  |
| ------------------------ | ------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `id`                     | `uuid`        | primary key                                         | outbox 行 ID                                                          |
| `owner_id`               | `uuid`        | not null                                            | 所属用户                                                              |
| `task_id`                | `uuid`        | not null, references `tasks(id)` on delete restrict | 目标 task                                                             |
| `expected_state_version` | `integer`     | not null                                            | 发送时期望版本；版本变标 `superseded` 不发                            |
| `command`                | `jsonb`       | not null                                            | 命令（含幂等键；不含敏感原文）                                        |
| `idempotency_key`        | `text`        | not null                                            | 幂等键（重试同一键，不再问用户）                                      |
| `attempt_no`             | `integer`     | not null, default `1`                               | 第几次发送                                                            |
| `status`                 | `text`        | not null, default `'pending'`                       | 按 `pending/dispatched/acked_unknown/superseded/failed_deadline` 约束 |
| `created_at`             | `timestamptz` | not null, default `now()`                           | 创建时间                                                              |
| `last_attempt_at`        | `timestamptz` | nullable                                            | 上次发送/核对尝试（调度器退避依据，DB 钟）                            |
| `ack_check_no`           | `integer`     | not null, default `0`                               | ACK_UNKNOWN 已核对次数，按 `0..3` 约束（30s/2min/5min 各一次）        |
| `provider_receipt_id`    | `text`        | nullable                                            | 发送方回执号（只证明接口收了，不证明用户看见）                        |
| `last_error`             | `text`        | nullable                                            | 上次失败原因（短串，不含敏感原文）                                    |

### 约束与索引

- `unique(idempotency_key)`，幂等键唯一。
- `index(status, created_at)`，调度扫描。
- `index(status, last_attempt_at)`（`outbox_dispatch_idx`，0010），调度/退避扫描。

### 写入规则

- [Required] 最多 3 次重试（首次后 1min、再 5min），同一幂等键。
- [Required] 发了没回记 `acked_unknown`，只核对不重发（30s/2min/5min 各核一次，还未知转持久对账 Deferred）。
- [Required] Mutable 列规则（0010 调度运维列）：`command` / `idempotency_key` / `task_id` / `expected_state_version` 建后冻结，调度器只改 `status` / `attempt_no` / `ack_check_no` / `last_attempt_at` / `provider_receipt_id` / `last_error`；`ack_check_no` 只增不减（0→3）；`last_error` 只写短原因，不进原文、不进 token 明文。

## `notifications`

### 用途

[Required] 应用内通知（到点私密触发一次）。v0 仅站内；Web Push 仅兜底（Deferred）。

### 字段

| 字段              | 类型          | 约束                                                | 说明                                |
| ----------------- | ------------- | --------------------------------------------------- | ----------------------------------- |
| `id`              | `uuid`        | primary key                                         | 通知 ID                             |
| `owner_id`        | `uuid`        | not null                                            | 所属用户，查询必带                  |
| `task_id`         | `uuid`        | not null, references `tasks(id)` on delete restrict | 来源 task                           |
| `channel`         | `text`        | not null, default `'inapp'`                         | 按 `inapp` 约束（v0 仅站内）        |
| `title`           | `text`        | not null                                            | 标题（由冻结快照生成，不重算时间）  |
| `body`            | `text`        | not null                                            | 正文                                |
| `idempotency_key` | `text`        | not null                                            | 幂等键（Notifier send 回执 + 幂等） |
| `status`          | `text`        | not null, default `'pending'`                       | 按 `pending/sent/failed` 约束       |
| `created_at`      | `timestamptz` | not null, default `now()`                           | 创建时间                            |
| `sent_at`         | `timestamptz` | nullable                                            | 发送时间                            |

### 约束与索引

- `unique(idempotency_key)`，幂等。
- `index(owner_id, created_at desc)`，通知列表。
- `index(task_id)`，按 task 核对。

### 写入规则

- [Required] 发送只认回执；无回执不标 `sent`。
- [Required] 口径天花板：只说“已记录的步骤可核对”，不承诺必达、不声称用户已读。
- [Required] payload 不得输出敏感值原文。

## `task_leases`（S0 #14 冻结新增）

| 字段                     | 类型          | 约束                                                   | 说明                          |
| ------------------------ | ------------- | ------------------------------------------------------ | ----------------------------- |
| `task_id`                | `uuid`        | primary key, references `tasks(id)` on delete restrict | 认领目标，一 task 一 lease 行 |
| `owner_id`               | `uuid`        | not null                                               | 所属用户，查询必带            |
| `expected_state_version` | `integer`     | not null                                               | 认领时期望版本；fencing 依据  |
| `lease_owner`            | `text`        | not null                                               | worker 认领者                 |
| `lease_expires_at`       | `timestamptz` | not null                                               | 租约到期                      |

- [Required] 认领与 `tasks` 行锁同事务：验 `state=scheduled` + 验 version + 写 lease 同原子；`expected_state_version` 对不上不发。

## `security_events`（S0 #14 冻结新增，v0 落表）

| 字段              | 类型          | 约束                        | 说明                                                   |
| ----------------- | ------------- | --------------------------- | ------------------------------------------------------ |
| `id`              | `uuid`        | primary key                 | 事件 ID                                                |
| `owner_id`        | `uuid`        | not null                    | 所属用户                                               |
| `task_id`         | `uuid`        | nullable                    | 关联 task（逻辑引用，不级联删）                        |
| `type`            | `text`        | not null                    | 按 `cancel_breach` 约束（v0 仅此值；取消后触发数破 0） |
| `recorded_at_utc` | `timestamptz` | not null, default `now()`   | 记录时间                                               |
| `evidence_ref`    | `text`        | not null, default `'local'` | 证据引用，不留内容原文                                 |

- [Required] 一年留存，不跟 task 走，不留内容原文；破 0 即记，人复核放行。
