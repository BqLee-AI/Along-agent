# 09. AgentRuntime 与 Checkpoint 设计

## 文档状态

- **状态**：规范基线对齐（#44；design 为真源，prd 跟随）
- **范围**：v0 确定性对话现状、仓颉唯一 Harness/TS 能力与存储、预算、等待/恢复边界
- **不包含**：R1 代码或最终跨语言字段/API、工具结果账实现、通用无人值守恢复
- **阶段标签**：v0 事件补读已存在；R1 Harness 目标未实现；旧 P 阶段不作为完成证据

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. Harness 与 TS 的唯一责任

- [Observed] `apps/api/src/modules/conversations/service.ts#runTurn/executeRun` 是无真实 LLM 的确定性 v0 turn；TS 持有消息、Run、请求幂等、事件落库与 SSE 投影。不能称为已实现的通用 think/act Agent。
- [Required] 仓颉是唯一宿主 Harness：模型交互与工具循环、本次上下文/工具结果纳入、简短计划、行动选择、预算、等待/恢复与停止。不保留 TS 通用 Agent 第二实现，不将整个 TS 后端迁入仓颉。
- [Required] TS 长期保留 ToolGateway/tools、memory/grep、MCP、PC/browser、办公连接器、auth/批准/time-core/任务/scheduler/notifier/outbox/worker、API/Web 与 Run/checkpoint 存储。长期 memory 与本次上下文不是同一责任。
- [Required] 仓颉不直连业务库、不做时间归一、不绕网关直调外部工具。TS 从可信 Run/attempt 绑定恢复 owner/allowlist/取消/执行资格，不接受远程调用者自报权限；现有同进程 `ToolContext` 不是已存在的远程授权合同。

### 不信任三原则（Required）

1. 输入不可信：`input.raw_text` 原样转发、按不可信解析；工具参数经 zod 重验。
2. 模型输出不可信：时间/金额/外部事实必须经工具或 time-core 校验后才可进入 Approval/Task。
3. 审批不可绕过：敏感工具先由 TS 建立冻结批准、挂起；用户拒绝后不得换路完成同一未授权效果。v0 的按钮确认/事务/冻结展示继续有效；R1 等待同 Run 唤醒是目标，不宣称已实现。

## 2. 接口语义（Proposed 形状，R1 合同未实现）

```text
AgentRuntime.run({ run_id?, actor_id, agent, input, context_refs, tools_allowlist, budget, idempotency_key, request_id }) → { run_id, attempt_id }
AgentRuntime.resume({ run_id, from_checkpoint_id?, request_id }) → { attempt_id }
AgentRuntime.cancel({ run_id, reason, request_id }) → { run_id, state: cancelled }
```

- [Required] 逻辑 Run 与执行 attempt 分开；事件补读不新增 attempt。等待继续保持同一 Run，重启后的 attempt 分配/版本合同随真实接入定义，不以重试自动改变逻辑调用身份。
- [Observed] v0 入站幂等键重复 POST 重放同一 Run 的已存事件；没有据此实现通用 `resume(from_checkpoint)`。上方 run/resume/cancel 是能力语义示意，不是已暴露路由。
- [Required] 运行预算由仓颉强制计数与停止；TS 校验/保存配置并守工具执行资格，不复制模型循环。真实 provider usage 可得则计入，不可得费用标未知；当前 v0 TS 字符估算只证明确定性路径护栏。超限保留已产出、报告 BUDGET_EXCEEDED，不能截断假报成功。

## 3. AgentEvent 词汇（Proposed 内部词汇；对外冻结 SSE 不变）

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

## 4. run / attempt 状态图（Proposed 执行语义，非 v0 数据库枚举）

```text
run: created → running → awaiting_approval → running → { succeeded | failed | cancelled }
                │              │                                  ▲
                └──── cancel ──┴──────────────────────────────────┘
attempt（每次 resume 新建）: created → executing → { completed | failed | superseded | fenced_out }
checkpoint: 每个 attempt 内按 step_no 单调追加（只追加，不改写）
```

- [Required] TS 提交取消/撤销资格，网关拒绝后续新动作；仓颉观察后停止安排。取消不能撤销已经发生的外部效果，任务取消仍遵循取消优先和回执门（07/08）。
- [Proposed] 并发执行引入 lease/version/fencing 时由 TS 存储原子裁决并在执行边界校验，仓颉读取裁决后继续/停止；未具备证据不得宣称 Agent fencing 已实施。

## 5. ToolGateway 交互（Required）

- 白名单：每次 `run` 限定 `tools_allowlist`，默认最小集；allowlist 外调用直接 `TOOL_DENIED`。
- 参数校验：zod schema per-tool；风险分级 `low/medium/high`；`high` 强制 HITL。
- [Required · R1 目标] 审计关联每次 `tool_call/tool_result` 的稳定 `invocation_id`、风险与批准引用及 `request_id`；稳定身份/结果账合同随 #45 定义。现有 v0 `tool_calls` 不是已实施的 invocation_id 结果账，不以此声明通用执行去重。

## 6. 事件补读、执行上下文与效果恢复

- [Observed · v0] `conversations/repository.ts#appendCheckpoint` 实际逐条保存 thread 事件；幂等 POST 与 GET after_seq 读取事件。补读不重新归一、不调用工具，不等于模型上下文/工具执行恢复。SSE 断线也不是“重跑工具”的指令。
- [Required · R1 目标] 仓颉组织本次上下文、计划、预算与等待点；TS 持久保存快照、已接受结果、批准和执行资格。批准后唤醒同一 Run；字段和原子结果账需后续合同/实现，不由现有 checkpoint 行推导已完成。
- [Proposed · 后续无人值守] 崩溃/超时后恢复需要核对待处理调用、授权有效性、已接受结果、并发执行者与外部效果。lease/fencing 拦过期执行者，checkpoint 保存进度，两者都不保证通用 external exactly-once。
- [Required] 已接受成功结果不重执行；确定未执行才按工具合同与预算重试；可能已执行但结果未保存时先查询核对或停在未知，禁止盲重放。参数 hash 不是稳定调用身份，现有 `tool_calls` 去重也不构成通用执行去重。
- [Observed · v0 专属] `tasks/scheduler/send.ts` 使用一次调用许可和独立接收回执核对，未知不重发；08 的真实故障证据仅适用于该发送链，不是仓颉/任意文件/MCP 恢复验收。

## 7. 不可变 revision（Required，对标 a13n）

- `agent_definitions{agent_id, revision, agent_spec, prompt_ref, model_ref, tools_slice, created_at}`：revision 一旦发布不可变（DB 禁 UPDATE/DELETE；新版递增 revision）。
- `skill_definitions{skill_id, revision, …}`、`prompt_templates{name, version, …}` 同理。
- 每次 `run` 冻结 `agent_revision` + `presentation_version` + `tzdb_version`（可解释性三件套）；旧 revision 的 run 用旧模板跑完，不悄悄替换。

## 8. 流投影（SSE，Required；WS 延后）

- 在线交互走 SSE（`POST /conversations/messages` → `text/event-stream`）：AgentEvent 经 `stream-protocol` 投影为 SSE `data:` 行；断线用 `Last-Event-ID` + `GET /conversations/{id}` 补全（见 10）。
- WS + `ws-ticket` P2 起；Web Push 仅兜底（Deferred 供应商）。

## 引用

- B02§2/B04/AF§4–§7；B06§8（分诊：提醒路 vs Agent 路）；合同五缝之 AgentRuntime/ToolGateway。
