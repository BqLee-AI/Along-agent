# Conversation & Runs Schema 设计

> 状态：业务与正式 Harness 存储合同。范围：对话/Run/attempt、只追加事件/有限快照、冻结执行权威与调用接受结果。不包含：任意崩溃自动恢复或通用 exactly-once。TS 长期持有 PostgreSQL 与事实，仓颉组织循环和本次上下文（design/09/11）。

## 设计依据

- B03 §4.1 在线对话数据流：BFF 拉上下文 → 调 Agent → SSE → 落库本轮对话 [B03]。
- a13n 落点：`run/attempt` fenced 执行、`checkpoint/display` 每个安全边界提交、不可变 revision、AG-UI 投影（`packages/stream-protocol` 版本化 zod，事件名开工对照 `thread-stream.schema.json`）[AF]。
- B06 v0 只跑干净单次提醒；混合与摘要进 v1，故本篇 run 只服务提醒路澄清/归一，不做通用规划器表。

## 表关系

```text
conversations 1 ── 0..n messages
conversations 1 ── 0..n agent_runs
agent_runs 1 ── 1..n run_attempts
run_attempts 1 ── 0..n run_checkpoints
agent_revisions 1 ── 0..n agent_runs        (逻辑引用，不可变)
prompt_versions 1 ── 0..n agent_revisions   (逻辑引用，不可变)
```

- 物理 FK 只在模块内：`messages.conversation_id`、`agent_runs.conversation_id`、`run_attempts.run_id`、`run_checkpoints.attempt_id`。
- `agent_runs.agent_revision` 逻辑引用 `agent_revisions.revision`（文本版本号），不建 FK（不可变 + 跨模块只传 id）。

## `conversations`

### 用途

[Required] 一次对话会话（Web 单端 v0）。承载简报→卡片→对话→确认链路的上下文容器。

### 字段

| 字段                     | 类型          | 约束                       | 说明                                             |
| ------------------------ | ------------- | -------------------------- | ------------------------------------------------ |
| `id`                     | `uuid`        | primary key                | 会话 ID                                          |
| `owner_id`               | `uuid`        | not null                   | 所属用户，查询必带                               |
| `title`                  | `text`        | not null, default `''`     | 会话题，可由首问生成；不影响语义                 |
| `status`                 | `text`        | not null, default `'open'` | 按 `open/closed` 约束                            |
| `confirmed_timezone_id`  | `text`        | nullable                   | 本会话已确认时区；“明天”锚，未确认则 NULL        |
| `anchor_received_at_utc` | `timestamptz` | nullable                   | 服务端首次接收时刻（“明天”锚钟），冻结后不再重算 |
| `created_at`             | `timestamptz` | not null, default `now()`  | 创建时间                                         |
| `updated_at`             | `timestamptz` | not null, default `now()`  | 更新时间                                         |

### 约束与索引

- `index(owner_id, created_at desc)`，会话列表。
- `index(owner_id, status)`，按状态筛。

### 写入规则

- [Required] `anchor_received_at_utc` 取服务端可信钟（BFF 盖戳），客户端 `client_sent_at` 只诊断不用。
- [Required] 时区未确认时不解析相对日期；确认后冻结，会话内不再重算（B06 §3.5）。

## `messages`

### 用途

[Required] 对话消息明细。对 SSE 流的落库形态；流式 delta 合并为一条最终消息 + 可选事件投影。

### 字段

| 字段              | 类型          | 约束                                                        | 说明                                               |
| ----------------- | ------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `id`              | `uuid`        | primary key                                                 | 消息 ID                                            |
| `owner_id`        | `uuid`        | not null                                                    | 所属用户，查询必带                                 |
| `conversation_id` | `uuid`        | not null, references `conversations(id)` on delete restrict | 所属会话                                           |
| `role`            | `text`        | not null                                                    | 按 `user/assistant/system` 约束                    |
| `content`         | `text`        | not null                                                    | 消息正文（用户原话原样存；助手回复存最终合并文本） |
| `request_id`      | `text`        | nullable                                                    | 全链路 `request_id`，幂等/排查用                   |
| `created_at`      | `timestamptz` | not null, default `now()`                                   | 创建时间                                           |

### 约束与索引

- `index(conversation_id, created_at)`，会话内按序读回。
- `index(owner_id, created_at desc)`，跨会话排查。
- `unique(request_id)`（非 NULL 唯一，迁移 0002），防 BFF 重发导致重复落库。

