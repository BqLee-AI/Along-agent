# 02 工具网关与 v0 工具

| 状态                | 范围                                                                     | 不包含                                       | 阶段标签                                          |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| Observed / Required | 既有5业务工具、R1的5有限workspace工具、持久调用身份/接受结果及只追加审计 | 调度/通知细节、任意外部工具、通用自动Run恢复 | business保持v0；唯一仓颉循环与R1见design/09/11/14 |

## ToolGateway 边界

[Required] Agent 永不直调工具实现。调用路径唯一：

```text
TS先预约 {callKey,toolId,args} -> 持久 invocationId
assistant tool-loop -> ToolGateway.invoke({invocationId,toolId,args}, trusted run_ctx)
  -> 真实 owner/conversation/Run/attempt 关联、当前白名单及精确workspace登记
  -> 已接受结果重放；新执行再验资格、strict zod 与可信执行分类
  -> local同事务接受；read_only事务外IO后首次接受；apply走非事务一次许可
```

- [Required] 运行绑定由可信 TS 注入，不由模型自报：owner/conversation/run/必填 attempt/request 与 allowlist 不在工具参数中。通过 conversations 公共用例核对归属和执行资格；同进程 ToolContext 不是远程授权协议。三个互斥 v0 分支使用固定 `v0-turn/1` slot，新逻辑动作才分配新 slot；更换 request_id/attempt_id 不另建调用。
- [Required] `extra=forbid`：zod `strict()`，未知字段即拒；拒绝记审计，不进 LLM 重试循环（防参数嗅探）。
- [Required] 输出脱敏：工具结果中的 secret/token/连接串一律以 `secret://…` 引用返回，不出明文（v0 无真实 secret，仅接口约束）。
- [Proposed] P1 起网关独立进程，聚合外部 MCP Server；仓颉侧切 MCP Client，只认网关。MCP 工具经网关同样走白名单+zod+分级+审计。

## 工具定义与可信分类

[Required] 对native发布的 `HarnessToolSchema` 字段由 `tools/catalog.ts` 生成，执行仍由TS网关裁决，不能以模型提供的风险或布尔字段绕过批准：

| 字段          | 类型                | 说明                                            |
| ------------- | ------------------- | ----------------------------------------------- |
| `name`        | string              | 精确执行名，无别名                              |
| `description` | string              | 用途与禁区                                      |
| `parameters`  | JSON object         | 输入JSON schema；TS仍以对应strict zod校验       |
| `risk`        | low / medium / high | 读为low，task/文档提议为medium，文档apply为high |

不发布可自报的owner/root/allowlist/执行种类。`execution_kind` 由TS绑定：workspace_list/grep/read及既有只读工具为read_only；task/取消/文档提议为local；workspace_apply_replace为non_transactional。提议只产approval，task仍只能经按钮confirm创建；文档按钮只授权，文件写入须唯一apply。旧task时间输入/批准/取消合同不因新增文档类型改变。

## v0 五工具 schema

### 1. `propose_task`（medium，副作用只产 task approval）

[Required] 提醒意图唯一入口。LLM 不算时间，只转交原话。

输入：

| 字段            | 类型         | 必填 | 说明                                                     |
| --------------- | ------------ | ---- | -------------------------------------------------------- |
| `raw_time_text` | string       | 是   | 用户时间原话，原样转交，如"明天 9:20"；不改写、不补全    |
| `timezone_hint` | string\|null | 否   | 用户明示时区原文或已确认时区 ID；缺失即 null，不猜       |
| `note`          | string       | 是   | 事项原话，如"喝水"；`original_note` 接口不读语义，仅回显 |
| `occurrence`    | enum(once)   | 是   | v0 只 once；重复提醒进 v1 盒子，直接拒并给话术           |

[Required] `propose_task`必须按完整提醒校验日期、时刻、已确认时区及非空`note`，缺字段只澄清、不建批准。`raw_time_text`只保留原时间表达，`note`独立作为事项；不要求把事项重复写进时间字段，也不把两者拼写后再归一。仅有钟点不能按接收锚补成今天；缺日期和实际跨日分别使用问日期与日期重确认话术。

输出：`{ approval_id, c_short_no, presentation_text, presentation_hash, presentation_version, expires_at }`。网关内：调 time-core 归一（成功才生成 C 草稿 pending_confirmation 行）→ 生成回显文本 → 返回。归一失败不建 C，直接返回结构化错误（见 04 映射）。

