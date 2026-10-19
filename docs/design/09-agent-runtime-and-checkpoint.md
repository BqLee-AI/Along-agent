# 09. AgentRuntime 与 Checkpoint 设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：TsAgentRuntime 职责与不信任原则、AgentEvent 词汇、run/attempt 状态图、checkpoint（P1/P2）、不可变 revision、预算 TS 权威、流投影
- **不包含**：Cangjie 第二实现细节（见 11）、REST envelope 与错误码总表（见 10）、表字段 DDL（见 schema 组）
- **阶段标签**：v0 写实（TsAgentRuntime 单实现）；P1 checkpoint 落库；P2 lease/fencing；v0–P3 不用 Cangjie

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. TsAgentRuntime 职责（Required）

- TsAgentRuntime 是服务端 Agent 唯一编排入口（v0 单实现；Cangjie 只作第二实现，见 11）。
- 职责：接收结构化任务输入 → 跑受预算约束的 think/act 循环 → 经 ToolGateway 调工具 → 产出 AgentEvent 流 → 落 `agent_runs/run_attempts/run_checkpoints`。
- 非职责（不信任原则）：不做用户鉴权（调用方已验，请求自带 `actor_id` 视为内网可信）；不直连业务表（上下文由调用方传入）；不算时间（只调 `time-core.normalize`，LLM 输出的时间字符串一律视为不可信）；不直接调外部 MCP（统一经 ToolGateway）。

### 不信任三原则（Required）

1. 输入不可信：`input.raw_text` 原样转发、按不可信解析；工具参数经 zod 重验。
2. 模型输出不可信：时间/金额/外部事实必须经工具或 time-core 校验后才可进入 Approval/Task。
3. 审批不可绕过：敏感工具（风险分级 high，见 §5）必须先发 `approval_required` 并挂起，凭 `resolve(approve)` 恢复；拒绝则按用户拒绝继续规划（换路或结束）。

## 2. 接口：run / resume / cancel（Required，P1 起全接口化）

```text
AgentRuntime.run({ run_id?, actor_id, agent, input, context_refs, tools_allowlist, budget, idempotency_key, request_id }) → { run_id, attempt_id }
AgentRuntime.resume({ run_id, from_checkpoint_id?, request_id }) → { attempt_id }
AgentRuntime.cancel({ run_id, reason, request_id }) → { run_id, state: cancelled }
```

- `run_id`（UUID，永不复用）、`attempt_id`（UUID，每次 resume 新建一次 attempt，fenced 执行）。
- 幂等：`run` 按 `idempotency_key` 去重（同一 key 返回同一 `run_id`）；`cancel` 可重入。
- 预算（TS 权威，Required）：`{ max_iterations, max_tokens, timeout_ms }` 由 TS 侧校验与强制终止；运行时内部计数器以 TS 实现为准，不信任模型自报。超限即停并产出 `run_failed{reason: BUDGET_EXCEEDED}` + 已产出部分。预算字段语义冻结，供应商无关（Deferred：具体额度数值按环境配置）。

## 3. AgentEvent 词汇（Required，版本化 zod）

`packages/stream-protocol` 版本化（`protocol_version` 如 `v1`），事件名开工前对照 `thread-stream.schema.json`（AG-UI 投影，Observed AF§7；对照前标记为 Proposed 待确认）。

| 事件                | payload 要点                                    | 说明                                                    |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `thinking`          | `{ text_summary }`                              | 思考摘要（非完整推理链；完整链不入库）                  |
| `tool_call`         | `{ tool, args_redacted, invocation_id }`        | 参数经 allowlist+zod；敏感值只存引用/脱敏               |
| `tool_result`       | `{ invocation_id, ok, summary, evidence_ref? }` | 结果摘要；大对象存引用                                  |
| `approval_required` | `{ approval_id, tool, reason }`                 | 挂起点；BFF 存审批单                                    |
| `approval_resolved` | `{ approval_id, decision }`                     | 恢复或终止依据                                          |
| `checkpoint`        | `{ checkpoint_id, step_no, state_digest }`      | 每次 tool 调用后发一次（P1 落库）                       |
| `answer`            | `{ delta/text }`                                | 最终回复增量/全文                                       |
| `run_failed`        | `{ reason, detail_ref }`                        | `BUDGET_EXCEEDED/TIMEOUT/TOOL_DENIED/APPROVAL_REJECTED` |
| `done`              | `{ iterations, tokens, usage_ref }`             | 计费输入（usage 记录查询侧消费）                        |

## 4. run / attempt 状态图（Required）

```text
run: created → running → awaiting_approval → running → { succeeded | failed | cancelled }
                │              │                                  ▲
                └──── cancel ──┴──────────────────────────────────┘
attempt（每次 resume 新建）: created → executing → { completed | failed | superseded | fenced_out }
checkpoint: 每个 attempt 内按 step_no 单调追加（只追加，不改写）
```

- `cancel` 赢过一切：提交后轮询/重试全作废；`cancelled` 为终态。
- `attempt` fencing（P2，见 §6）：同 run 并发 attempt 以 `lease_token` 裁决，败者 `fenced_out`，其工具调用一律拒绝。

## 5. ToolGateway 交互（Required）

- 白名单：每次 `run` 限定 `tools_allowlist`，默认最小集；allowlist 外调用直接 `TOOL_DENIED`。
- 参数校验：zod schema per-tool；风险分级 `low/medium/high`；`high` 强制 HITL。
- 审计：每次 `tool_call/tool_result` 写 `tool_calls`（含 `invocation_id`、`risk_level`、`approval_id?`、`request_id`）。

## 6. Checkpoint：P1 / P2（Required）

- P1（落库可续跑）：每次 tool 调用后发 `checkpoint` 事件，BFF/调用方落 `run_checkpoints{checkpoint_id, run_id, attempt_id, step_no, messages_digest, tool_state_ref, created_at}`；服务重启/超时后 `resume(from_checkpoint_id)` 重放继续。
- P2（lease + fencing）：`run_attempts{attempt_id, run_id, lease_token, lease_expires_at, state}`；claim 时原子抢 lease；工具执行前验 lease，过期/被抢则 `fenced_out`，副作用恰好一次（与 Spike S2 同标准，见 11）。
- v0 范围：P1 落库 + `resume` 可用；P2 fencing 在调度器 worker 先行（见 10/12），Agent 侧 P2 接入。

## 7. 不可变 revision（Required，对标 a13n）

- `agent_definitions{agent_id, revision, agent_spec, prompt_ref, model_ref, tools_slice, created_at}`：revision 一旦发布不可变（DB 禁 UPDATE/DELETE；新版递增 revision）。
- `skill_definitions{skill_id, revision, …}`、`prompt_templates{name, version, …}` 同理。
- 每次 `run` 冻结 `agent_revision` + `presentation_version` + `tzdb_version`（可解释性三件套）；旧 revision 的 run 用旧模板跑完，不悄悄替换。

## 8. 流投影（SSE，Required；WS 延后）

- 在线交互走 SSE（`POST /conversations/messages` → `text/event-stream`）：AgentEvent 经 `stream-protocol` 投影为 SSE `data:` 行；断线用 `Last-Event-ID` + `GET /conversations/{id}` 补全（见 10）。
- WS + `ws-ticket` P2 起；Web Push 仅兜底（Deferred 供应商）。

## 引用

- B02§2/B04/AF§4–§7；B06§8（分诊：提醒路 vs Agent 路）；合同五缝之 AgentRuntime/ToolGateway。