### 写入规则

- [Required] 用户原话原样转发、按不可信解析；不改写、不截断语义。
- [Required] 不存完整模型推理链与 provider 原始响应（只存最终文本 + 摘要）。

## `agent_runs`

### 用途

[Required] 一次逻辑执行，冻结 `execution=business|harness`。默认/历史 business 沿确定性业务；harness 为唯一仓颉核心且 mode=chat，批准恢复不换 Run。

### 字段

| 字段                    | 类型          | 约束                                                        | 说明                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `id`                    | `uuid`        | primary key                                                 | run ID                                                     |
| `owner_id`              | `uuid`        | not null                                                    | 所属用户，查询必带                                         |
| `conversation_id`       | `uuid`        | not null, references `conversations(id)` on delete restrict | 所属会话                                                   |
| `agent_revision`        | `text`        | not null                                                    | 不可变 agent 版本号（逻辑引用 `agent_revisions.revision`） |
| `mode`                  | `text`        | not null                                                    | 按 `chat/task` 约束（v0 提醒路多为 `task`，纯问为 `chat`） |
| `status`                | `text`        | not null, default `'running'`                               | 按 `running/suspended_approval/done/failed/cancelled` 约束 |
| `budget_max_iterations` | `integer`     | not null                                                    | 接受时冻结；harness 的累计模型迭代上限                     |
| `budget_max_tokens`     | `integer`     | not null                                                    | 可得 usage 的起步上限；缺 usage 不冒充可证明费用           |
| `execution`             | `text`        | not null, default business                                  | business/harness，禁止执行中切换                           |
| `tools_allowlist`       | `jsonb`       | not null, array                                             | 冻结服务端工具范围；历史 business 为[]，不伪造授权         |
| `frozen_context`        | `jsonb`       | harness 必须 object                                         | 接受时的输入时间/规则上下文；不是模型推理链                |
| `input_message_id`      | `uuid`        | nullable FK messages；harness 必填                          | 该 Run 实际接受的用户消息                                  |
| `waiting_checkpoint_id` | `uuid`        | nullable FK run_checkpoints                                 | 最后有效批准等待点                                         |
| `waiting_invocation_id` | `uuid`        | nullable                                                    | 同 Run 已接受批准提议调用                                  |
| `waiting_approval_id`   | `uuid`        | nullable                                                    | 原冻结批准；当前决议另从公共读取获取                       |
| `created_at`            | `timestamptz` | not null, default `now()`                                   | 创建时间                                                   |
| `ended_at`              | `timestamptz` | nullable                                                    | 结束时间                                                   |

### 约束与索引

- `index(conversation_id, created_at)`，会话内执行历史。
- `index(owner_id, status)`，按状态排查。

### 写入规则

- [Required] 创建时冻结 execution、owner/conversation、revision、mode、预算、工具范围、上下文与输入引用；0015 trigger 禁止事后改变，终态 Run 不可改写。
- [Required] harness suspended_approval 时三个 waiting 引用必须齐备；其他 harness 状态必须为空。TS 锁内进一步验证实际 owner/Run/已接受调用/批准对应关系，引用本身不作授权。
- [Required] 已接受助手 delta 合并的消息、终态 checkpoint、attempt/Run 同事务；无助手输出的结构化失败不合成助手消息。取消不能覆盖已提交事实或伪撤销既成效果。预算失败保留已产出。

## `run_attempts`

### 用途

[Required] 同 Run 的一次有效执行；批准挂起结束当前 attempt，显式恢复创建递增 attempt。每次动作校验最新 running attempt 与实际 Run/权限/取消；旧 pipe 不因持有 UUID 而恢复执行权。存在 lease 字段不代表已实现通用租约或任意崩溃 kill/resume。

### 字段

| 字段               | 类型          | 约束                                                     | 说明                                     |
| ------------------ | ------------- | -------------------------------------------------------- | ---------------------------------------- |
| `id`               | `uuid`        | primary key                                              | attempt ID                               |
| `owner_id`         | `uuid`        | not null                                                 | 所属用户，查询必带                       |
| `run_id`           | `uuid`        | not null, references `agent_runs(id)` on delete restrict | 所属 run                                 |
| `attempt_no`       | `integer`     | not null                                                 | 第几次尝试，从 1 递增                    |
| `lease_token`      | `uuid`        | nullable                                                 | fencing 租约令牌；Scheduler claim 持有者 |
| `lease_expires_at` | `timestamptz` | nullable                                                 | 租约过期时间                             |
| `status`           | `text`        | not null, default `'running'`                            | 按 `running/done/failed/fenced_out` 约束 |
| `created_at`       | `timestamptz` | not null, default `now()`                                | 创建时间                                 |
| `ended_at`         | `timestamptz` | nullable                                                 | 结束时间                                 |