[Required] `propose_task` 入参禁含 `fire_at_utc` / `fold` / `offset` / `user_id` / `conversation_id`；出现即 `extra=forbid` 拒绝+审计。

### 2. `request_cancel_task`（medium，副作用只产 task approval）

输入：

| 字段          | 类型         | 必填 | 说明                                                      |
| ------------- | ------------ | ---- | --------------------------------------------------------- |
| `task_id`     | string       | 是   | 要取消的 task UUID；必须属注入 `user_id`，否则越权拒+审计 |
| `reason_text` | string\|null | 否   | 用户说的取消原因原话，仅备注                              |

输出：`{ approval_id, c_short_no, presentation_text, presentation_hash, expires_at }`（cancel_pending 确认单）。确认后走取消事务（落 CANCELLED 才算），与触发门禁联动（见 design 真源）。

### 3. `list_tasks`（low，只读）

输入：

| 字段    | 类型                                                                               | 必填 | 说明                                                            |
| ------- | ---------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| `state` | enum(saved,pending_schedule,scheduled,fired,missed,cancel_pending,cancelled)\|null | 否   | 按状态过滤；null=全量（默认只返未终态，见输出 `has_more` 口径） |
| `limit` | integer 1–50                                                                       | 否   | 默认 20                                                         |

输出：`{ tasks: [{ task_id, note_preview, fire_at_local_text, timezone_id, state }], has_more }`。`note_preview` 截断 30 字；不返 `original_note` 全文、不返 UTC 内部字段（展示层只读冻结本地文本）。

### 4. `read_brief_cards`（low，只读）

输入：

| 字段       | 类型               | 必填 | 说明                                                  |
| ---------- | ------------------ | ---- | ----------------------------------------------------- |
| `date`     | string(YYYY-MM-DD) | 是   | 简报日期（用户已确认时区下的本地日）；格式错即 zod 拒 |
| `card_ids` | string[]\|null     | 否   | 指定卡片；null=当日全量                               |

输出：`{ brief_id, date, cards: [{ card_id, kind, title, body_text, source_refs, presentation_version }] }`。卡片内容只读今日简报快照；跨日/跨路数据冻结见 03。

### 5. `get_user_prefs`（low，只读）

输入：`{}`（无参；user 由运行时注入）。

输出：`{ timezone_id\|null, alias_version, quiet_hours\|null, locale }`。`timezone_id=null` 表示未确认——调用方必须走时区澄清（见 04），不得用设备/位置猜。

## R1 五个有限 workspace 工具 [Required]

