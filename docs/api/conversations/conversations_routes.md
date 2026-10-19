# Conversations 路由：对话与 SSE

> 状态：草稿，可评审。范围：`POST /conversations/messages`（SSE）+ `GET /conversations/{id}` 恢复 + 取消中断 + 预算。阶段标签：v0。
>
> 蓝图引用：B06（对话→确认；“明天”=服务端首次接收时刻+已确认时区并冻结；06 喝水用例）；B03（实时对话 SSE；WS+ws-ticket P2 起；packages/stream-protocol 版本化 zod，事件名开工对照 thread-stream.schema.json）。

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
- `confirmed_timezone`：本次确认使用的时区；缺失则服务端按“时区缺失必须问”回澄清，不猜（B06 §3.3）。
- `fold_choice`：`first | second | none`，默认 `none`；歧义时刻未选时服务端回 `AMBIGUOUS_LOCAL_TIME` 而非默认。
- “明天”锚定：服务端首次接收时刻 + 已确认时区解析一次并冻结，后续不再重算（跨午夜追问具体日期；延迟线 1min/15min 语义见 design time-core）。

响应：`Content-Type: text/event-stream`，`200` 建连；首事件必为 `thread.started`（含 `conversation_id` + `stream_protocol_version`），尾事件为 `thread.completed | thread.failed | thread.cancelled` 之一。每行 `data: {protocol_version, seq, type, payload, request_id}`（design/10 §4），`seq` 即 `run_checkpoints.event_seq`，用于 `?after_seq=` 补全。事件名与字段以 `packages/stream-protocol` 的 `thread-stream.schema.json` 为准，本文只列 v0 必需子集（S0 #14 冻结：`design/09` AgentEvent→本篇 SSE 为投影关系，不各写一套；`approval_proposed→approval_required`、`answer/done→message.delta+thread.completed`、`run_failed→thread.failed`、`thinking/tool_call/tool_result→message.delta/tool.status`）：

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

- 建连失败走通用 envelope：`401` / `403` / `404`（conversation_id 不存在或跨用户）/ `400 VALIDATION_ERROR`（zod 失败）/ `409 STATE_CONFLICT`（幂等键复用但请求体不同，或同键原 run 仍在执行；后者 `details` 带 `run_id`，客户端改用 GET `after_seq` 补全）。
- 建连成功后传输层错误走流内 `thread.failed`；v0 只有 `BUDGET_EXCEEDED`（429 语义）与内部错误。时间归一失败（`NONEXISTENT_LOCAL_TIME` / `AMBIGUOUS_LOCAL_TIME` / `UNKNOWN_TIMEZONE` / `TZDB_UNAVAILABLE`）按 docs/agent/04 映射为澄清话术：`message.delta` + `thread.completed`，不建 approval，不重问已给信息；歧义时刻的澄清文本必须摆出两次出现的偏移与 UTC 时间。
- 时间归一由服务端 time-core 纯函数执行，LLM 不算时间，展示层不换算 [Required]。
