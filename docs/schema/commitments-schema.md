# Commitments Schema 设计

> 状态：既有 task 与 R1 独立文档批准 schema 合同。范围：`approvals`、`approval_revision_requests`、`document_approvals`、`document_approval_decisions`、`tasks`、`task_events`、`outbox`、`notifications`；合同不表示迁移演练或真实模型/用户材料验收已通过。不包含：重复提醒、日历授权、投递对账网关（v1 盒子）。

> Proposed 演进：tasks直接来源`source_invocation_id`与旧`source_approval_id`分别受约束，新增可空`time_basis`不回填历史；仅严格UTC elapsed依据且UTC/offset0/fold0分支允许tzdb_version空，其余时间字段/真实规则身份继续约束，见 [design/20 §4.3、§6–§7](../design/20-goal-scoped-delegation.md)。旧批准只属legacy，新正常写不制造consumed批准；文档无task统一24小时TTL。事务、append-only/回执保留，本规范不实施DDL。

## 设计依据

- B06 §5 确认/C 草稿、`pending_confirmation` 一行定义；§6 R 正式表与状态机；§9 取消优先与安全指标 [B06]。
- Contract 状态机及 UNIQUE/只追加不变；批准消费与创建任务或取消请求保持受控单事务，范围见 design/02 §1–§2、design/06 §6，不强制公共读取/同步用例入 outbox。
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

- 受控跨模块事务：确认批准消费与 tasks 创建/created/outbox，或与 tasks 公共取消用例的状态/事件/取消命令/旧工作失效同事务；冻结确认门、全回滚与回执语义不变。
- 可靠异步命令走 outbox；同步公共用例/DTO/只读投影合法，不开启任意跨模块或分布式事务（design/02 §1–§2）。

## `approvals`

### 用途

[Required] 确认门一等公民。回显绑定此行；v0 只有点确认按钮才消费（S0 #14）。

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
- [Required] GET 只读投影过期，不落库；确认/拒绝顺路持久化过期，不另养后台进程。过期清内容留号 30 天为既有设计提议，不代表已实现清理。
- 快照自检（墙上+时区+偏移推不出 UTC）→ 待修复，不怪用户，修好换新 approval 重来。

## 审批修改持久化增量 [Required，#31]

只新增迁移，不修改已合并迁移；合同与迁移执行证据分开。行为真源见 `docs/design/06-approvals-confirmation-gate.md` §9，API见 `docs/api/approvals/approvals_routes.md` §6。

### `approvals` 最小增量

- 继续使用 0003 已有 `supersedes_approval_id`（新行→旧行），不增 `superseded_by`、版本链表、task字段或其他模块存储。
- 新增唯一索引 `approvals_supersedes_approval_id_uniq`：`UNIQUE (supersedes_approval_id) WHERE supersedes_approval_id IS NOT NULL`，每个前驱最多一个直接后继，不以 `findSuccessorId LIMIT 1` 代替数据库唯一性。独立会话新建的该列仍 NULL，不受影响。
- revise新行 `kind=create_task`、`target_task_id=NULL`、`expected_state_version=NULL`、`consumed_task_id=NULL`；同owner、可继承旧conversation_id、旧项为有效pending，新项指旧项且旧项原子superseded。后继可再改形成单链，不能自指/循环或从同会话猜前驱。
- 新快照按现有列与hash算法冻结；runtime `ruleset_id` 不是当前 approvals 持久列，不在本次顺便新增。旧行仅改state，插入新行与填写预约结果同事务；修改本身零task/事件/outbox/通知。

### `approval_revision_requests`（approvals所有）

固定只表示 revise；操作已由表名限定，不增加通用operation/status/request_json/response_json框架。UUID键复用范围为owner+revise，不把target放进主键；body约束/默认值与规范摘要见API §6.1及design/06 §9.3。

