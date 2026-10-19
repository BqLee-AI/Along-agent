# Conversation & Runs Schema 设计

> 状态：v0 可开工。范围：`conversations`、`messages`、`agent_runs`、`run_attempts`、`run_checkpoints`、`agent_revisions`、`prompt_versions`。不包含：向量记忆/知识库（P1）、用量计费、推送。阶段标签：v0 MVP（对话+执行存档）；P1 起五缝 AgentRuntime 接口化。

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

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | 会话 ID |
| `owner_id` | `uuid` | not null | 所属用户，查询必带 |
| `title` | `text` | not null, default `''` | 会话题，可由首问生成；不影响语义 |
| `status` | `text` | not null, default `'open'` | 按 `open/closed` 约束 |
| `confirmed_timezone_id` | `text` | nullable | 本会话已确认时区；“明天”锚，未确认则 NULL |
| `anchor_received_at_utc` | `timestamptz` | nullable | 服务端首次接收时刻（“明天”锚钟），冻结后不再重算 |
| `created_at` | `timestamptz` | not null, default `now()` | 创建时间 |
| `updated_at` | `timestamptz` | not null, default `now()` | 更新时间 |

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

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | 消息 ID |
| `owner_id` | `uuid` | not null | 所属用户，查询必带 |
| `conversation_id` | `uuid` | not null, references `conversations(id)` on delete restrict | 所属会话 |
| `role` | `text` | not null | 按 `user/assistant/system` 约束 |
| `content` | `text` | not null | 消息正文（用户原话原样存；助手回复存最终合并文本） |
| `request_id` | `text` | nullable | 全链路 `request_id`，幂等/排查用 |
| `created_at` | `timestamptz` | not null, default `now()` | 创建时间 |

### 约束与索引

- `index(conversation_id, created_at)`，会话内按序读回。
- `index(owner_id, created_at desc)`，跨会话排查。
- `unique(request_id)`（非 NULL 唯一，迁移 0002），防 BFF 重发导致重复落库。

### 写入规则

- [Required] 用户原话原样转发、按不可信解析；不改写、不截断语义。
- [Required] 不存完整模型推理链与 provider 原始响应（只存最终文本 + 摘要）。

## `agent_runs`

### 用途

[Required] 一次 Agent 执行（v0：提醒路归一/澄清/回显生成）。对应 a13n `run`（durable run 封存）。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | run ID |
| `owner_id` | `uuid` | not null | 所属用户，查询必带 |
| `conversation_id` | `uuid` | not null, references `conversations(id)` on delete restrict | 所属会话 |
| `agent_revision` | `text` | not null | 不可变 agent 版本号（逻辑引用 `agent_revisions.revision`） |
| `mode` | `text` | not null | 按 `chat/task` 约束（v0 提醒路多为 `task`，纯问为 `chat`） |
| `status` | `text` | not null, default `'running'` | 按 `running/suspended_approval/done/failed/cancelled` 约束 |
| `budget_max_iterations` | `integer` | not null | 最大迭代（防死循环，v0 小值） |
| `budget_max_tokens` | `integer` | not null | 最大 token（防烧钱） |
| `created_at` | `timestamptz` | not null, default `now()` | 创建时间 |
| `ended_at` | `timestamptz` | nullable | 结束时间 |

### 约束与索引

- `index(conversation_id, created_at)`，会话内执行历史。
- `index(owner_id, status)`，按状态排查。

### 写入规则

- [Required] 创建时冻结 `agent_revision`；执行中不换版本。
- [Required] 超预算即停并返回已产出（B04 §6）。

## `run_attempts`

### 用途

[Required] run 的单次尝试（fenced 执行 + lease，a13n 落点）。kill -9 后 resume 开新 attempt，副作用恰好一次（S2 要求）。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | attempt ID |
| `owner_id` | `uuid` | not null | 所属用户，查询必带 |
| `run_id` | `uuid` | not null, references `agent_runs(id)` on delete restrict | 所属 run |
| `attempt_no` | `integer` | not null | 第几次尝试，从 1 递增 |
| `lease_token` | `uuid` | nullable | fencing 租约令牌；Scheduler claim 持有者 |
| `lease_expires_at` | `timestamptz` | nullable | 租约过期时间 |
| `status` | `text` | not null, default `'running'` | 按 `running/done/failed/fenced_out` 约束 |
| `created_at` | `timestamptz` | not null, default `now()` | 创建时间 |
| `ended_at` | `timestamptz` | nullable | 结束时间 |

### 约束与索引

- `unique(run_id, attempt_no)`，尝试序号唯一。
- `index(run_id, created_at)`，按 run 回放。

### 写入规则

- [Required] 同一 run 同时只有一个 `running` attempt（应用层 + lease 保证）。
- [Required] 失活 attempt 标 `fenced_out`，不删；resume 开新 `attempt_no`。

## `run_checkpoints`

### 用途

