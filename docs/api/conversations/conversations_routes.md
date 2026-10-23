# Conversations 路由：对话与 SSE

> 状态：草稿，可评审。范围：`POST /conversations/messages`（SSE）+ `GET /conversations/{id}` 恢复 + 取消中断 + 预算。阶段标签：v0。
>
> 蓝图引用：B06（对话→确认；“明天”=服务端首次接收时刻+已确认时区并冻结；06 喝水用例）；B03（实时对话 SSE；WS+ws-ticket P2 起；packages/stream-protocol 版本化 zod，事件名开工对照 thread-stream.schema.json）。
>
> 时间失败、有限真实规则与 Web 候选选择按 #30 合同；安全 spec Scenario 1.2 的 typed failed 不得改成 completed。合同与实际验收记录分开。

## 1. 路由

| 方法 | 路径                      | 鉴权 | CSRF | 幂等键                  | 说明                     |
| ---- | ------------------------- | ---- | ---- | ----------------------- | ------------------------ |
| POST | `/conversations/messages` | 是   | 是   | 是（`Idempotency-Key`） | 发送消息，SSE 流         |
| GET  | `/conversations/{id}`     | 是   | 否   | —                       | 会话恢复（历史事件重放） |

## 2. POST /conversations/messages [Required]

请求体：

```json
{
  "conversation_id": "cnv_01J…",
  "card_ref": "card_01J…",
  "raw_text": "明天 9:20 提醒我喝水",
  "confirmed_timezone": "Asia/Shanghai",
  "fold_choice": "none",
  "idempotency_key": "550e8400-…"
}
```

- `conversation_id`：缺省则服务端新建并在首个 SSE 事件返回；传入则续写（跨用户 id 返回 `403`）。
- `card_ref`：可选，围绕某卡片追问时带；服务端只做关联，不做授权旁路。
- `raw_text`：用户原话，按不可信输入解析，原样进回显引用。
- `confirmed_timezone` / `confirmed_timezone_id`：schema 均已有、可空，取 `confirmed_timezone_id ?? confirmed_timezone`；未给本轮值可使用会话先前明确冻结值，仍缺失则澄清，不猜。原文单个明确已知别名/规范 ID 优先于本轮确认值，本轮确认值优先于会话默认值；未知显式别名即使已有 Shanghai 也失败，多个不同已知时区则澄清，完整优先级见 design/05 §9.2。
- `fold_choice`：`first | second | none`，默认 `none`；只有结构化字段决定选择，原话“第一次/第二次”不自动覆盖。歧义未选为 `AMBIGUOUS_LOCAL_TIME`；候选字段仍是 fold_choice，成功的现有归一结果与快照 `fold` 为 `0 | 1`，不混为字符串列。
- “明天”锚定：服务端首次接收时刻 + 已确认时区解析一次并冻结，后续不再重算（跨午夜追问具体日期；延迟线 1min/15min 语义见 design time-core）。

响应：`Content-Type: text/event-stream`，`200` 建连；首事件必为 `thread.started`（含 `conversation_id` + `stream_protocol_version`），尾事件为 `thread.completed | thread.failed | thread.cancelled` 之一。每行 `data: {protocol_version, seq, type, payload, request_id}`（design/10 §4），`seq` 即 `run_checkpoints.event_seq`，用于 `?after_seq=` 补全。事件名与字段以 `packages/stream-protocol` 的 `thread-stream.schema.json` 为准，本文只列 v0 必需子集（S0 #14 冻结：`design/09` AgentEvent→本篇 SSE 为投影关系，不各写一套；`approval_proposed→approval_required`、`answer/done→message.delta+thread.completed`、`run_failed→thread.failed`、`thinking/tool_call/tool_result→message.delta/tool.status`）：

[Observed] 此处“恢复”仅是已存流事件补读/幂等重放，不重新执行工具，不提供通用 Harness resume API。仓颉当前上下文/等待点为 R1 目标，TS 长期负责存储与投影；checkpoint/fencing 不保证任意外部写恰好一次，未知效果不盲重放（[design/09 §6](../../design/09-agent-runtime-and-checkpoint.md)）。

| SSE 事件            | 含义                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `thread.started`    | 流开始，含 conversation_id                                                                   |
| `message.delta`     | 助手文本增量（展示层只读呈现，不做时间换算）                                                 |
| `card.proposed`     | 拟建卡片预览（含 `card_id`、`schema_version`、冻结快照摘要；v0 只读投影，不建 `cards` 表）   |
| `approval_required` | 需要确认，含 `approval_id`（v0 只认按钮确认，文本只做展示；前端跳确认门，见 approvals 文档） |
| `thread.completed`  | 正常结束                                                                                     |
| `thread.failed`     | 失败，`error.code` 见 §4（含 BUDGET_EXCEEDED / 时间归一四错）                                |
| `thread.cancelled`  | 客户端中断后服务端确认取消                                                                   |