| 字段                     | 类型          | 约束                                                          | 说明                                     |
| ------------------------ | ------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `owner_id`               | `uuid`        | not null，复合主键第1列                                       | 当前actor；不得跨owner重放               |
| `idempotency_key`        | `uuid`        | not null，复合主键第2列                                       | body必填UUID，数据库值天然规范化         |
| `target_approval_id`     | `uuid`        | not null，references approvals(id) on delete restrict         | 路径旧目标；不进主键，同键跨目标冲突     |
| `request_hash`           | `text`        | not null，check为64位小写hex                                  | SHA-256规范请求摘要，无正文副本          |
| `anchor_received_at_utc` | `timestamptz` | not null，首次INSERT取DB clock_timestamp()                    | 首次持久接收线性化时间；预约提交后不可变 |
| `successor_approval_id`  | `uuid`        | nullable，unique，references approvals(id) on delete restrict | NULL=仅预约未完成；非NULL=已提交结果     |

`PRIMARY KEY(owner_id,idempotency_key)`；增加check `successor_approval_id IS NULL OR successor_approval_id <> target_approval_id`。FK限同模块审批，不引用users/conversations/outbox；同owner、目标kind/状态、successor.supersedes关联由approvals用例在同事务行锁内检验（不是声称单列FK能保证owner）。unique successor防一项结果被两个预约冒领。除首次由NULL填successor外，映射各列不可改写；不增时间TTL/后台清理/缓存。

先验actor/CSRF/body/UUID及目标owner，短事务插入/匹配预约并提交；这一步不改变审批状态。随后事务按预约→目标的顺序锁定；完成结果直接重放。未完成则锁后校验、共享A4归一、重查实时有效期，再原子INSERT新审批/UPDATE旧state/填successor。故障全回滚这三项但不删除已提交预约，重启同键沿原anchor恢复；无内存状态作为事实源。详情仍只读，不在GET写表。目标锁后发现到期时正常提交expired再向外返回410，不用抛错回滚掉expired。

预约与审批标识在v0服务数据生命周期内保留，不自动清除；未来正文墓碑清理不能删除映射或它引用的标识，不保留正文副本。任何未来删除/账号清理须先修订幂等保留合同及FK处理，不以定时删除释放键。

### 新迁移与版本失败

新增迁移编号按合入顺序分配，不改0003/0011，不预占A3/A4编号。受控停写、备份及只读预检先于迁移：

1. 检测非NULL前驱重复、前驱缺失/自指/跨owner、前驱非superseded、链循环或不合法create_task关联；发现即中止发布，保留行与检查证据。无自动删行、随机取后继或改owner/state的数据修复。
2. 干净库在同一迁移事务建立唯一索引/预约表；任一失败全回滚，不出现仅半套schema。新库按完整迁移序列建立，同样验证索引与检查生效。
3. schema成功后才发布新API/Web，不混跑旧新修改写者；schema失败则不暴露revise。版本发布失败保留additive表/索引及已有结果，不执行删表回滚或把修改降级为独立新建。
4. 恢复旧版本前核对锁后到期与owner修正仍满足新合同；不能满足则停写前滚修复，不允许旧confirm在到期窗口消费。恢复后用持久映射重放，不重建后继。

对应待验收：design/06 §9.6 R4/R5（持久幂等）、R6/R7（串行/时钟）、R9（回滚/唯一）、R10（干净/脏库及发布失败）。本契约PR不创建SQL迁移文件、不运行迁移演练。

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
- [Required] `scheduled` 必须有登记回执；无回执不得标为 `scheduled`。未排期 `saved/pending_schedule` 超窗也转 `missed`，不伪造回执。
- [Required] 超 15min 标 `missed` 不补发；状态、唯一对应事件及队列终结同事务，恢复包括 schedule 命令已终结的未排期遗留任务（design/08 §5）。取消后触发数 = 0 为一级指标（`security_events` v0 落表，一年留存、不跟 task 走，S0 #14 冻结）。
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
- [Required] 本地 inapp 在调用前持久化 `acked_unknown` 作为一次性许可；它表示可能已调用，不等于已接收。只核对不盲重发（30s/2min/5min，次数至 3 后保持并递延），超窗无接收事实为不确定未完成，见 design/08 §7–§9。
- [Required] Mutable 列规则（0010 调度运维列）：`command` / `idempotency_key` / `task_id` / `expected_state_version` 建后冻结，调度器只改 `status` / `attempt_no` / `ack_check_no` / `last_attempt_at` / `provider_receipt_id` / `last_error`；`ack_check_no` 只增不减（0→3）；`last_error` 只写短原因，不进原文、不进 token 明文。

