# 04. 五缝契约（AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：五个重点能力边界、同步公共用例/DTO/读取投影、受控确认事务、可靠异步 outbox 与跨语言职责
- **不包含**：R1 实现、最终远程字段/API、具体 SQL、供应商与密钥
- **阶段标签**：v0 TS 现状与 R1 仓颉 Harness 目标分列；不要求全模块远程化

## 引用

- B03 §2 服务划分、§3 通信、§5 存储；B04 仓颉职责边界；B05 阶段 1/4/5；B06 §6/§9/§10
- AF（harness 可替换、checkpoint、自托管）；外部产品形态（任务卡确认）只作参照

## 0. 设计结论

- [Required] 五缝是主要可替换能力边界，不是所有跨模块调用的唯五入口。同步公共用例、显式 DTO 与只读投影合法；身份/资源关联 ID-first，不共享可写存储对象（02 §1–§2）。
- [Required] 仅需事务后可靠异步投递的命令/事件经 outbox；确认消费与创建任务或取消请求保留单事务。实时网关调用、公共读取、SSE 投影不因此强制入队。
- [Required] 仓颉为唯一宿主 Harness，TS 长期保留能力/业务/存储；v0 确定性 turn 不是已实现的 TS 通用 Agent 或仓颉第二实现基线（09/11；ADR 0009）。
- [Required] 仓颉永不直连业务库、不做时间归一；需排期必须回调 `propose_task`，由 TS 走 time-core（见 05）。
- [Deferred] 连接器真实授权（OAuth/密钥托管）、向量库选型、Redis 队列：本篇只定引用形状，不定供应商字段。

## 1. 总览与选型

| 缝             | 职责一句话                                                    | v0 落点                                           | P1+                                                   |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| AgentRuntime   | 仓颉负责模型/工具循环、当前上下文、计划、预算、等待/恢复/停止 | TS 确定性 turn、Run/事件存储；无真实 LLM          | 仓颉唯一 Harness；TS Run 持久化与业务执行资格继续保留 |
| ToolGateway    | 白名单 + 校验 + 风险分级 + 审计                               | 本地 3~5 工具（时间只读、便签读写类），无外部 MCP | MCP 经网关聚合，仓颉只认网关                          |
| Scheduler      | 登记 schedule / 认领 lease + fencing / cancel                 | PG lease（见 08），无 Redis                       | 量大再议 Redis 延后项                                 |
| Notifier       | send → 回执 + 幂等                                            | 站内信（应用内通知）先行                          | 邮件/推送后期，接口不变                               |
| ConnectorVault | secret 引用不出明文                                           | 仅接口 + Fake，无真实连接                         | 第 1~2 真实连接按评审接入                             |

## 2. AgentRuntime（目标语义，非现有远程 API）

[Proposed] 下列形状只说明能力关联，字段、传输及可信授权绑定随 R1 合同定义，不把同进程 ctx 原样发布为仓颉可自报的权限。

```text
AgentRuntime.run(input) -> AgentEvent stream
  input
    run_id / request_id / idempotency_key
    owner_id / conversation_id
    mode                  chat | task（v0 只用 chat + 单 propose_task）
    tools_allowlist       缺省最小集
    budget                max_iterations / max_tokens
  AgentEvent（名开工对照 packages/stream-protocol，版本化 zod）
    thinking / tool_call / tool_result
    clarification_required（含 time-core 错误透传）
    approval_proposed（含 approval_id 引用，不含快照明文外泄；S0 #14 冻结：对外 SSE 投影为 `approval_required`，见 `docs/api/conversations/conversations_routes.md §2`）
    answer / done / run_failed（含 BUDGET_EXCEEDED；S0 #14 冻结：对外投影为 `message.delta+thread.completed` / `thread.failed`）
AgentRuntime.resume(run_id, resume_from_checkpoint)
AgentRuntime.cancel(run_id)
```

- [Required] 仓颉组织本次上下文和执行转移，经 TS 接口保存/读取运行快照与已接受结果；TS 存储不独立选择下一模型/工具步骤，仓颉不另建可独立裁决的事实库。
- [Required] 仓颉强制执行迭代/token/时间预算，TS 校验配置并在工具侧约束执行资格；不信任模型自报 usage，不把 v0 字符估算冒充真实 provider usage。
- [Required] 敏感工具经 TS 批准门；拒绝不得绕路完成同一未授权效果。v0 提议后结束，R1 同 Run 等待/唤醒尚未实现。
- [Required] 跨语言消费者合同复用已有 contracts-dual 入口；当前 D8 healthz 双跑不证明 run/resume/cancel、工具结果或等待恢复已覆盖。
- [Deferred] 多 Agent 线性协同、`@execution` 自定义 plan：远期，不在本契约加方法。

### 实施与验证边界

[Required] 真实模型、TS 工具产物、批准等待/取消与未知结果分别取证，见 11；不再以 TS/Cangjie 两个通用 Agent 竞赛决定仓颉是否转正。具体接口与结果账属于后续 #45/#46/#47，不在 #44 实现。

## 3. ToolGateway（白名单 + zod + 风险分级 + 审计）