`approval_required` 示例（单行 `data`）：

```
data: {"protocol_version":"v1","seq":12,"type":"approval_required","payload":{"conversation_id":"…","run_id":"…","approval_id":"apr_01J…","card_id":"card_01K…","presentation_hash":"ph_…"},"request_id":"…"}
```

## 3. GET /conversations/{id} 与取消中断 [Required]

- `GET /conversations/{id}?after_seq=&limit=`：返回该会话历史事件（按 `event_seq` 升序，`after_seq` 之后最多 `limit` 条，默认 200），用于刷新/换端恢复；事件体与 SSE 同 schema，`200` 通用 envelope 包裹 `data.events` + `data.next_after_seq`。跨用户返回 `403`，不存在返回 `404`。
- 取消中断：客户端关闭 SSE 连接即视为中断请求；服务端落一条 `thread.cancelled`（`reason=client_disconnected`）并把 run 标 `cancelled`，确认前无排期、无建 Task；确认后流程不受对话中断影响，以 approvals/tasks 状态为准。[Proposed] 显式 `DELETE /conversations/{id}/stream` 可选，v0 不强制，前端先用断连实现。
- 预算：`BUDGET_EXCEEDED`（token/轮次任一超限）时服务端主动 `thread.failed`（`http_status=429`）并附已消费量，前端展示“已达本轮上限，请精简后重试”，不自动重开流。

## 4. 错误（HTTP 建连层 + 流内层）

- 建连失败走通用 envelope：`401` / `403`（含CSRF不符、他人conversation）/ `404`（conversation不存在）/ `400 VALIDATION_ERROR`（zod 失败）/ `409 STATE_CONFLICT`（幂等键复用但请求体不同，或同键原 run 仍在执行；后者 `details` 带 `run_id`，客户端改用 GET `after_seq` 补全）。
- [Required · #30] 对拟作新时间归一的请求，认证、CSRF、结构及既有owner/幂等只读边界在先；应用规则上下文不可用时，在任何新 conversation/message/run/attempt/幂等写入与SSE头之前拒绝，返回HTTP503通用 envelope（顶层 `code=400006`、`data=null`、`error.code=TZDB_UNAVAILABLE`，沿既有 request_id/msg/message 形状）。不建新 run、不调用normalize、不预占新幂等结果。同键已存结果重放不新归一；不把规则门做成阻断旧冻结读取/确认/取消/执行的全站门。
- [Required] 已建流仍为HTTP200；`NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME / UNKNOWN_TIMEZONE` 按冻结安全spec为 `thread.failed`，`payload.error.http_status=422`，`error.code` 为对应符号名；不是 delta+completed。缺年份/时区/时段、模糊范围等普通澄清仍可completed且不建approval。
- [Required · #30] 已建流之后发现 `TZDB_UNAVAILABLE`（包括支持zone但所需目标/锚点范围外），以 `thread.failed`、`http_status=503` 终结；不改外层200，不写JSON envelope到SSE。时间失败run恰好一个终结，解释delta可有，不能再completed/cancelled或发新approval。GET恢复重放相同帧；失败审计允许保留conversation/message/run/checkpoint/tool_calls，但approval/task/task_events/outbox/notification及发送调用为零；预检拒绝则连新审计run都没有。
- [Required · #30] AMBIGUOUS必须带 `error.details={wall_time,timezone_id,ruleset_id,candidates}`，候选恰好两个，按UTC早晚给 `fold_choice=first|second`、`offset_seconds`、`fire_at_utc`，唯一形状见design/05 §9.1。2026-11-01 01:30纽约分别为05:30Z/-14400、06:30Z/-18000；不得只拼中文文本或让客户端造候选。
- [Required · #30] Web保留原输入与服务端wall_time/timezone_id，展示两候选+数值偏移；点击first/second只以新幂等键、新请求和相应fold_choice重提议，保留纽约不能回退/me上海，日期/时区修改须清除旧候选。服务端重归一并沿既有锚点/跨午夜规则，不接受客户端UTC作为权威；成功pending后仍须按钮三件套确认，选择候选不等于建task。
- 时间归一由服务端 time-core 纯函数执行，LLM 不算时间，展示层不换算 [Required]。真实三zone/2026–2027有限覆盖、未知用户时区与缺规则区分、readyz/DB及D7兼容见design/05 §5；真实回归/部署缺失取证见§10，不把mock故障当部署演练。
