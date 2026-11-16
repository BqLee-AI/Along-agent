# Conversation & Runs Schema 设计

> 状态：业务与正式 Harness 存储合同。范围：对话/Run/attempt、只追加事件/有限快照、冻结执行权威与调用接受结果。不包含：任意崩溃自动恢复或通用 exactly-once。TS 长期持有 PostgreSQL 与事实，仓颉组织循环和本次上下文（design/09/11）。

> 新委托 Run 在 `frozen_context` 独立冻结授权修订、实际能力、工作区资格和实际 `request-bound` 或 `server-owned` 生命周期，供 v6 trusted start 与只读投影；`0021_trusted_execution_goals.sql` 增加根列 `agent_runs.goal_result`。旧 Run/pending/快照/模板/hash/accepted result 不迁写或扩权，历史结果保持 NULL；snapshot 仍为2。新委托 SSE 为 v2，legacy/v1 历史保持。本页不构成运行验收。

> Proposed 本人模型配置的独立版本引用和冻结显示快照见 [模型接入 schema](model-provider-schema.md)；原 `run_context_policies` 严格结构及旧历史不迁写，具体切换与旧等待处置见 [design/22](../design/22-model-provider-settings.md)。

> R3（#144，Proposed）：[design/23](../design/23-r3-short-term-memory-and-compact.md)提出独立安全点、摘要覆盖、短期记忆及可重建向量索引；表名、迁移和新状态尚未落地，本篇现行字段/快照合同及旧 Run 不变。

## 设计依据

- B03 §4.1 在线对话数据流：BFF 拉上下文 → 调 Agent → SSE → 落库本轮对话 [B03]。
- a13n 落点：`run/attempt` fenced 执行、`checkpoint/display` 每个安全边界提交、不可变 revision、AG-UI 投影（`packages/stream-protocol` 版本化 zod，事件名开工对照 `thread-stream.schema.json`）[AF]。
- 既有 business 提醒路保持 v0；R1 harness 复用同一 Run/attempt/调用账，增加有限工作区和独立文档批准，不把文件动作变成调度 task（见 design/14）。

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

| 字段                     | 类型          | 约束                       | 说明                                              |
| ------------------------ | ------------- | -------------------------- | ------------------------------------------------- |
| `id`                     | `uuid`        | primary key                | 会话 ID                                           |
| `owner_id`               | `uuid`        | not null                   | 所属用户，查询必带                                |
| `title`                  | `text`        | not null, default `''`     | 会话题，可由首问生成；不影响语义                  |
| `status`                 | `text`        | not null, default `'open'` | 按 `open/closed` 约束                             |
| `confirmed_timezone_id`  | `text`        | nullable                   | 会话先前明确时区默认值；不是日期锚，未确认则 NULL |
| `anchor_received_at_utc` | `timestamptz` | nullable                   | 历史会话建立锚；保留旧事实，不用于新请求日期锚    |
| `created_at`             | `timestamptz` | not null, default `now()`  | 创建时间                                          |
| `updated_at`             | `timestamptz` | not null, default `now()`  | 更新时间                                          |

### 约束与索引

- `index(owner_id, created_at desc)`，会话列表。
- `index(owner_id, status)`，按状态筛。

### 写入规则

- [Required] 新消息接纳时由 conversations 在事务内读取 DB `clock_timestamp()`，将提醒请求 anchor 与本轮 received 分别冻结到 Run，不从客户端时刻、会话建立锚或模型生成值取锚；会话历史 `anchor_received_at_utc` 保持原事实，不回写或迁移。
- [Required] 时区未确认不猜设备/位置。legacy 可使用会话先前明确时区；新 delegation 只使用本轮明确提示或接纳时实际 identity 偏好，不回退该会话旧值。日期归属仍按 `design/05 §3` 的新请求/可信澄清合同判断，不因同会话永久复用日期。

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

