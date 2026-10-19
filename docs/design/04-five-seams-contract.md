# 04. 五缝契约（AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：五个接缝的职责边界、调用形状（方法名到事件/错误级）、跨模块只传 id、outbox 领域事件、双实现同一契约、反事实检查表
- **不包含**：各缝内部实现代码、具体表结构 SQL、MCP Server 清单、真实连接器密钥；Cangjie 侧实现细节（只定远程契约）
- **阶段标签**：P1 起全接口化（v0 先按本契约跑单实现 + Fake，P2 末 Spike 结案）

## 引用

- B03 §2 服务划分、§3 通信、§5 存储；B04 仓颉职责边界；B05 阶段 1/4/5；B06 §6/§9/§10
- AF（harness 可替换、checkpoint、自托管）；外部产品形态（任务卡确认）只作参照

## 0. 设计结论

- [Required] 五缝是唯五允许跨模块调用的接缝；模块自有 schema，跨模块只传 id + 引用，绝不直接读对方表。
- [Required] 所有跨缝动作经 outbox 领域事件 + `request_id` + 幂等键；contracts 契约测试同一套用例跑进程内实现与远程实现。
- [Proposed] v0 用 TS 单实现 + Fake；CangjieMagic 只作 AgentRuntime 第二实现（远程 HTTP/SSE），v0–P3 不用。
- [Required] 仓颉永不直连业务库、不做时间归一；需排期必须回调 `propose_task`，由 TS 走 time-core（见 05）。
- [Deferred] 连接器真实授权（OAuth/密钥托管）、向量库选型、Redis 队列：本篇只定引用形状，不定供应商字段。

## 1. 总览与选型

| 缝 | 职责一句话 | v0 落点 | P1+ |
| --- | --- | --- | --- |
| AgentRuntime | 跑对话/任务循环，产 AgentEvent 流 | TS 单实现；Spike S1 并行验证 | + CangjieAgentRuntime 远程实现，同一契约 |
| ToolGateway | 白名单 + 校验 + 风险分级 + 审计 | 本地 3~5 工具（时间只读、便签读写类），无外部 MCP | MCP 经网关聚合，仓颉只认网关 |
| Scheduler | 登记 schedule / 认领 lease + fencing / cancel | PG lease（见 08），无 Redis | 量大再议 Redis 延后项 |
| Notifier | send → 回执 + 幂等 | 站内信（应用内通知）先行 | 邮件/推送后期，接口不变 |
| ConnectorVault | secret 引用不出明文 | 仅接口 + Fake，无真实连接 | 第 1~2 真实连接按评审接入 |

## 2. AgentRuntime（run / resume / cancel → AgentEvent）

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

- [Required] 无状态化：runtime 自身不存会话；每次 tool 调用后发 checkpoint，由调用方落 `agent_runs / run_attempts / run_checkpoints`（见 §7）。
- [Required] 预算双护栏：超 `max_iterations` 或 `max_tokens` 即停，事件 `run_failed(BUDGET_EXCEEDED)`，绝不静默截断当成功。
- [Required] 敏感工具只发 `approval_proposed`，不执行；执行必须等 approval consumed 回调。
- [Proposed] 双实现同一契约：`TsAgentRuntime`（进程内）与 `CangjieAgentRuntime`（远程 HTTP/SSE，方法与事件名一一对应）；contracts 同一套断言跑两遍。
- [Deferred] 多 Agent 线性协同、`@execution` 自定义 plan：远期，不在本契约加方法。

### Spike S1（AgentRuntime 远端可行性，与 P1 并行，P2 末结案）

- [Proposed] 结案门：契约全绿 + 100 并发首 token ≤150ms + 30min RSS 不涨 + cancel 2s 内生效。

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
- [Proposed] Spike S3 门：200 卡片 zod 通过率达标 + MCP 经网关 + OTel 贯通 + 镜像构建 ≤10min（与 P1 并行，P2 末结案）。

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
outbox（领域事件，只追加）
  event_id / aggregate（task|approval|run）/ aggregate_id / type / payload_ref / request_id / idempotency_key
```

- [Required] 模块自有 schema；跨模块只传 id（task_id / approval_id / run_id / connection_ref）。
- [Required] 不可变 revision：agent / skill / prompt + `presentation_version` + `tzdb_version` + `ruleset_id` 进快照；DB 禁改，错了发新版。
- [Required] AG-UI 投影：`packages/stream-protocol` 版本化 zod；事件名开工对照 `thread-stream.schema.json`。
- [Required] 不支持组合 → `/readyz` 类型化错误不降级（缺规则/tzdb 直接 503 不开张）。

## 8. 反事实检查表

| 反事实 | 后果 | 契约对策 |
| --- | --- | --- |
| 跨模块直读对方表 | 一处改表全链崩 | [Required] 只传 id，读自己投影 |
| 网关外直调 MCP | 白名单/审计被绕过 | [Required] 仓颉只认网关 |
| 仓颉直连业务库 | 鉴权/隔离击穿 | [Required] 上下文由调用方传入 |
| LLM 算时间 | DST/歧义不可复现 | [Required] 时间只经 time-core（见 05） |
| 展示层换算时间 | 摆与存对不上 | [Required] 展示只读冻结字段（见 06） |
| cancel 可复活 | 取消后仍响 | [Required] 取消终态，核对“曾排上”也不复活 |