## `notifications`

### 用途

[Required] 应用内通知（到点私密触发一次）。v0 仅站内；Web Push 仅兜底（Deferred）。

### 字段

| 字段                     | 类型          | 约束                                                | 说明                                   |
| ------------------------ | ------------- | --------------------------------------------------- | -------------------------------------- |
| `id`                     | `uuid`        | primary key                                         | 通知 ID                                |
| `owner_id`               | `uuid`        | not null                                            | 所属用户，查询必带                     |
| `task_id`                | `uuid`        | not null, references `tasks(id)` on delete restrict | 来源 task                              |
| `channel`                | `text`        | not null, default `'inapp'`                         | 按 `inapp` 约束（v0 仅站内）           |
| `title`                  | `text`        | not null                                            | 标题（由冻结快照生成，不重算时间）     |
| `body`                   | `text`        | not null                                            | 正文                                   |
| `idempotency_key`        | `text`        | not null                                            | 幂等键（Notifier send 回执 + 幂等）    |
| `status`                 | `text`        | not null, default `'pending'`                       | 按 `pending/sent/failed` 约束          |
| `created_at`             | `timestamptz` | not null, default `now()`                           | 创建时间                               |
| `sent_at`                | `timestamptz` | nullable                                            | 发送时间                               |
| `fire_at_utc`            | `timestamptz` | nullable，和 expected_state_version 同空/同非空     | 新协议接收绑定的冻结时刻；旧记录不回填 |
| `expected_state_version` | `integer`     | nullable，非空时正整数                              | 新协议调用许可版本，不属于对外通知 DTO |

### 约束与索引

- `unique(idempotency_key)`，幂等。
- `index(owner_id, created_at desc)`，通知列表。
- `index(task_id)`，按 task 核对。

### 写入规则

- [Required] 发送只认回执；无回执不标 `sent`。
- [Required] 口径天花板：只说“已记录的步骤可核对”，不承诺必达、不声称用户已读。
- [Required] payload 不得输出敏感值原文。
- [Required] 新协议本地 provider 用专用独立连接/事务写 `sent` 及完整接收绑定，回执 `inapp:<id>`；查询验证 owner/task/send key/fire/version/status/sent_at。旧两列为空的记录不是接收证明，冲突记录不覆盖或假称匹配。
- [Required] worker task 锁使用与 FK KEY SHARE 兼容的 FOR NO KEY UPDATE，仍阻止取消状态写；接收只经 notifications 自有事务，task/fired/outbox 另行原子收尾，不新增跨模块写事务。见 design/08 §7–§9。

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

## R1 文档批准与决议 [Required]