精确输入/输出真源是 `tools/schemas.ts`、`tools/catalog.ts` 和共享contracts；行为见 [design/14](../design/14-r1-document-task-loop.md)，HTTP选择/批准见 [API 索引 §8](../api/README.md#8-r1-工作区与文档批准-required)，持久化见 [Schema 索引](../schema/README.md#r1-文档批准)。

只有显式execution=harness且选择有效workspace的新Run才授予这五工具；省略保持旧业务范围。工具参数不带workspace_id，不能在同Run换工作区。所有路径为已登记范围内的规范POSIX相对路径，不接受宿主root、绝对路径或任意目录；list/grep的空path代表根。

| 工具                        | strict输入                                                      | 风险/执行                | 真实输出与约束                                                                                             |
| --------------------------- | --------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `workspace_list`            | `{path:string}`                                                 | low / read_only          | `kind=list`、直接子项及failures；不开放未登记路径                                                          |
| `workspace_grep`            | `{path:string,literal:非空string}`                              | low / read_only          | `kind=search`，区分大小写逐行字面量matches、版本及failures                                                 |
| `workspace_read`            | `{path:非空string}`                                             | low / read_only          | `kind=read`、精确全文、原字节SHA-256 version、byte_length                                                  |
| `workspace_propose_replace` | `{read_invocation_id:UUID,old_text:非空string,new_text:string}` | medium / local           | `kind=document_approval`及冻结receipt；引用同Run接受全文，旧字面量必须恰好出现一次，允许删除为new_text空串 |
| `workspace_apply_replace`   | `{approval_id:UUID}`                                            | high / non_transactional | 仅原Run已approved的冻结目标，绑定唯一invocation；`kind=applied`或明确零写`conflict`，不保证已完成回读      |

- list/grep/read经TS MCP adapter，短事务验证、事务外IO、短事务首次接受，不持Run/attempt/invocation锁等待Server；重放读取原接受快照，新调用才刷新。单文件失败及literal不唯一/未找到、unchanged等为 `status=ok,kind=operation_error` 的未完成观察，不能冒充写成功。
- read保留BOM、CRLF与空白，严格UTF-8；完整结果JSON超过240000字节返回 `range_too_large`，不截断全文或伪造版本。文档提议还验证完整确认body（hash、再次JSON转义的preview.body、UUID键）序列化不超过131072字节；HTTP仍以原始JSON累计131072字节为上限，不是按文本字符或只算receipt。
- 文档批准/receipt/审计同local事务，独立批准页展示完整before/after；按钮只授权。可信提议结果区分task/document决议，`approval_required`额外带document种类，不新增事件词、不发假task/时间卡。批准后须原Run显式resume，native再调唯一apply和新read。
- apply预约同事务唯一绑定批准，dispatch一次许可事务再验原Run/approved/当前精确登记及相同invocation；unknown不重写、不换slot绕过。不确定以TOOL_EFFECT_UNKNOWN失败终结，不造可恢复unknown checkpoint，也不以文件hash相同补成功。
- applied必须有绑定invocation/args_hash/批准/目标/基线的真实回执；完成还需applied接受后新创建且新接受的独立read，完整内容/版本/字节数相符。只有已接受可信zero_write conflict才可用新全文读生成唯一后继并重新批准；拒绝/unknown/未执行不能重提绕过。
- 历史Run/取消/冻结批准详情可在登记撤销后按owner读取；新确认/拒绝、resume及工具动作仍验精确当前登记，历史安全摘要不是活授权。普通用户只选部署登记，不配置provider/BYOK；不把受控契约测试当真实模型/用户材料验收。

## 越权与审计

- [Required] 注入字段、额外参数、他人资源或未准工具不产生业务效果。allowlist外为TOOL_DENIED，失效执行资格为TOOL_FORBIDDEN，同引用改内容为STATE_CONFLICT；非法参数按工具合同拒绝/澄清，不执行。只追加tool_calls，不使用并不存在的audit_logs结果账；不会自动进入模型重试。
- [Required] 审计关联 invocation_id/run/attempt/request、tool_id、args_hash、decision(allow/deny)、record_kind、outcome_kind 与批准/错误码；参数字节数在 tool_invocations，raw args/secret/异常栈不落账。接受结果由 tool_invocations 管理，不能把 hash 唯一或审计成功当执行去重。
- [Required] 预约冻结首次时间/时区/fold/规则版本；重交不重算已接受结果。批准只存引用及冻结校验材料，详情状态另读；只读结果存有界安全快照。当前权限可遮蔽原结果但不覆写，恢复后返回同一事实；最初 denied 不升级执行。failed/unknown 不能当成功终结。
- [Required] 非事务协调器先提交unknown与一次执行许可，仅明确取得提交回答的当前栈执行；R1的workspace_apply_replace是真实产品调用者。丢回答/重启/并发不再写，只有绑定调用/摘要的可信证据能完成；不据此宣称任意外部工具exactly-once。
- [Required] task提议绝不直接建task，建task唯一入口仍为按钮 `POST /approvals/{id}/actions/confirm` 事务。文档提议/批准也不建task，文件副作用只经已授权唯一apply；high不再等同于“只能创建approval”，须按可信工具分类与专属批准门执行。

## 与 design/04 的一致性

- 本篇白名单+zod+风险分级+审计即 design/04 ToolGateway 节的 Agent 侧投影；接口签名以 design 为准。
- v0确定性turn与TS网关为同进程模块；仓颉仍是唯一模型/工具循环。正式消费者与contracts-dual归design/09/11，R1文件/MCP/文档等待归design/14；D8只对实际生产者消费者证据限定范围enforced，不把healthz双跑、unknown核心探针或受控模型结果当完整真实产品验收（design/13 §4.2）。

## R2-A 来源回取工具（#83）

[Required 目标合同] 新静态 `read_run_observation`（low/read_only）输入、context_slice 输出、页大小/单位/错误唯一真源为 [design/18 §7](../design/18-r2a-harness-context.md#7-原接受观察的网关回取)。同 Run/owner 已完成接受来源，经冻结 allowlist、当前 attempt/授权和网关审计；新 invocation 计入既有预算，读取原账不重跑 MCP。low/medium/high 只是模型可见元数据，不是自动授权引擎。旧 Run 不自动授新工具；内部 context_source 不能成为模型绕网关分页入口。该目标不表示现行十工具目录已有第十一个工具。
