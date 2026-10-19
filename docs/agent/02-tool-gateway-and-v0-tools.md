# 02 工具网关与 v0 工具

| 状态 | 范围 | 不包含 | 阶段标签 |
| --- | --- | --- | --- |
| Proposed | ToolDefinition 契约、白名单注入、v0 五工具 schema、风险分级、审计 | Scheduler/Notifier/ConnectorVault 接口细节（design 真源）、MCP 聚合（P1 起） | v0：5 工具全为网关内建；P1 起网关独立进程+MCP 聚合 |

## ToolGateway 边界

[Required] Agent 永不直调工具实现。调用路径唯一：

```text
assistant tool-loop -> ToolGateway.invoke(tool_id, args, run_ctx)
  -> 白名单校验（本次 run allowlist 是否含 tool_id）
  -> zod 参数校验（extra=forbid，多余字段直接拒）
  -> 风险分级门（low 直接执行 / high 产 approval 事件挂起 loop）
  -> 执行（只读查库 / 只产 approval）
  -> 审计落行（tool_invocation：run_id/tool_id/args_hash/ok/latency，敏感值只存引用）
```

- [Required] 运行绑定由运行时注入，不由 LLM 传：`user_id` / `conversation_id` / `run_id` / `request_id` 全部由网关从 `AgentRunRequest` 注入；LLM 传这些字段视为越权，拒绝并审计。
- [Required] `extra=forbid`：zod `strict()`，未知字段即拒；拒绝记审计，不进 LLM 重试循环（防参数嗅探）。
- [Required] 输出脱敏：工具结果中的 secret/token/连接串一律以 `secret://…` 引用返回，不出明文（v0 无真实 secret，仅接口约束）。
- [Proposed] P1 起网关独立进程，聚合外部 MCP Server；仓颉侧切 MCP Client，只认网关。MCP 工具经网关同样走白名单+zod+分级+审计。

## ToolDefinition schema（字段 describe）

[Required] 每个工具定义字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tool_id` | string | 全局唯一，如 `propose_task`；LLM 可见名即执行名，无别名 |
| `description` | string | 给 LLM 的一句话用途+禁区（如"只产 approval，不建 task"） |
| `risk_level` | enum(low, high) | low=只读可直接执行；high=副作用必须产 approval 挂起 |
| `requires_approval` | boolean | high 恒 true；low 恒 false；网关强制，不信任工具自声明 |
| `input_schema` | zod | 参数契约，`strict()`；时间类字段只收原话，禁 `fire_at_utc` |
| `output_schema` | zod | 返回契约；含 `approval_id`（high）或只读数据（low） |
| `side_effect` | enum(none, creates_approval) | v0 只允许这两种；任何直接建/改 task 的副作用非法 |
| `owner_scope` | enum(user) | 一律按注入 `user_id` 分区查询，不接受跨用户参数 |

## v0 五工具 schema

### 1. `propose_task`（high，副作用只产 approval）

[Required] 提醒意图唯一入口。LLM 不算时间，只转交原话。

输入：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `raw_time_text` | string | 是 | 用户时间原话，原样转交，如"明天 9:20"；不改写、不补全 |
| `timezone_hint` | string\|null | 否 | 用户明示时区原文或已确认时区 ID；缺失即 null，不猜 |
| `note` | string | 是 | 事项原话，如"喝水"；`original_note` 接口不读语义，仅回显 |
| `occurrence` | enum(once) | 是 | v0 只 once；重复提醒进 v1 盒子，直接拒并给话术 |

输出：`{ approval_id, c_short_no, presentation_text, presentation_hash, presentation_version, expires_at }`。网关内：调 time-core 归一（成功才生成 C 草稿 pending_confirmation 行）→ 生成回显文本 → 返回。归一失败不建 C，直接返回结构化错误（见 04 映射）。

[Required] `propose_task` 入参禁含 `fire_at_utc` / `fold` / `offset` / `user_id` / `conversation_id`；出现即 `extra=forbid` 拒绝+审计。

### 2. `request_cancel_task`（high，副作用只产 approval）

输入：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `task_id` | string | 是 | 要取消的 task UUID；必须属注入 `user_id`，否则越权拒+审计 |
| `reason_text` | string\|null | 否 | 用户说的取消原因原话，仅备注 |

输出：`{ approval_id, c_short_no, presentation_text, presentation_hash, expires_at }`（cancel_pending 确认单）。确认后走取消事务（落 CANCELLED 才算），与触发门禁联动（见 design 真源）。

### 3. `list_tasks`（low，只读）

输入：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `state` | enum(saved,pending_schedule,scheduled,fired,missed,cancel_pending,cancelled)\|null | 否 | 按状态过滤；null=全量（默认只返未终态，见输出 `has_more` 口径） |
| `limit` | integer 1–50 | 否 | 默认 20 |

输出：`{ tasks: [{ task_id, note_preview, fire_at_local_text, timezone_id, state }], has_more }`。`note_preview` 截断 30 字；不返 `original_note` 全文、不返 UTC 内部字段（展示层只读冻结本地文本）。

### 4. `read_brief_cards`（low，只读）

输入：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string(YYYY-MM-DD) | 是 | 简报日期（用户已确认时区下的本地日）；格式错即 zod 拒 |
| `card_ids` | string[]\|null | 否 | 指定卡片；null=当日全量 |

输出：`{ brief_id, date, cards: [{ card_id, kind, title, body_text, source_refs, presentation_version }] }`。卡片内容只读今日简报快照；跨日/跨路数据冻结见 03。

### 5. `get_user_prefs`（low，只读）

输入：`{}`（无参；user 由运行时注入）。

输出：`{ timezone_id\|null, alias_version, quiet_hours\|null, locale }`。`timezone_id=null` 表示未确认——调用方必须走时区澄清（见 04），不得用设备/位置猜。

## 越权与审计

- [Required] 越权矩阵：传注入型字段（user/conversation/run/request）/ 跨用户 task_id / `extra` 未知字段 / 非 allowlist 工具 → 网关拒绝（`TOOL_FORBIDDEN`），记 `audit_logs(tool.invoke_denied)`，LLM 侧收到结构化拒因，不自动重试。
- [Required] 审计每行：`run_id, tool_id, args_hash, decision(allow/deny/approval_pending), ok, latency_ms, recorded_at_utc`；完整 args 不存（含原话的参数只存 hash+长度）。
- [Required] 副作用工具（high）绝不直接建 task：网关无建 task 通道；建 task 唯一入口是 `POST /approvals/{id}/actions/confirm` 事务。测试断言：调 `propose_task`/`request_cancel_task` 后 task 表行数不变，只增 approval 行。

## 与 design/04 的一致性

- 本篇白名单+zod+风险分级+审计即 design/04 ToolGateway 节的 Agent 侧投影；接口签名以 design 为准。
- v0 网关与 AgentRuntime 同进程模块（TS 模块化单体），P1 起可拆独立进程，契约不变（contracts 契约测试进程内/远程跑同一套）。