`0016_document_approvals.sql` 新增两表，均归 approvals；规范行为见 [design/14 §5–§7](../design/14-r1-document-task-loop.md)，发布/版本边界见 [Schema 索引](README.md#r1-文档批准)，路由/DTO 见 [API 索引 §8](../api/README.md#8-r1-工作区与文档批准-required)。不修改旧 task 批准表，不为文档伪造非空时间字段、task、调度事件或 outbox。

### `document_approvals`

| 字段                                                 | 类型/约束                                        | 所有权与语义                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `id / owner_id`                                      | uuid PK / uuid not null                          | 原批准身份与owner                                                                              |
| `conversation_id / run_id`                           | uuid not null，跨模块逻辑引用                    | 原会话/Run，不能以新Run继承授权                                                                |
| `workspace_id / workspace_grant / relative_path`     | 非空text / jsonb object / 非空text               | 冻结精确grant（workspace/owner/registration_digest/root_identity）及规范相对目标，不存宿主root |
| `base_read_invocation_id / base_version`             | uuid not null逻辑引用 / 64位小写hex              | 同Run已接受全文读与原字节SHA-256                                                               |
| `exact_new_content / new_version`                    | text not null / 64位小写hex                      | 完整目标内容与SHA-256，base/new版本必须不同                                                    |
| `presentation_version / presentation_hash / preview` | document_replace.v1 / 64位小写hex / jsonb object | 完整before/after/body冻结，原文BOM、CRLF和空白不归一                                           |
| `state`                                              | pending / approved / rejected                    | 只允许pending到approved或rejected，不可反转；无task的consumed/expired                          |
| `apply_invocation_id`                                | nullable uuid UNIQUE，跨模块逻辑引用             | 仅approved可绑定，一次从NULL绑定后不可换                                                       |
| `replaces_approval_id`                               | nullable uuid UNIQUE FK本表，不能自指            | 同目标冲突链前驱，建后不可改；每个前驱最多一个直接后继                                         |
| `created_at`                                         | timestamptz not null                             | 默认DB clock_timestamp()                                                                       |

会话、Run、基线读和apply只保存跨模块ID，归属、资格及接受结果由公共用例验证，不建立跨模块强FK；前驱与决议保留 approvals 模块内FK。表禁止DELETE，除state和一次apply绑定外全部不可变。INSERT trigger要求新行pending/unbound；前驱须已approved、已绑定，且owner/conversation/Run/workspace/grant/path完全相同。DB并不单独证明冲突：公共用例还核验已接受 `conflict` 的绑定和 `zero_write=true`，以及冲突接受之后新创建且新接受的全文读，才可生成后继；unknown、未尝试和拒绝不能用新批准绕开。

### `document_approval_decisions`

固定 `(owner_id,idempotency_key uuid)` 主键；`target_approval_id` 为本模块FK，`action=confirm|reject`、`request_hash` 为64位小写hex、`decision=approved|rejected`、`created_at` 默认DB clock_timestamp()。check约束动作与决定一致；全表只追加、禁止UPDATE/DELETE，不增TTL或第二份执行账。

摘要对固定字段序JSON `{action,approval_id,...确认hash/seen_content或可选reason}` 的UTF-8做SHA-256；不trim、不Unicode归一。同owner/key跨目标、跨动作或异body返回409，同请求持久重放原决定。新决议先锁原Run再锁批准，验当前可授权Run及精确登记；已完成决定可在Run终态或登记撤销后按owner重放，不能据此取得新动作资格。

### 授权、效果与限额

批准详情冻结receipt可在登记撤销后读取，但 `state=approved` 不是效果证明。`apply_invocation_id` 在调用预约事务原子绑定，在reserved→unknown的一次许可事务内再验原批准；文件替换和PG接受非原子，unknown不重写，也不以相同文件hash补报成功。

`effect` 是公共证据投影，不是新增存储列/状态机：`not_started/reserved/unknown/failed/conflict/applied/verified`，并带apply/read/successor引用。tools通过 `readRunDocumentEvidence` 提供真实结果；verified要求绑定applied之后新创建且新接受的独立全文read，目标、登记摘要、完整内容、版本和字节数一致。冲突链只有最终后继获新批准并完成applied+新read，才可支撑Run完成。

提议须同时保证完整工具结果序列化不超过240000 UTF-8字节，以及完整确认JSON（含再次转义的preview.body、hash、UUID键）不超过131072字节；超界返回 `range_too_large`，不截断预览生成无法完整确认的批准。HTTP131072是原始JSON累计限额，既有task的有效期/修改/创建取消事务及事件合同保持不变。
