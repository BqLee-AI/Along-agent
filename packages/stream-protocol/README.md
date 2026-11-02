# @along/stream-protocol

Closed event vocabularies with explicitly versioned, strict JSON Schema contracts.

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

- 历史 `v1` 与委托 `v2` 显式区分，未知版本拒绝；不得把新字段塞入旧信封。
- `seq` 为正整数（流内递增）；`request_id` 为调用方请求 id。
- 所有对象 `.strict()`：未知字段一律拒绝，wire 形状永不静默 widen。

zod 入口：`ThreadEventSchema` 同时读取显式 `v1` / `v2`；`LegacyThreadEventSchema`
和 `DelegationThreadEventSchema` 分别严格读取各自版本。历史 payload schema
（`ThreadStartedPayloadSchema` 等）仍为 `v1`，没有因升级放宽。

### 委托流 v2

`v2` 保留相同七个事件名，不将 harness wire 版本或授权修订混作 SSE 版本：

- `thread.started` 的 `stream_protocol_version` 为 `v2`，必含
  `authorization_revision: "delegation/1"` 和 `execution_lifecycle: "request-bound"`；
  后者如实表示连接绑定执行，不承诺离开页面后后台继续。
- `message.delta`、`card.proposed`、`approval_required` 保留原 payload 形状，
  但信封 `protocol_version` 必须为 `v2`。事件存在不代表当前委托 profile 提供所有旧能力。
- 三种终结事件 `thread.completed` / `thread.failed` / `thread.cancelled`
  都必须携带 `goal_result`；其他字段仍按该事件原合同（完成含可空 `approval_id`，
  失败含 `error`，取消可含 `reason`）。
- `goal_result` 包含 `status`、1–64 个 `outcomes`、可空 `clarification` 和 `answer`。
  每项 outcome 含 description、status、至多64个 UUID `receipt_refs`；目标文本为1–8192字符。
  澄清类型只允许 time/timezone/target_selection/destination。

SSE 消费者只验证目标结果的结构、枚举、长度和引用形状，不查询收据归属、领域效果，
也不另行裁决聚合目标状态是否与逐项结果一致。真实领域与聚合 GoalResult 验证由生产者
在持久化和发布前完成；`thread.completed` 不是任意目标已达成的独立证据。
`thread-stream.schema.json` 的 `goalResult` 与 TS SSE 解码器都保持这一结构边界，
不复制应用层领域规则。所有 v2 payload、目标对象与信封仍拒绝未知字段。