```text
ToolGateway.invoke(tool, args, ctx) -> ToolResult
  ctx
    request_id / run_id / owner_id / approval_ref（敏感工具必填）
  gate
    allowlist_check      不在表 → 拒绝（审计记一笔）
    zod_validate         参数结构校验
    risk_class           read_only | write_local | sensitive（敏感必须有 approval consumed）
    audit_append         调谁、何时、何参（脱敏）、何果
```

- [Required] 三道闸顺序：白名单 → 参数校验 → 敏感 HITL；任一不过即停，不执行。
- [Required] v0 不给任意代码执行/网页浏览；MCP 工具一律经网关，仓颉侧不直连 MCP Server。
- [Required] 审计只追加；审计记录跨模块只传 id。
- [Required] TS 网关保留工具定义/校验/授权/记录；memory/grep、MCP、PC/browser、办公 connector 均为 TS 能力。工具不可接收总目标后隐藏完整模型/工具循环冒充仓颉执行。

## 4. Scheduler（schedule / claim lease + fencing / cancel）

```text
Scheduler.schedule(task_id, fire_at_utc, idempotency_key) -> schedule_receipt
Scheduler.claim(due_tasks) -> lease（PG 行锁 + lease_owner + lease_expires，见 08）
Scheduler.cancel(task_id, idempotency_key) -> cancel_receipt | PENDING（无回执即 PENDING）
```

- [Required] 登记成功以回执为准；无回执 task 停 `pending_schedule`。
- [Required] 认领 fencing：`expected_state_version` 对不上不发；版本变/已取消标 SUPERSEDED 不发。
- [Required] 取消优先：cancel 提交后排队重试全作废；触发门禁照拦。

## 5. Notifier（send → 回执 + 幂等）

```text
Notifier.send(task_id, fire_at_utc, idempotency_key, attempt_no) -> receipt | ACK_UNKNOWN
  receipt含 provider_receipt_id；ACK_UNKNOWN 只核对不重发（30s/2min/5min 各核一次，仍未知转持久对账）
```

- [Required] 同一幂等键最多 3 次退避（起步值：首次后 1min、再 5min，待校准）；离原定不足 15min 不试，记 FAILED_DEADLINE_WINDOW 请新建。
- [Required] 口径天花板：receipt 只证明接口收了，不证明用户看见；对外只说“已记录的步骤可核对”。
- [Observed] v0 通道 = 应用内通知；系统通知三问（认幂等键？可按键查？取消可拦？）答不上就按降级写，不假设。

## 6. ConnectorVault（引用 + Fake）

```text
ConnectorVault.resolve(connection_ref, owner_id, purpose) -> secret_handle（不出明文）
  connection_ref  连接引用（用户+应用+授权版本）
  secret_handle   一次性句柄（网关内用即焚，不落业务表）
ConnectorVault.fake() -> 本地假连接（v0 联调用）
```

- [Required] secret 明文不出 Vault、不进业务表、不进日志；业务侧只存 `connection_ref`。
- [Required] v0 仅接口 + Fake；真实连接需过白名单评审（B05 阶段 4），不改仓颉代码、只配网关即可接新 MCP 工具是验收线。
- [Deferred] 具体授权协议、日历/邮箱二选一先做哪个：P0 定，本篇不定。

## 7. 跨模块数据规则

```text
agent_runs / run_attempts / run_checkpoints + lease（a13n checkpoint 落点）
  run_id / attempt_no / checkpoint_seq / event_ref / lease_owner / lease_expires
outbox（可靠异步命令/事件；投递状态可变，非只追加账本）
  event_id / aggregate（task|approval|run）/ aggregate_id / type / payload_ref / request_id / idempotency_key
```

- [Required] 模块归属、ID-first/DTO/投影及确认创建/取消事务遵循 02 §1–§2。D1 检测存储实现导入，不证明 SQL 所有权；outbox 自身状态可变，不能把它等同于只追加 task_events。
- [Required] 不可变 revision：agent / skill / prompt + `presentation_version` + `tzdb_version` + `ruleset_id` 进快照；DB 禁改，错了发新版。
- [Required] AG-UI 投影：`packages/stream-protocol` 版本化 zod；事件名开工对照 `thread-stream.schema.json`。
- [Required] 不支持组合 → `/readyz` 类型化错误不降级（缺规则/tzdb 直接 503 不开张）。

## 8. 反事实检查表

| 反事实             | 后果                    | 契约对策                                                      |
| ------------------ | ----------------------- | ------------------------------------------------------------- |
| 写侧任意读写他人表 | 规则/权限绕过、改表耦合 | [Required] 所属公共用例；明确只读投影与确认事务例外；SQL 另审 |
| 网关外直调 MCP     | 白名单/审计被绕过       | [Required] 仓颉只认网关                                       |
| 仓颉直连业务库     | 鉴权/隔离击穿           | [Required] 上下文由调用方传入                                 |
| LLM 算时间         | DST/歧义不可复现        | [Required] 时间只经 time-core（见 05）                        |
| 展示层换算时间     | 摆与存对不上            | [Required] 展示只读冻结字段（见 06）                          |
| cancel 可复活      | 取消后仍响              | [Required] 取消终态，核对“曾排上”也不复活                     |