| 字段                            | 类型          | 约束                                                        | 说明                                                                                                                |
| ------------------------------- | ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                            | `uuid`        | primary key                                                 | run ID                                                                                                              |
| `owner_id`                      | `uuid`        | not null                                                    | 所属用户，查询必带                                                                                                  |
| `conversation_id`               | `uuid`        | not null, references `conversations(id)` on delete restrict | 所属会话                                                                                                            |
| `agent_revision`                | `text`        | not null                                                    | 不可变 agent 版本号（逻辑引用 `agent_revisions.revision`）                                                          |
| `mode`                          | `text`        | not null                                                    | 按 `chat/task` 约束（v0 提醒路多为 `task`，纯问为 `chat`）                                                          |
| `status`                        | `text`        | not null, default `'running'`                               | 按 `running/suspended_approval/done/failed/cancelled` 约束                                                          |
| `budget_max_iterations`         | `integer`     | not null                                                    | 接受时冻结；harness 的累计模型迭代上限                                                                              |
| `budget_max_tokens`             | `integer`     | not null                                                    | 可得 usage 的起步上限；缺 usage 不冒充可证明费用                                                                    |
| `execution`                     | `text`        | not null, default business                                  | business/harness，禁止执行中切换                                                                                    |
| `tools_allowlist`               | `jsonb`       | not null, array                                             | 冻结服务端工具范围；历史 business 为[]，不伪造授权                                                                  |
| `frozen_context`                | `jsonb`       | harness 必须 object                                         | 冻结时间/规则/来源和可选 workspace grant/summary；新委托另冻授权修订、生命周期、trustedExecutionContext，不是推理链 |
| `input_message_id`              | `uuid`        | nullable FK messages；harness 必填                          | 该 Run 实际接受的用户消息                                                                                           |
| `waiting_checkpoint_id`         | `uuid`        | nullable FK run_checkpoints                                 | 最后有效批准等待点                                                                                                  |
| `waiting_invocation_id`         | `uuid`        | nullable                                                    | 同 Run 已接受批准提议调用                                                                                           |
| `waiting_approval_id`           | `uuid`        | nullable                                                    | 原冻结批准；当前决议另从公共读取获取                                                                                |
| `goal_result`                   | `jsonb`       | nullable；0021 新增                                         | 根列持久 GoalResult；仅 delegation/1 终态可非空，legacy/历史不回填                                                  |
| `cancellation_scope_candidates` | `jsonb`       | nullable；0027 新增                                         | 服务端呈现的取消候选及原始请求证据；历史 Run 保持空值，不作为公开结果                                               |
| `created_at`                    | `timestamptz` | not null, default `now()`                                   | 创建时间                                                                                                            |
| `ended_at`                      | `timestamptz` | nullable                                                    | 结束时间                                                                                                            |

### 约束与索引

- `index(conversation_id, created_at)`，会话内执行历史。
- `index(owner_id, status)`，按状态排查。

### 写入规则

- [Required] 创建时冻结 execution、owner/conversation、revision、mode、预算、工具范围、上下文与输入引用；0015 trigger 禁止事后改变，终态 Run 不可改写。
- [Required] harness suspended_approval 时三个 waiting 引用必须齐备；其他 harness 状态必须为空。TS 锁内进一步验证实际 owner/Run/已接受调用/批准对应关系，引用本身不作授权。
- [Required] legacy 已接受助手 delta 合并的消息、终态 checkpoint、attempt/Run 同事务；无助手输出的结构化失败不合成助手消息。新 delegation 将真实 GoalResult、其 `answer` 最终消息、终结事件和 Run/attempt 终态同事务提交，不把中间 delta 当最终 answer。取消不能覆盖已提交事实或伪撤销既成效果，失败/断连仍保留真实已接受设置收据及未完成或未知项。
- 新委托在接纳事务冻结 `frozen_context.authorization_revision='delegation/1'`、实际 `execution_lifecycle`（`request-bound` 或 `server-owned`）、本人 `workspaceGrants` 和 `trustedExecutionContext`；HTTP 须显式请求 delegation harness，可选非空去重 `workspace_ids` 收窄集合。可信上下文只含工作区安全摘要；单次 invocation 绑定的 grant 须属于原集合并通过当前资格复验。legacy 仍使用单 `workspaceGrant/workspaceSummary`，旧 Run 和已冻结空集合不回填；不能从模型或当前部署补写旧事实。
- 资料调用在既有 invocation `frozen_context` 冻结单目标 grant；直接编辑冻结同 Run 已接受全文来源、相对路径、基线版本、精确新内容与新版本，可信零写后继另绑定前驱。冻结内容、调用身份和接受结果不可变；`document_effects` 是由真实调用和新读证据组成的只读投影，不是新的效果账。
- `0021` 在0020之后新增根 `goal_result jsonb NULL`；`0022` 将非空结果约束收紧为明确为真，不能以缺失 legacy 字段产生的 SQL NULL 通过 CHECK。非空值必须是 object、Run 冻结 delegation/1、status 为 done/failed/cancelled，目标状态属于 completed/partial/blocked/cancelled/unknown。strict 逐项 shape、收据归属/成功状态和真实偏好事实由 TS 校验；DB 列本身不证明目标达成。RunView 投影冻结授权/生命周期与根结果，不泄漏完整 trusted context。
- 合格新 Run 冻结创建撞名目标恢复能力；可选目标结果声明记录用户消息来源、零写撞名、后续创建和独立新读的引用，不新增目标表或改写调用账。服务端验证归属、顺序、冻结资格与效果事实；声明所表达的自然语言目标关系仍由模型理解，来源引用不构成语义证明。
- 取消候选由服务端在目标结果事务中生成并随终态提交；可信接续读取同 owner、同会话前驱的该证据，按用户所选序号定位历史展示项，并在写入前重核目标当前状态、时间和时区。未选项变化不改变已展示序号；缺少证据的历史 Run 不回填。

