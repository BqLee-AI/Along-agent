# @along/stream-protocol

Closed event vocabularies with a frozen JSON Schema artifact.

## Task ledger (docs/design/07 §1)

`EVENT_TYPES` holds exactly the seven S0-frozen words:
`created`, `scheduled`, `fired`, `missed`, `cancel_requested`, `cancelled`,
`reconciliation_run`. `saved` / `schedule_confirmed` are rejected.

## Thread stream (issue #9, S0 #14)

`THREAD_EVENT_TYPES` holds exactly the seven frozen SSE words:

| SSE 事件            | 含义                                                          |
| ------------------- | ------------------------------------------------------------- |
| `thread.started`    | 流开始，含 conversation_id + stream_protocol_version          |
| `message.delta`     | 助手文本增量（只读呈现）                                      |
| `card.proposed`     | 拟建卡片预览（v0 只读投影，不建 `cards` 表）                  |
| `approval_required` | 需要确认，含 approval_id                                      |
| `thread.completed`  | 正常结束                                                      |
| `thread.failed`     | 失败，`error.code` 见 §4（含 BUDGET_EXCEEDED / 时间归一四错） |
| `thread.cancelled`  | 客户端中断后服务端确认取消                                    |

对照结论：上游 AG-UI `AgentEvent` 到本包 SSE 为投影关系，不各写一套
（`approval_proposed→approval_required`、`answer/done→message.delta+thread.completed`、
`run_failed→thread.failed`、`thinking/tool_call/tool_result→message.delta/tool.status`）。
事件名与字段以 `thread-stream.schema.json` 为准（随包发布，见 `files`）。

每个事件都是严格信封：

```json
{
  "protocol_version": "v1",
  "seq": 1,
  "type": "thread.started",
  "payload": { "...": "..." },
  "request_id": "req-…"
}
```

- `protocol_version` 冻结为 `"v1"`；非 v1 拒绝。
- `seq` 为正整数（流内递增）；`request_id` 为调用方请求 id。
- 所有对象 `.strict()`：未知字段一律拒绝，wire 形状永不静默 widen。

zod 入口：`ThreadEventSchema`（discriminated union on `type`），逐事件
payload schema 另行导出（`ThreadStartedPayloadSchema` 等）。
