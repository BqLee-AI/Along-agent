# 05 对话运行时与预算

| 状态     | 范围                                                                                                              | 不包含                                                                               | 阶段标签                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Proposed | conversation/run/attempt/trace ID 边界、run/attempt 状态机、AgentRunRequest、双预算、中断恢复、Cangjie 第二实现位 | 会话 CRUD API 形状（api 真源）、Postgres 表定义（schema 真源）、Spike S1–S3 验收执行 | v0：TS AgentRuntime 唯一实现；Cangjie 远程实现 v0–P3 不用 |

## ID 边界（ID-first，一句话一个）

[Required]

| ID                | 粒度       | 说明                                                                                                 |
| ----------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `conversation_id` | 一串对话   | 用户+对端的一次持续会话；SSE 断线重连仍同一 conversation，新建 run 续写                              |
| `run_id`          | 一轮触发   | 一条用户消息（或一次简报调度）触发的一次 tool-loop 执行；预算按 run 计                               |
| `attempt_id`      | 一次续跑   | run 中断后 resume 产生新 attempt，`attempt_no` 递增；副作用幂等键绑 `(run_id, attempt_no, tool_seq)` |
| `trace_id`        | 全链路追踪 | 跨 BFF→Agent→网关→Scheduler 全链路 `request_id` 透传；日志/审计/outbox 同键关联                      |

- [Required] 跨模块只传 id；`run → attempt → tool_invocation → approval → task` 链条全部可由 id 反查，不透传大对象。
- [Required] 幂等键：用户消息去重 `request_id`（绑 C 走 24h+30 天，B06 §7）；工具副作用幂等键 `(run_id, attempt_no, tool_seq)`；确认幂等靠 approval 行状态机（consumed 重复确认回原 task）。

## run / attempt 状态机

[Required] run 状态（TS 权威，内存+会话落库双记，以落库为准）：

```text
run: queued -> running -> { done | budget_exceeded | interrupted | failed }
  interrupted --resume--> running（新 attempt）
  failed 不自动重跑；用户重发即新 run
```

[Required] attempt 状态：

```text
attempt: started -> { completed | approval_pending | interrupted | failed }
  approval_pending --resolve(approve/reject)--> started（同 attempt 续 loop，不增 attempt_no）
  interrupted --resume--> 新 attempt（attempt_no+1，checkpoint 重放）
```

- [Required] `approval_pending` 不占预算等待：挂起期间不计 token/iteration；resolve 后同 attempt 继续，预算接着算。
- [Required] `interrupted`（SSE 断线/进程重启/kill）只保留 checkpoint，不保留 loop 内存态；resume 必经 checkpoint 重放（下节）。
- [Proposed] Cangjie 远程实现（`CangjieAgentRuntime`）跑同一状态机：经 HTTP/SSE 调 `POST /v1/agent/run`，`approval_required` 事件映射为 `approval_pending`，`checkpoint` 事件映射为 run_checkpoints 行；行为差异只允许在传输层，不在状态语义层。

## AgentRunRequest（字段 describe）

[Required] BFF → AgentRuntime 唯一入口参数：

| 字段               | 类型                       | 必填 | 说明                                                  |
| ------------------ | -------------------------- | ---- | ----------------------------------------------------- |
| `conversation_id`  | string                     | 是   | 归属会话                                              |
| `user_id`          | string（注入）             | 是   | BFF 鉴权后注入，Agent/LLM 不可改                      |
| `input_text`       | string                     | 是   | 用户原话；按不可信解析（B06 §7：原样转发）            |
| `received_at_utc`  | string                     | 是   | BFF 共享可信钟盖戳；"明天"锚用它，不用客户端钟        |
| `context_messages` | msg[0–N]                   | 是   | 会话上下文最近 N 轮（N 见预算），服务端拼，LLM 不拉库 |
| `tools_allowlist`  | string[]                   | 是   | 本次可见工具子集；网关强制执行                        |
| `budget`           | Budget                     | 是   | 双预算（下节），TS 权威计数                           |
| `mode`             | enum(chat, brief)          | 是   | chat 走对话链，brief 走 03 简报链（无工具）           |
| `resume_from`      | {run_id, attempt_no}\|null | 否   | 中断续跑指针；null=新 run                             |

## 双预算（TS 权威计数，LLM 只被告知）

[Required]

| 预算             | 起步值（待校准）            | 计数权威                      | 超限行为                                                        |
| ---------------- | --------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `max_iterations` | 10                          | TS 侧 tool-loop 计数器        | 即停，返回已产出 + `BUDGET_EXCEEDED` 事件，前端话术见 04        |
| `max_tokens`     | 8000（chat）/ 2000（brief） | TS 侧按 provider 计费回调累加 | 即停，不等当前流补尾；已流出 delta 保留，未完成 proposal 不建 C |

- [Required] 超时分层熔断：单次模型调用超时 < 单工具超时 < 整 run 超时，层层熔断；超时记 `interrupted`，可 resume。
- [Required] 预算值全为实验起步（与 24h/15min/1min/30s/3退避同性质，云端待校准，以自家可测指标为准）；调参只改服务端配置，不改 LLM prompt、不改契约。
- [Required] 所有 tool_call/tool_result 打结构化日志（tokens/iterations/latency），复盘烧多少 token 有据可查。

## 中断恢复（checkpoint 边做边存档）

[Required] 每次 tool 调用后记 checkpoint 行：

| 字段                                 | 说明                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `run_id, attempt_no, tool_seq`       | 定位                                                       |
| `tool_id, args_hash, result_summary` | 步骤+结果摘要（结果全文不存，大结果只存引用）              |
| `lease_id, lease_expires_at`         | 续跑租约（fencing：过期 lease 的 resume 请求拒绝，防双跑） |
| `recorded_at_utc`                    | 追加时间                                                   |

- [Required] resume 流程：`resume_from{run_id, attempt_no}` → 验 lease 有效 → 新 `attempt_no+1` → 重放 checkpoint 摘要为上下文（不重调已成功工具；副作用工具看幂等键去重）→ 继续 loop。
- [Required] kill -9 语义：重启后旧 attempt 标 `interrupted`（lease 过期自动转）；副作用恰好一次由幂等键+网关去重保证（Spike S2 验收：kill 后 resume 副作用恰好一次）。
- [Required] SSE 断线：前端凭 `conversation_id+run_id` 重连，服务端重放已产出事件（thread-stream 版本化事件，见 design），不重跑 loop。

## 与 design/04 的一致性

- 本篇状态机/Request/预算/checkpoint 为 design/04 AgentRuntime 节的 Agent 侧投影；表定义与 API 形状以 design/api/schema 真源为准。
- CangjieAgentRuntime 为第二实现：远程 HTTP/SSE，只认同一 `AgentRunRequest`/同一事件契约；v0–P3 不用；排期回调 `propose_task`，永不直连业务库、不做时间归一。