[Required] 边做边存档（a13n checkpoint）。每次 tool 调用后写一条，重启/超时后带 `resume_from` 重放继续。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | checkpoint ID |
| `owner_id` | `uuid` | not null | 所属用户，查询必带 |
| `attempt_id` | `uuid` | not null, references `run_attempts(id)` on delete restrict | 所属 attempt |
| `seq` | `bigint` | not null | attempt 内序号，从 1 递增 |
| `event_seq` | `bigint` | not null, unique, default `nextval` | 全局跨会话流游标；`GET /conversations/{id}?after_seq=` 只做不透明比较 |
| `kind` | `text` | not null | 按 `thinking/tool_call/tool_result/approval_required/answer/thread.started/message.delta/card.proposed/thread.completed/thread.failed/thread.cancelled` 约束（v1 冻结词集，见 `packages/stream-protocol`） |
| `payload` | `jsonb` | not null, default `'{}'` | 结构化摘要（tool 名 + 参数摘要 + 结果摘要）；不存敏感原文 |
| `stream_protocol_version` | `text` | not null | 投影协议版本（`packages/stream-protocol` 版本号），AG-UI 投影依据 |
| `created_at` | `timestamptz` | not null, default `now()` | 创建时间 |

### 约束与索引

- `unique(attempt_id, seq)`，attempt 内序号唯一。
- `unique(event_seq)`，全局流游标唯一。
- `index(attempt_id, event_seq)`，重放按序读；跨会话游标用 `event_seq`。

### 写入规则

- [Required] 只追加，禁 `UPDATE`/`DELETE`。
- [Required] `payload` 不存敏感值原文；tool 参数摘要脱敏。

## `conversation_idempotency`

### 用途

[Required] 入站 `Idempotency-Key` 绑定（迁移 0011）。一个 `(owner_id, idempotency_key)` 一行，先写者赢；重复 POST 原样重放已存 `run_checkpoints`。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `owner_id` | `uuid` | not null, references `users(id)` | 所属用户 |
| `idempotency_key` | `text` | not null | 客户端键；缺省回退 body `idempotency_key` 或 `request_id` |
| `request_hash` | `text` | not null | 规范化请求体 SHA-256；同键不同体返回 `409 STATE_CONFLICT` |
| `conversation_id` | `uuid` | not null, references `conversations(id)` | 命中的会话 |
| `run_id` | `uuid` | not null, references `agent_runs(id)` | 命中的 run |
| `user_message_id` | `uuid` | nullable, references `messages(id)` | 该次用户消息 |
| `created_at` | `timestamptz` | not null, default `now()` | 创建时间 |
| `expires_at` | `timestamptz` | not null | 24h 重放窗口 |

### 约束与索引

- `primary key(owner_id, idempotency_key)`，并发重试在 PK 上串行。
- `index(expires_at)`，过期清理。

### 写入规则

- [Required] 首写与 conversation/message/run 同一事务；冲突时回滚并重放赢家。
- 行可删除（仅重放台账，不是只追加账本）。

## `tool_calls`

### 用途

[Required] ToolGateway 每次调用的审计行（迁移 0011）。只追加，`UPDATE/DELETE` 由 trigger 拒绝。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | 行 ID |
| `owner_id` | `uuid` | not null, references `users(id)` | 所属用户 |
| `run_id` | `uuid` | not null, references `agent_runs(id)` | 所属 run |
| `attempt_id` | `uuid` | nullable, references `run_attempts(id)` | 所属 attempt |
| `tool_id` | `text` | not null | 工具名（含被拒的未知工具） |
| `args_hash` | `text` | not null | 参数规范化 SHA-256；不存原文 |
| `decision` | `text` | not null | `allow` / `deny` |
| `approval_id` | `uuid` | nullable, references `approvals(id)` | 高风险工具产出的确认单 |
| `error_code` | `text` | nullable | 拒绝/失败原因码 |
| `created_at` | `timestamptz` | not null, default `now()` | 调用时间 |

### 约束与索引

- `unique(run_id, tool_id, args_hash)`，同一 run 的重试幂等。
- `index(run_id, created_at)`，按 run 回放。

## `agent_revisions`

### 用途

[Required] Agent 不可变版本（a13n `agent + revision`）。DB 禁改，错了发新版。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | 行 ID（内部） |
| `owner_id` | `uuid` | nullable | NULL 表示全局共享 revision；非 NULL 为用户私有定制（v0 全 NULL，[Deferred] 私有化） |
| `name` | `text` | not null | agent 名（v0 仅 `assistant`） |
| `revision` | `text` | not null | 不可变版本号（如 `r1`），发布后冻结 |
| `prompt_version` | `text` | not null | 关联的 prompt 版本（逻辑引用） |
| `tools_allowlist` | `jsonb` | not null, default `'[]'` | 默认工具白名单 |
| `created_at` | `timestamptz` | not null, default `now()` | 发布时间 |

### 约束与索引

- `unique(name, revision)`，版本唯一。
- [Required] 建后禁 `UPDATE`/`DELETE`（DB 权限/trigger 三选一，行为必须保证）。

## `prompt_versions`

### 用途

[Required] Prompt 不可变版本。回显模板带版本，旧 approval 用旧模板直到过期（B06 §5）。

### 字段

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key | 行 ID（内部） |
| `name` | `text` | not null | 模板名（如 `confirm_preview`） |
| `version` | `text` | not null | 不可变版本号 |
| `content_hash` | `text` | not null | 模板内容哈希（存哈希不存大文本正文的可选；[Proposed] 正文另存对象存储，DB 只留哈希） |
| `created_at` | `timestamptz` | not null, default `now()` | 发布时间 |

### 约束与索引

- `unique(name, version)`，版本唯一。
- [Required] 建后禁 `UPDATE`/`DELETE`。

### 写入规则

- [Required] 语言是独立维度：切语言重生成重确认，不复用旧 `presentation_hash`。
- [Required] 旧模板有显示 bug → 作废旧 approval 重来，不悄悄替换模板内容。