### 提醒请求日期来源（#92）

[Required] 复用既有 `frozen_context` JSON 与 0015 不可变约束，不新增列、表或迁移。新 Run 在原消息接纳事务冻结以下值；公开请求只增加可选 `clarification_of_run_id`（见 conversations API），不允许客户端提交内部来源 JSON。

| JSON 字段                               | 语义                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `anchorReceivedAtUtc`                   | 新请求为本轮 DB 接纳时刻；经核验的同一提醒澄清复制原请求锚，不从会话建立时刻取得                              |
| `receivedAtUtc`                         | 本轮 DB 接纳时刻，始终独立冻结；供纯层按确认时区判定真实本地跨日                                              |
| `reminderDateSource.version`            | 固定 `1`                                                                                                      |
| `reminderDateSource.kind`               | `new` 为新请求，`clarification` 为已证明的原提醒澄清，`unresolved` 为关系不明、不授权创建提醒                 |
| `reminderDateSource.inputMessageId`     | 权威原 user 消息；new/unresolved 为本轮输入，clarification 为原提醒输入，与本轮 `input_message_id` 区分       |
| `reminderDateSource.sourceRunId`        | clarification 的实际来源 Run；同 owner/conversation、终态 done/failed、紧邻上一 user 消息                     |
| `reminderDateSource.sourceInvocationId` | clarification 所依据的真实已接受调用：`TIMEZONE_MISSING` 澄清或 `AMBIGUOUS_LOCAL_TIME` 候选失败；不是模型自报 |

conversations 验证消息与 Run 关系，tools 公共来源投影提供实际接受结果；检索同 owner/conversation 全部未完成候选，排除已被后继 `sourceRunId` 引用的源，恰好一个且满足紧邻关系才继承。整条明确时区回复可补原缺时区；fold 必须显式来源引用、原文完全相同及实际候选时区/结构化选择。多个候选、无关中间 user 目标、缺/坏来源及其他不明补充要求完整重述，不猜最新 Run。不存在“终态 Run 自动等于提醒已完成”的推导：仅实际未完成澄清/候选失败属于此候选集合。

gateway 读取当前 Run 的持久来源，约束日期表达等于权威原输入、`raw_time_text` 为原文子串；澄清 `note` 也须为原文子串。所有时区/本地日期运算仍由纯层执行。同 Run 工具/重放、批准恢复及只读历史只消费既有冻结值；缺来源旧 Run 不回填，其历史执行合同保持，不能被新消息用作继承证据。批准/任务快照、未来时间和有效期检查不变。

## R2-A 上下文策略（#83）