### 约束与索引

- `unique(run_id, attempt_no)`，尝试序号唯一。
- `index(run_id, created_at)`，按 run 回放。

### 写入规则

- [Required] `attempt → Run → invocation` 锁序裁决当前执行资格。同有效批准等待点最多一个恢复 attempt；取消与恢复竞争时重新定位最新 attempt。不由 attempt 递增推导外部效果 exactly-once。

## `run_checkpoints`

### 用途

[Required] 对外 thread 事件与内部 `harness_snapshot` 共用只追加表。只有有效批准等待点有有限恢复语义；历史业务事件不伪造完整执行上下文，普通 checkpoint/lease 不提供通用恢复保证。

### 字段

| 字段                      | 类型          | 约束                                                       | 说明                                                                                              |
| ------------------------- | ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid`        | primary key                                                | checkpoint ID                                                                                     |
| `owner_id`                | `uuid`        | not null                                                   | 所属用户，查询必带                                                                                |
| `attempt_id`              | `uuid`        | not null, references `run_attempts(id)` on delete restrict | 所属 attempt                                                                                      |
| `seq`                     | `bigint`      | not null                                                   | attempt 内序号，从 1 递增                                                                         |
| `event_seq`               | `bigint`      | not null, unique                                           | 全局不透明流游标；before-insert 持 conversation 锁后重新分配，锁持至提交；允许内部行/回滚导致间隙 |
| `kind`                    | `text`        | not null                                                   | 保留既有内部/七词事件，新增内部 `harness_snapshot`；读取外部流显式过滤                            |
| `payload`                 | `jsonb`       | not null, default `'{}'`                                   | 结构化摘要（tool 名 + 参数摘要 + 结果摘要）；不存敏感原文                                         |
| `stream_protocol_version` | `text`        | not null                                                   | 投影协议版本（`packages/stream-protocol` 版本号），AG-UI 投影依据                                 |
| `created_at`              | `timestamptz` | not null, default `now()`                                  | 创建时间                                                                                          |

### 约束与索引

- `unique(attempt_id, seq)`，attempt 内序号唯一。
- `unique(event_seq)`，全局流游标唯一。
- `index(attempt_id, event_seq)`，重放按序读；跨会话游标用 `event_seq`。

### 写入规则

- [Required] 只追加，禁 `UPDATE`/`DELETE`。
- [Required] `payload` 不存敏感值原文；tool 参数摘要脱敏。
- [Required] harness_snapshot 保存版本、已接受消息/工具结果引用、usage/next_call_no/等待引用，不保存 raw args、provider body、密钥或完整推理链；TS 验证同 owner/Run、真实接受事实与单调进度。
- [Required] 同 conversation 先持 NO KEY UPDATE 锁再分配游标，并保持至提交，避免小游标晚提交被客户端永久漏掉，并与终态消息插入取得的外键 KEY SHARE 兼容。内部快照不交给外部 ThreadEventSchema；GET/同入站键只读不启动执行。

## `harness_resumes` / `harness_cancellations`

0015 的最小持久动作关系，均只追加、禁止 UPDATE/DELETE，不另造工具结果账。

| 表                    | 字段与约束                                                                                                        | 语义                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| harness_resumes       | owner_id/idempotency_key 主键；run_id/checkpoint_id/attempt_id 外键；checkpoint_id、attempt_id 各唯一；created_at | 同等待点仅一次有效恢复，同键丢回答定位原 attempt，不另启动 |
| harness_cancellations | owner_id/idempotency_key 主键；run_id 外键；reason、created_at                                                    | 同键同 Run/reason 回原裁决，冲突409；终态只返回真实状态    |

所有读写均先验证 owner/conversation/Run 和当前权限；resume 只允许最后有效等待点与真实已决批准，拒绝普通/他人/旧引用、business 或终态。取消事实先提交才通知 native；取消和恢复的幂等身份不代替 invocation_id。

## `conversation_idempotency`

### 用途

[Required] 入站 `Idempotency-Key` 绑定（迁移 0011）。一个 `(owner_id, idempotency_key)` 一行，先写者赢；重复 POST 原样重放已存 `run_checkpoints`。

### 字段

| 字段              | 类型          | 约束                                     | 说明                                                                                                 |
| ----------------- | ------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `owner_id`        | `uuid`        | not null, references `users(id)`         | 所属用户                                                                                             |
| `idempotency_key` | `text`        | not null                                 | 客户端键；缺省回退 body `idempotency_key` 或 `request_id`                                            |
| `request_hash`    | `text`        | not null                                 | business 保留历史材料；harness/v1 域分隔，同 owner/key 换执行类型或其他绑定内容为409，不另开幂等空间 |
| `conversation_id` | `uuid`        | not null, references `conversations(id)` | 命中的会话                                                                                           |
| `run_id`          | `uuid`        | not null, references `agent_runs(id)`    | 命中的 run                                                                                           |
| `user_message_id` | `uuid`        | nullable, references `messages(id)`      | 该次用户消息                                                                                         |
| `created_at`      | `timestamptz` | not null, default `now()`                | 创建时间                                                                                             |
| `expires_at`      | `timestamptz` | not null                                 | 24h 重放窗口                                                                                         |

### 约束与索引

- `primary key(owner_id, idempotency_key)`，并发重试在 PK 上串行。
- `index(expires_at)`，过期清理。

### 写入规则

- [Required] 首写与 conversation/message/run 同一事务；冲突时回滚并重放赢家。
- 行可删除（仅重放台账，不是只追加账本）。

## `tool_invocations`

### 用途与字段

[Required] tools拥有稳定逻辑调用身份及接受结果（0014）。不以参数、request或attempt定义身份，不把只追加审计当结果账；无短TTL/自动键复用。

| 字段                                                    | 类型/约束                             | 用途                                                                             |
| ------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| invocation_id                                           | uuid PK                               | TS生成的持久调用引用                                                             |
| owner_id / conversation_id / run_id                     | uuid not null                         | 逻辑归属，调用conversations公共用例验证；不跨模块建强FK                          |
| call_key                                                | text，1–200字符                       | Run内动作slot；unique(run_id,call_key)                                           |
| first_attempt_id / first_request_id                     | uuid / text not null                  | 首次预约追踪，重交不改身份                                                       |
| tool_id / args_hash / args_bytes                        | text / 64位小写SHA256 / 非负integer   | domain版本化的原始JSON规范摘要与UTF8长度；不存raw args                           |
| execution_kind                                          | local / read_only / non_transactional | 由可信TS绑定，不采纳远程自报风险                                                 |
| frozen_context                                          | jsonb object not null                 | 首次接收/anchor、timezone、fold及规则/alias版本                                  |
| state                                                   | reserved / unknown / completed        | 本地reserved→completed；非事务reserved→unknown→completed；许可前denied可直接完成 |
| outcome_kind                                            | nullable封闭集                        | success / approval_pending / clarification / time_error / denied / failed        |
| result_version / accepted_result                        | nullableinteger/jsonb                 | completed时版本1和非空object；DB上限262144字节，应用再做strict有界安全投影校验   |
| approval_id                                             | nullableuuid逻辑引用                  | 仅approval_pending有值；不唯一，不复制批准正文                                   |
| accepted_attempt_id / accepted_request_id / accepted_at | nullableuuid/text/timestamptz         | 首次接受追踪，completed时全部非空                                                |
| evidence_ref                                            | nullabletext                          | 非事务确证的安全证据引用，不存原始provider响应                                   |
| created_at                                              | timestamptz default now()             | 预约时间；index(owner_id,run_id,created_at)                                      |

[Required] reserved/unknown不得带结果字段；unknown只适用于non_transactional。身份/摘要/冻结上下文建后不可改，DB trigger拒绝非法迁移、completed改写及删除。批准只保存ID、fireAt/hash/版本材料，由所属公开冻结快照用例恢复原输出；终态不使旧调用重新创建批准。

[Required] 本地批准/接受结果/审计同事务，失败全部回滚，预约保留；未知外部效果不重发。当前归属/allowlist门先于结果披露，遮蔽不覆写已接受事实。完整执行与重放合同见design/04 §3、06 §10。

## `tool_calls`

### 用途

[Required] ToolGateway每次提交的只追加审计（0011/0014）；UPDATE/DELETE由trigger拒绝。它不是工具效果或已接受结果的唯一性真源。

### 字段

| 字段            | 类型          | 约束                                             | 说明                                                                             |
| --------------- | ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `id`            | `uuid`        | primary key                                      | 行 ID                                                                            |
| `owner_id`      | `uuid`        | not null, references `users(id)`                 | 所属用户                                                                         |
| `run_id`        | `uuid`        | not null, references `agent_runs(id)`            | 所属 run                                                                         |
| `attempt_id`    | `uuid`        | nullable, references `run_attempts(id)`          | 所属 attempt                                                                     |
| `tool_id`       | `text`        | not null                                         | 工具名（含被拒的未知工具）                                                       |
| `args_hash`     | `text`        | not null                                         | 参数规范摘要；新记录按带domain的SHA-256，旧行不伪回填                            |
| `decision`      | `text`        | not null                                         | `allow` / `deny`                                                                 |
| `approval_id`   | `uuid`        | nullable, references `approvals(id)`             | 高风险工具产出的确认单                                                           |
| `error_code`    | `text`        | nullable                                         | 拒绝/失败原因码                                                                  |
| `invocation_id` | `uuid`        | nullable，FK tool_invocations ON DELETE RESTRICT | legacy为空，新提交关联稳定引用                                                   |
| `request_id`    | `text`        | nullable                                         | legacy为空，新提交追踪                                                           |
| `record_kind`   | `text`        | not null，default legacy                         | legacy / accepted / replayed / denied / failed / dispatch / unknown / reconciled |
| `outcome_kind`  | `text`        | nullable封闭集                                   | 六类接受结果或unknown                                                            |
| `created_at`    | `timestamptz` | not null, default `now()`                        | 调用时间                                                                         |

### 约束与索引

- `unique(run_id,tool_id,args_hash)`由0014删除；同参数新调用与多次提交审计均合法，唯一身份见tool_invocations。
- `index(run_id,created_at)`和`index(invocation_id,created_at)`支持追踪；不从legacy行伪造已接受结果。
- legacy记录的invocation/request均NULL；新record_kind必须同时含引用及request。只追加trigger保持不变；升级停旧写者，不能混跑仍依赖旧ON CONFLICT约束的程序（见迁移索引）。

## `agent_revisions`

### 用途

[Required] Agent 不可变版本（a13n `agent + revision`）。DB 禁改，错了发新版。

### 字段

| 字段              | 类型          | 约束                      | 说明                                                                                |
| ----------------- | ------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `id`              | `uuid`        | primary key               | 行 ID（内部）                                                                       |
| `owner_id`        | `uuid`        | nullable                  | NULL 表示全局共享 revision；非 NULL 为用户私有定制（v0 全 NULL，[Deferred] 私有化） |
| `name`            | `text`        | not null                  | agent 名（v0 仅 `assistant`）                                                       |
| `revision`        | `text`        | not null                  | 不可变版本号（如 `r1`），发布后冻结                                                 |
| `prompt_version`  | `text`        | not null                  | 关联的 prompt 版本（逻辑引用）                                                      |
| `tools_allowlist` | `jsonb`       | not null, default `'[]'`  | 默认工具白名单                                                                      |
| `created_at`      | `timestamptz` | not null, default `now()` | 发布时间                                                                            |

### 约束与索引

- `unique(name, revision)`，版本唯一。
- [Required] 建后禁 `UPDATE`/`DELETE`（DB 权限/trigger 三选一，行为必须保证）。

## `prompt_versions`

### 用途

[Required] Prompt 不可变版本。回显模板带版本，旧 approval 用旧模板直到过期（B06 §5）。

### 字段

| 字段           | 类型          | 约束                      | 说明                                                                                 |
| -------------- | ------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `id`           | `uuid`        | primary key               | 行 ID（内部）                                                                        |
| `name`         | `text`        | not null                  | 模板名（如 `confirm_preview`）                                                       |
| `version`      | `text`        | not null                  | 不可变版本号                                                                         |
| `content_hash` | `text`        | not null                  | 模板内容哈希（存哈希不存大文本正文的可选；[Proposed] 正文另存对象存储，DB 只留哈希） |
| `created_at`   | `timestamptz` | not null, default `now()` | 发布时间                                                                             |

### 约束与索引

- `unique(name, version)`，版本唯一。
- [Required] 建后禁 `UPDATE`/`DELETE`。

### 写入规则

- [Required] 语言是独立维度：切语言重生成重确认，不复用旧 `presentation_hash`。
- [Required] 旧模板有显示 bug → 作废旧 approval 重来，不悄悄替换模板内容。