[Required] `run_context_policies` 归 conversations，不改变 `agent_runs.frozen_context`、原预算或冻结 allowlist；由 `0019_conversation_context_policies.sql` 建立。策略单位以 [design/18 §3](../design/18-r2a-harness-context.md#3-冻结策略及旧-run) 为真源；应用迁移与实际部署另行取证。

| 字段        | 类型/约束                                     | 语义                                                                                                                             |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| run_id      | uuid PK，FK agent_runs(id) ON DELETE RESTRICT | 每个 harness Run 至多一个策略                                                                                                    |
| owner_id    | uuid NOT NULL                                 | 从可信 Run 注入，所有查询验 owner/Run，不接模型自报                                                                              |
| policy      | jsonb object NOT NULL                         | strict、版本化的 ContextPolicy，不含凭据或工具正文                                                                               |
| policy_hash | text NOT NULL，64 位小写 SHA-256              | 全字段按键名排序的规范 JSON UTF-8，嵌套 model_binding 同样排序；摘要域为 `harness/context-policy/v1` 后接一个 NUL，再接规范 JSON |
| created_at  | timestamptz NOT NULL                          | 首次策略接纳时间，不用于重算 Run 预算                                                                                            |

PK 已支持恢复点查，不新增无查询依据的索引。DB 禁 UPDATE/DELETE；应用及约束验证 policy 正安全整数、枚举/null 语义与 owner/Run 一致性。新 Run 与原接纳事务插入；旧 Run 仅在有效显式批准恢复同事务补录，并发唯一，失败全回滚；GET/历史补读不补录。工具权限仍只由原冻结 allowlist 与当前授权决定。

snapshot2 原字段/集合不变，typed views/context_slice 不写入快照正文，accepted_result 不被投影覆写。wire 使用配套 `harness/v6`，legacy 显式 trusted_context:null，容量/回取及 design/18 的旧 Run 恢复合同不变；旧版本记载保留其历史适用范围，不作为当前 wire 证明。迁移只前向新增并同步生命周期基线/扫描规则，不修改已合并迁移。

## `run_attempts`

### 用途

[Required] 同 Run 的一次有效执行；批准挂起结束当前 attempt，显式恢复创建递增 attempt。每次动作校验最新 running attempt 与实际 Run/权限/取消；server-owned 还在持有同一 PostgreSQL session advisory lock 的事务中比对该 attempt 的 token。旧 pipe 不因持有 UUID 而恢复执行权；这不是通用租约或崩溃自动重放。

### 字段

| 字段               | 类型          | 约束                                                     | 说明                                                     |
| ------------------ | ------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `id`               | `uuid`        | primary key                                              | attempt ID                                               |
| `owner_id`         | `uuid`        | not null                                                 | 所属用户，查询必带                                       |
| `run_id`           | `uuid`        | not null, references `agent_runs(id)` on delete restrict | 所属 run                                                 |
| `attempt_no`       | `integer`     | not null                                                 | 第几次尝试，从 1 递增                                    |
| `lease_token`      | `uuid`        | nullable                                                 | server-owned attempt 的持锁执行 token；旧 attempt 可为空 |
| `lease_expires_at` | `timestamptz` | nullable                                                 | 保留字段，不作为 server-owned 执行资格                   |
| `status`           | `text`        | not null, default `'running'`                            | 按 `running/done/failed/fenced_out` 约束                 |
| `created_at`       | `timestamptz` | not null, default `now()`                                | 创建时间                                                 |
| `ended_at`         | `timestamptz` | nullable                                                 | 结束时间                                                 |

### 约束与索引

- `unique(run_id, attempt_no)`，尝试序号唯一。
- `index(run_id, created_at)`，按 run 回放。

### 写入规则

- [Required] `attempt → Run → invocation` 锁序裁决当前执行资格。同有效批准等待点最多一个恢复 attempt；取消与恢复竞争时重新定位最新 attempt。不由 attempt 递增推导外部效果 exactly-once。

## `run_checkpoints`

### 用途

[Required] 对外 thread 事件与内部 `harness_snapshot` 共用只追加表。只有有效批准等待点有有限恢复语义；历史业务事件不伪造完整执行上下文，普通 checkpoint/lease 不提供通用恢复保证。

### 字段

| 字段                      | 类型          | 约束                                                       | 说明                                                                                                               |
| ------------------------- | ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                      | `uuid`        | primary key                                                | checkpoint ID                                                                                                      |
| `owner_id`                | `uuid`        | not null                                                   | 所属用户，查询必带                                                                                                 |
| `attempt_id`              | `uuid`        | not null, references `run_attempts(id)` on delete restrict | 所属 attempt                                                                                                       |
| `seq`                     | `bigint`      | not null                                                   | attempt 内序号，从 1 递增                                                                                          |
| `event_seq`               | `bigint`      | not null, unique                                           | 全局不透明流游标；before-insert 持 conversation 锁后重新分配，锁持至提交；允许内部行/回滚导致间隙                  |
| `kind`                    | `text`        | not null                                                   | 保留既有内部/七词事件，新增内部 `harness_snapshot` 及 `harness_routing_policy/decision/render`；读取外部流显式过滤 |
| `payload`                 | `jsonb`       | not null, default `'{}'`                                   | 结构化摘要（tool 名 + 参数摘要 + 结果摘要）；不存敏感原文                                                          |
| `stream_protocol_version` | `text`        | not null                                                   | 投影协议版本（`packages/stream-protocol` 版本号），AG-UI 投影依据                                                  |
| `created_at`              | `timestamptz` | not null, default `now()`                                  | 创建时间                                                                                                           |

### 约束与索引

- `unique(attempt_id, seq)`，attempt 内序号唯一。
- `unique(event_seq)`，全局流游标唯一。
- `index(attempt_id, event_seq)`，重放按序读；跨会话游标用 `event_seq`。

### 写入规则

- [Required] 只追加，禁 `UPDATE`/`DELETE`。
- [Required] `payload` 不存敏感值原文；tool 参数摘要脱敏。
- [Required] 新写入/执行使用 `harness/v6`、snapshot `version=2`；harness_snapshot 保存已接受消息/工具结果引用、usage/next_call_no/等待引用，不保存 raw args、provider body、密钥或完整推理链。真实模型增量沿既有 message.delta 持久，不新建数据表。TS 验证同 owner/Run、真实接受事实与单调进度；旧 task snapshot1 的限定读取迁移见本篇 R1 节。
- [Required] 同 conversation 先持 NO KEY UPDATE 锁再分配游标，并保持至提交，避免小游标晚提交被客户端永久漏掉，并与终态消息插入取得的外键 KEY SHARE 兼容。内部快照不交给外部 ThreadEventSchema；GET/同入站键只读不启动执行。

## R2-B 路由策略与内部执行记录（已实现，默认 off，#88）

本节只跟随 [design/19](../design/19-r2b-readonly-intent-routing.md) §7–§10，不改上文 snapshot2 与 R2-A Required 合同。精确 payload、摘要、关联、唯一性及来源约束以 design/19 §8 为主，不在本篇复制字段表；三种 kind 由迁移 `0020_conversation_readonly_routing.sql` 建立，实现存在不等于已启用或已验收路由接管。

- 路由策略不用 `run_context_policies`、新路由表或 Run JSON 列承载，不改 `frozen_context`。复用只追加 `run_checkpoints`，新增内部 `harness_routing_policy`、`harness_routing_decision`、`harness_routing_render` 三种 kind；snapshot2 不加字段。v5 的 start/probe/decide/render 消费关系见 design/19 §7。
- 新 harness Run 在原接纳事务的首 attempt 写不可变 routing policy，off 也记录。旧 Run 缺策略按 off；GET/同键补读/批准 resume 不补路由策略、不分类，R2-A 上下文策略在有效恢复时的独立补录仍按原合同。仅 fresh 首模型前产生一次路由决策；shadow 只记录潜在候选、最终 fallback，不调用候选旁路业务工具。
- 迁移 `0020_conversation_readonly_routing.sql` 扩充 `0015` 的封闭 checkpoint kind check，并落实首 attempt、同 kind 唯一及同 owner/conversation/Run 的真实来源约束；不改已合并迁移。沿原只追加、锁序与 conversation 游标分配，内部行形成游标间隙仍合法。
- 外部读取继续显式只取七词，不将三种内部路由行交给 ThreadEventSchema；HTTP/RunView/execution/SSE 不新增字段或词。策略、潜在候选和决策引用不是浏览器授权、恢复点或工具效果事实。
- direct 决策绑定唯一原 reserve/invoke 的目标/参数和合法来源，不造新的工具结果账。真实成功 accepted_result 与已接受 snapshot 是渲染依据，TS 固定 renderer 在同一事务写原 `message.delta` 与内部 render 回执；finish(done) 须唯一成功结果、render 回执和零模型，不伪造 provider/usage。正文不能由 native 任意传入，详细来源与展示约束见 design/19 §9。
- 接纳 direct 后失败不改走 LLM/新 slot；DB/协议/权限错误不是正常拒识。原取消先提交即拒绝迟到候选/输出，工具已提交事实保留；原入站/取消幂等与只读 GET/重放不变，不重新执行工具、编码或渲染，见 design/19 §10。

## `harness_resumes` / `harness_cancellations`

0015 的最小持久动作关系，均只追加、禁止 UPDATE/DELETE，不另造工具结果账。

| 表                    | 字段与约束                                                                                                        | 语义                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| harness_resumes       | owner_id/idempotency_key 主键；run_id/checkpoint_id/attempt_id 外键；checkpoint_id、attempt_id 各唯一；created_at | 同等待点仅一次有效恢复，同键丢回答定位原 attempt，不另启动 |
| harness_cancellations | owner_id/idempotency_key 主键；run_id 外键；reason、created_at                                                    | 同键同 Run/reason 回原裁决，冲突409；终态只返回真实状态    |

所有读写均验证owner/conversation/Run；历史Run/取消/冻结详情读取不以当前workspace登记为前提，新恢复与工具动作另验当前精确授权。resume只允许最后有效等待点与真实已决批准，拒绝普通/他人/旧引用、business或终态。取消事实先提交才通知native；取消和恢复的幂等身份不代替invocation_id。

## `conversation_idempotency`

### 用途

[Required] 入站 `Idempotency-Key` 绑定（迁移 0011）。一个 `(owner_id, idempotency_key)` 一行，先写者赢；重复 POST 原样重放已存 `run_checkpoints`。

### 字段

| 字段              | 类型          | 约束                                     | 说明                                                                                                                            |
| ----------------- | ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`        | `uuid`        | not null, references `users(id)`         | 所属用户                                                                                                                        |
| `idempotency_key` | `text`        | not null                                 | 客户端键；缺省回退 body `idempotency_key` 或 `request_id`                                                                       |
| `request_hash`    | `text`        | not null                                 | business 保持历史材料；harness沿原域/workspace绑定；提供clarification_of_run_id时追加来源引用，省略不追加；同owner/key异输入409 |
| `conversation_id` | `uuid`        | not null, references `conversations(id)` | 命中的会话                                                                                                                      |
| `run_id`          | `uuid`        | not null, references `agent_runs(id)`    | 命中的 run                                                                                                                      |
| `user_message_id` | `uuid`        | nullable, references `messages(id)`      | 该次用户消息                                                                                                                    |
| `created_at`      | `timestamptz` | not null, default `now()`                | 创建时间                                                                                                                        |
| `expires_at`      | `timestamptz` | not null                                 | 24h 重放窗口                                                                                                                    |

### 约束与索引

- `primary key(owner_id, idempotency_key)`，并发重试在 PK 上串行。
- `index(expires_at)`，过期清理。

### 写入规则

- [Required] 首写与 conversation/message/run 同一事务；冲突时回滚并重放赢家。
- 行可删除（仅重放台账，不是只追加账本）。

## `tool_invocations`

### 用途与字段

[Required] tools拥有稳定逻辑调用身份及接受结果（0014）。不以参数、request或attempt定义身份，不把只追加审计当结果账；无短TTL/自动键复用。

| 字段                                                    | 类型/约束                             | 用途                                                                                                  |
| ------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| invocation_id                                           | uuid PK                               | TS生成的持久调用引用                                                                                  |
| owner_id / conversation_id / run_id                     | uuid not null                         | 逻辑归属，调用conversations公共用例验证；不跨模块建强FK                                               |
| call_key                                                | text，1–200字符                       | Run内动作slot；unique(run_id,call_key)                                                                |
| first_attempt_id / first_request_id                     | uuid / text not null                  | 首次预约追踪，重交不改身份                                                                            |
| tool_id / args_hash / args_bytes                        | text / 64位小写SHA256 / 非负integer   | domain版本化的原始JSON规范摘要与UTF8长度；不存raw args                                                |
| execution_kind                                          | local / read_only / non_transactional | 由可信TS绑定，不采纳远程自报风险                                                                      |
| frozen_context                                          | jsonb object not null                 | 首次时间/规则；workspace调用冻单目标精确grant，直接编辑冻结精确计划，批准 apply 冻 documentApprovalId |
| state                                                   | reserved / unknown / completed        | 本地reserved→completed；非事务reserved→unknown→completed；许可前denied可直接完成                      |
| outcome_kind                                            | nullable封闭集                        | success / approval_pending / clarification / time_error / denied / failed                             |
| result_version / accepted_result                        | nullableinteger/jsonb                 | completed时版本1和非空object；DB上限262144字节，应用JSON序列化上限240000字节                          |
| approval_id                                             | nullableuuid逻辑引用                  | 仅approval_pending有值；不唯一，不复制批准正文                                                        |
| accepted_attempt_id / accepted_request_id / accepted_at | nullableuuid/text/timestamptz         | 首次接受追踪，completed时全部非空                                                                     |
| evidence_ref                                            | nullabletext                          | 非事务确证的安全证据引用，不存原始provider响应                                                        |
| created_at                                              | timestamptz default now()             | 预约时间；index(owner_id,run_id,created_at)                                                           |

[Required] reserved/unknown不得带结果字段；unknown只适用于non_transactional。身份/摘要/冻结上下文建后不可改，DB trigger拒绝非法迁移、completed改写及删除。task批准保存ID、fireAt/hash/版本材料；document提议保存`{kind:"document_approval_receipt",approval_id,presentation_hash}`，经approvals公共冻结receipt恢复完整结果，不复制批准正文到接受账。终态不使旧调用重新创建批准；新引用才产生新读取观察。

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
| `approval_id`   | `uuid`        | nullable, references `approvals(id)`             | 仅旧 task 确认单；文档批准 UUID 不写此列                                         |
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

## R1 工作区与类型化等待增量 [Required]

规范行为见 [design/14](../design/14-r1-document-task-loop.md)，文档表及迁移边界见 [Schema 索引](README.md#r1-文档批准) 和 [commitments](commitments-schema.md#r1-文档批准与决议-required)；HTTP 形状见 [API 索引 §8](../api/README.md#8-r1-工作区与文档批准-required)。

- `agent_runs.frozen_context` 增加 `workspaceGrant={workspace_id,owner_id,registration_digest,root_identity}` 和独立 `workspaceSummary={workspace_id,label,readable_paths,writable_paths}`。不保存真实 root、不单建 workspace 表、不给历史 Run 补授工具。RunView 只投影冻结安全摘要；历史缺摘要不从当前登记补造。
- 历史 Run/事件、取消及冻结文档批准详情可在登记撤销后继续 owner-scoped 读取；摘要不是当前授权。新批准/拒绝、新恢复、新工具动作均核对当前登记与原 grant，撤销/变更使 `can_resume=false`；工具历史结果披露仍有独立当前权限门，不因历史 GET 可读而绕过它。
- 等待继续复用三个 UUID 列；可信已接受提议结果决定 `kind=task|document` 及批准读取入口。document 的 RunView waiting 额外含 `approval_kind:"document"`，旧 task 形状不变。恢复给 native 的 task decision 保留 consumed/task_id/successor_id；document decision 仅 approval_id/status/apply_invocation_id，不制造 task、时间字段或新事件词。
- 新执行与新快照仅 `harness/v5` / snapshot2。读取 snapshot1 时拒绝携 workspace grant，并验证每个 tool_ref 都是 completed 的旧业务工具、非 document receipt；仅转换内存中的版本供 v5 启动，保留原 Run/预算/工具范围和历史行，不改旧 writer 或 completed 事实。
- `workspace_list/grep/read` 为 read_only，事务外 MCP IO 后首次接受有界快照；`workspace_propose_replace` 为 local，批准/receipt/审计同事务；`workspace_apply_replace` 是 non_transactional，原批准唯一绑定在预约事务建立，在 dispatch 一次许可事务再验，先提交 unknown 才可写文件。
- `tool_invocations` 唯一持有接受结果/真实效果；`tools/query.ts#readRunDocumentEvidence` 公开同 Run 安全证据投影，approvals/conversations 不另建效果账。只有绑定的 applied 与其后创建且接受的新全文 read（目标、版本、完整内容及字节数均匹配）才满足完成；conflict 后继须有零写证据、新读和新批准。unknown 不重写、不靠文件 hash 补报成功、不制造可恢复等待点。

接受结果应用上限240000字节与DB262144字节后盾不同；HTTP仍限131072原始JSON字节，文档提议还验证完整确认body再次序列化后的限额。迁移0016新增文档授权/决议，不改既有task表与事件词；实现存在不代表已完成真实模型或用户材料验收。

## R1 历史读取投影与查询索引（#69）

合同真源见 [design/17 §3–§5、§9](../design/17-r1-conversation-history.md)。历史复用原 messages、agent_runs、run_attempts、run_checkpoints 和可信既有引用，不建第二份资料任务/结果事实表。

- 当前新 Run 的 `input_message_id` 指向原样用户消息；读取须同时核 owner、conversation、role。旧空引用仅在既有幂等引用完整无歧义时使用，否则明确不可关联；非空损坏引用标记不完整，不回填猜测关系。
- 终态 assistant message 合并本 Run 已存 delta，但消息本身没有可信 Run 引用。消息档案保留所有允许公开的 user/assistant 内容；各 Run 回复按外部事件读取全部 attempt，不把最终消息重复拼接，不把 system/internal snapshot 公开。
- `0018_conversation_history.sql` 仅增加四个非唯一普通 B-tree 查询索引：`conversations(owner_id,created_at DESC,id DESC)`、`messages(owner_id,conversation_id,created_at,id) WHERE role IN ('user','assistant')`、`agent_runs(owner_id,conversation_id,created_at,id)`、`conversation_idempotency(run_id)`。最后一个服务于旧 Run 缺少 `input_message_id` 的回退查找：按 `run_id` 取全引用后，仍核全部引用的 owner/会话及原话歧义，不因索引加唯一约束或预先排除坏引用。不修改旧迁移或原行。
- 新增索引核验沿 #67 已有 SQL verifier，验证四个索引的真实表、键、非唯一性、定义、有效/就绪/存活状态及版本；同步迁移扫描窄允许项和显式升级覆盖。只核列/约束的 JSON 增量不能冒充新普通索引结构校验，不扩建第二套迁移框架。旧三索引运行记录不视为四索引已验收，新增状态须有独立实际运行证据。
- 列表标题/活动只做所属模块查询投影，分页按不变建立键保留微秒与 ID 顺序；Run 更新不搬页，跨请求不是数据库快照。批准与工具效果仍经所属模块公共只读投影组合，不跨模块直读私表。

## R3 用户安全点暂停

- `harness_pauses` 记录 owner、会话、Run、当前 attempt、幂等键、暂停用途、状态及安全点快照；Run 同时只能有一个 pending 或 paused 暂停。登记请求与持久快照分别代表请求和已到达安全点，不将批准等待写成用户暂停。
- `harness_pause_resumes` 只追加保存用户继续的幂等身份与唯一后继 attempt；相同暂停不可产生多个后继。继续和取消按事务内资格裁决，取消或 Run 终态使未消费暂停失效。
- 快照只由可信运行路径校验及持久化；原消息、已接受工具结果、预算和旧 Run 不回填或改写。暂停不代表可自动从任意崩溃恢复。

## R3 本人短期记忆

- `r3_memories` 保存 owner、当前修订与 active/stopped 状态；`r3_memory_revisions` 只追加，保存内容、来源会话和消息、过期时间。原始消息仍由 conversations 持有；保存和更正需验证本人来源与用户消息资格。
- `r3_memory_requests` 为保存操作提供幂等身份；`r3_memory_recall_receipts` 与已接受的召回结果关联并冻结记忆修订，读取或重放时重新核验当前资格。停止或更正不改写原消息和既有工具事实。
- `r3_memory_vectors` 是按 owner、记忆修订和编码器绑定保存的可重建派生索引；迁移不安装 pgvector。`pause-memory/1` 只使用字面召回，`compact-memory/1` 可使用受配置和来源校验约束的语义候选及 compact 派生记忆。

## R3 compact 与冻结上下文

- `compact_freezes` 和 `compact_freeze_sources` 冻结一次操作的来源集合与前驱版本；`compact_summaries`、`compact_summary_sources` 只追加，`compact_heads` 以版本比较发布。原消息不删除或修改，来源有效仅证明可追溯。
- `compact_operations`、`compact_continuations` 持久化操作状态与唯一后继；`r3_context_freezes` 绑定新 Run 的摘要、未覆盖原消息和输入。`idle_compact_requests` 保存空闲控制动作的幂等身份，不伪装成普通用户消息。
- 0033 以前向迁移扩展 0029 的暂停原因及运行时继续约束，0034–0036 分别引入操作账、上下文冻结及空闲控制输入；旧暂停和冻结合同不回填或改写。新表及触发器按版本验证，迁移不替代备份。
