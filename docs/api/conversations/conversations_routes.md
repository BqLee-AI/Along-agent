# Conversations 路由：对话与 SSE

> 状态：对话与正式 Harness 用户合同，含 R1 工作区选择和文档批准等待。范围：消息 SSE、只读补读、Run 查询、显式取消与批准等待恢复。不包含：任意崩溃自动恢复；合同不代表真实模型/用户材料/产物验收通过。
>
> 蓝图引用：B06（对话→确认；“明天”=服务端首次接收时刻+已确认时区并冻结；06 喝水用例）；B03（实时对话 SSE；WS+ws-ticket P2 起；packages/stream-protocol 版本化 zod，事件名开工对照 thread-stream.schema.json）。
>
> 时间失败、有限真实规则与 Web 候选选择按 #30 合同；安全 spec Scenario 1.2 的 typed failed 不得改成 completed。合同与实际验收记录分开。

## 1. 路由

| 方法 | 路径                                             | 鉴权 | CSRF | 幂等键      | 说明                             |
| ---- | ------------------------------------------------ | ---- | ---- | ----------- | -------------------------------- |
| POST | `/conversations/messages`                        | 是   | 是   | body 或头部 | 默认 business，显式 harness；SSE |
| GET  | `/conversations/{id}`                            | 是   | 否   | —           | 只读已存外部事件                 |
| GET  | `/conversations/{cid}/runs/{rid}`                | 是   | 否   | —           | 当前 Run/attempt/等待引用        |
| POST | `/conversations/{cid}/runs/{rid}/actions/cancel` | 是   | 是   | strict body | 先持久取消，再收回执行           |
| POST | `/conversations/{cid}/runs/{rid}/actions/resume` | 是   | 是   | strict body | 仅显式继续有效批准等待点；SSE    |

## 2. POST /conversations/messages [Required]

请求体：

```json
{
  "conversation_id": "cnv_01J…",
  "card_ref": "card_01J…",
  "execution": "business",
  "raw_text": "明天 9:20 提醒我喝水",
  "confirmed_timezone": "Asia/Shanghai",
  "fold_choice": "none",
  "idempotency_key": "550e8400-…"
}
```

- `conversation_id`：缺省则服务端新建并在首个 SSE 事件返回；传入则续写（跨用户 id 返回 `403`）。
- `card_ref`：可选，围绕某卡片追问时带；服务端只做关联，不做授权旁路。
- `raw_text`：用户原话，按不可信输入解析，原样进回显引用。
- `execution`：可选 `business | harness`，省略为兼容的确定性业务。harness 明确进入正式仓颉，`mode=chat` 不作隐式分派；缺实际依赖在任何新写入/SSE 前503 `HARNESS_UNAVAILABLE`，不自动改走 TS/fixture。
- Web 的默认 Agent 对话显式传 `execution=harness`，不带 `workspace_id` 也可交流；提醒快捷入口仍显式传 `business`。这不改变 HTTP 省略 execution 的默认值，也不新增执行种类。
- 新 Harness Run 在接纳事务内冻结同 owner、同 conversation 最新63条可见 user/assistant 消息引用并按 `created_at/id` 排序，随后追加本轮完整用户输入一次，总计最多64条。执行和批准恢复按冻结引用读原文，不混入后来消息、其他会话或 system 消息，不把旧 tool_calls 作为待执行动作。该窗口不是永久记忆；完整窗口、工具定义与观察超1MiB时明确失败 `HARNESS_CONTEXT_LIMIT`，不截断当前输入。缺跨轮引用的旧 Run 保持仅原输入的上下文。
- 入站幂等仍为同 owner/key：business 沿历史 hash 材料；无 workspace 的 harness 保持 `harness/v1\0` 域，带 workspace 则用 `harness/workspace/v2\0`，将 `workspace_id` 追加到原规范数组后计算 SHA-256。这是请求 hash 域，不是执行协议版本（执行为 `harness/v4`）。同键换 execution、workspace 或其他绑定输入为409，不重复创建另一 Run；冻结输入/权限不从 body 的 owner、allowlist 等额外字段取得。
- `workspace_id`：可选非空字符串，仅允许显式 `execution=harness`，business/省略 execution 时携带为400。新 Run 从当前本人有效部署登记取得精确授权，并冻结安全摘要；省略不授 workspace 工具。选择与新动作授权、历史展示的区别见 §5。
- `confirmed_timezone` / `confirmed_timezone_id`：schema 均已有、可空，取 `confirmed_timezone_id ?? confirmed_timezone`；未给本轮值可使用会话先前明确冻结值，仍缺失则澄清，不猜。原文单个明确已知别名/规范 ID 优先于本轮确认值，本轮确认值优先于会话默认值；未知显式别名即使已有 Shanghai 也失败，多个不同已知时区则澄清，完整优先级见 design/05 §9.2。
- `fold_choice`：`first | second | none`，默认 `none`；只有结构化字段决定选择，原话“第一次/第二次”不自动覆盖。歧义未选为 `AMBIGUOUS_LOCAL_TIME`；候选字段仍是 fold_choice，成功的现有归一结果与快照 `fold` 为 `0 | 1`，不混为字符串列。
- “明天”锚定：服务端首次接收时刻 + 已确认时区解析一次并冻结，后续不再重算（跨午夜追问具体日期；延迟线 1min/15min 语义见 design time-core）。

响应：`Content-Type: text/event-stream`，`200` 建连；新消息首事件 `thread.started` 含 conversation/Run。终结事件为 completed/failed/cancelled；harness 在批准等待时只结束该段流，不发 completed。显式 resume 不重放旧 started/delta。每行 `data: {protocol_version,seq,type,payload,request_id}`，`seq` 是不透明全局游标；内部 snapshot 产生间隙合法，不能要求连续。具体七词 schema 以 `packages/stream-protocol` 为准：

Harness 正文来自真实 provider SSE：原生逐次提交增量，TS 持久接受后才投影 `message.delta`，不等完整响应再拆分模拟。最终模型响应保留工具调用和用量，不重复提交正文；工具参数必须组装完整且校验后才执行。部分正文不等于运行成功，生成中错误/取消沿既有终态合同。Web 对实时与历史回复共用安全 Markdown，默认中文由原生系统上下文约束、明确语言要求优先，不由前端伪造。

GET/同入站键是只读补读，既不分配 attempt 也不启动 native/工具。running 同键409；suspended 可回已存前缀而不恢复。执行恢复只经 §3 的明确等待接口；checkpoint/fencing 不保证任意外部写恰好一次，unknown 不盲重放。

| SSE 事件            | 含义                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `thread.started`    | 流开始，含 conversation_id                                                                   |
| `message.delta`     | 助手文本增量（展示层只读呈现，不做时间换算）                                                 |
| `card.proposed`     | 拟建卡片预览（含 `card_id`、`schema_version`、冻结快照摘要；v0 只读投影，不建 `cards` 表）   |
| `approval_required` | 需要确认，含 `approval_id`（v0 只认按钮确认，文本只做展示；前端跳确认门，见 approvals 文档） |
| `thread.completed`  | 正常结束                                                                                     |
| `thread.failed`     | 失败，`error.code` 见 §4（含 BUDGET_EXCEEDED / 时间归一四错）                                |
| `thread.cancelled`  | 真实断连或显式停止后已持久取消的回执；不撤销既成工具/任务                                    |

`approval_required` 示例（单行 `data`）：

```
data: {"protocol_version":"v1","seq":12,"type":"approval_required","payload":{"conversation_id":"…","run_id":"…","approval_id":"apr_01J…","card_id":"card_01K…","presentation_hash":"ph_…"},"request_id":"…"}
```

## 3. 只读补读、Run 状态、取消与有限恢复 [Required]

- `GET /conversations/{id}?after_seq=&limit=`：返回该会话历史事件（按 `event_seq` 升序，`after_seq` 之后最多 `limit` 条，默认 200），用于刷新/换端恢复；事件体与 SSE 同 schema，`200` 通用 envelope 包裹 `data.events` + `data.next_after_seq`。跨用户返回 `403`，不存在返回 `404`。
- 真实运行中客户端关闭 SSE 请求持久取消；确认后任务仍以 approvals/tasks 事实为准，不因 Run 中断假撤销。正常批准挂起的服务端 EOF 不触发取消；Next 转发真实 abort，显式停止接口提供可靠用户入口。
- 仓颉累计迭代/可得 usage，超限 `thread.failed`、`BUDGET_EXCEEDED`/429；缺 usage 保留未知，不再使用 TS 字符估算或保证不可证明的费用。前端保留已发生事实，不自动重开流。

### Run 查询

`GET /conversations/{cid}/runs/{rid}` 返回通用 envelope `data`，由共享 `RunViewSchema` 校验：

- `run_id/conversation_id/execution/status/attempt_id/attempt_no`；
- `waiting=null | {checkpoint_id,invocation_id,approval_id}`；文档等待额外带 `approval_kind:"document"`，旧 task 等待不加此字段。`can_resume` 表示当前是否可显式继续，不泄漏凭据/内部推理；
- 可选 `workspace={workspace_id,label,readable_paths,writable_paths}` 为接纳 Run 时冻结的安全摘要，不是当前登记的动态替代，也不返回 root/物理 identity/登记摘要。历史缺摘要不从当前登记补造；
- owner-scoped，不存在或他人 Run 返回404。读取不执行，不因状态可继续而自动唤醒。

### 显式取消

strict body `{idempotency_key,reason?}`，可选 reason 长度1–200个 UTF-16 code units，与冻结取消事件上限一致；超限400且不占动作键/改变状态。同键同请求重交回原裁决，同键换 Run/reason 为409；已终态不能假撤销，返回真实状态。非终态取消将唯一取消事件、Run/attempt 资格原子提交后才通知/终止 native 和 abort 在途模型请求；活跃 harness 原流仍连接时投影该已存取消回执，不另建终态。工具先提交则接受事实保留，取消先提交则拒绝后续动作。

### 有限批准恢复

strict body `{checkpoint_id,idempotency_key}`，仅 harness Run 的最后有效批准等待点；business、他人、旧点、普通 checkpoint、取消或其他终态不可新启动。pending 决议409；确认可以早于 suspend，继续时读取原批准真实当前决议，不依赖通知。

- consumed：同 Run 新递增 attempt，将原 invocation/批准和真实 task ID 交给 native，原接受结果不改写、不重执行；
- rejected/expired/superseded：将决议交给 native 停止原动作，不追 successor/同义绕拒绝；
- 同等待点唯一有效恢复。并发、同键回答丢失重交或换键不得分配第二进程；已恢复且仍运行时409，已结束同键只补读原恢复 attempt 的帧。
- 恢复决议按可信提议结果区分 `kind=task|document`，不是让客户端指定查表。task consumed 仍携真实 `task_id`；document 仅 `pending|approved|rejected`，approved 带原 `apply_invocation_id|null`，只授权后续唯一 apply，不能伪装 consumed 或 task 结果。文档 rejected 停止原动作，不生成同义后继；批准/拒绝可早于 suspend，仍按同一等待点恢复。

Web 批准链接保留原 conversation/Run，并明确打开新标签页；在批准到达但 native 等待点尚未提交时也保留原会话和在途流，普通断连取消规则不变。确认/拒绝/修改沿原冻结按钮合同，之后读取原运行并明确继续；刷新或重试恢复不重做确认、不发新消息、不创建新 Run。

## 4. 错误（HTTP 建连层 + 流内层）

- 建连失败走通用 envelope：`401` / `403`（含CSRF不符、他人conversation）/ `404`（conversation不存在）/ `400 VALIDATION_ERROR`（zod 失败）/ `409 STATE_CONFLICT`（幂等键复用但请求体不同，或同键原 run 仍在执行；后者 `details` 带 `run_id`，客户端改用 GET `after_seq` 补全）。
- 启动时模型配置或固定可执行产物检查不满足，新 harness 在开流前503 `HARNESS_UNAVAILABLE`，不占幂等键或写新事实。运行库/进程/协议等后续异常明确失败并脱敏，不回退到其他执行器；进程错误用 `HARNESS_PROTOCOL_ERROR/HARNESS_EXITED`。开流后只持久一次 failed，不把 raw stderr/provider body 写入响应，不覆盖已提交取消/挂起/终态。
- [Required · #30] 对拟作新时间归一的请求，认证、CSRF、结构及既有owner/幂等只读边界在先；应用规则上下文不可用时，在任何新 conversation/message/run/attempt/幂等写入与SSE头之前拒绝，返回HTTP503通用 envelope（顶层 `code=400006`、`data=null`、`error.code=TZDB_UNAVAILABLE`，沿既有 request_id/msg/message 形状）。不建新 run、不调用normalize、不预占新幂等结果。同键已存结果重放不新归一；不把规则门做成阻断旧冻结读取/确认/取消/执行的全站门。
- [Required] 已建流仍为HTTP200；`NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME / UNKNOWN_TIMEZONE` 按冻结安全spec为 `thread.failed`，`payload.error.http_status=422`，`error.code` 为对应符号名；不是 delta+completed。缺年份/时区/时段、模糊范围等普通澄清仍可completed且不建approval。
- [Required · #30] 已建流之后发现 `TZDB_UNAVAILABLE`（包括支持zone但所需目标/锚点范围外），以 `thread.failed`、`http_status=503` 终结；不改外层200，不写JSON envelope到SSE。时间失败run恰好一个终结，解释delta可有，不能再completed/cancelled或发新approval。GET恢复重放相同帧；失败审计允许保留conversation/message/run/checkpoint/tool_calls，但approval/task/task_events/outbox/notification及发送调用为零；预检拒绝则连新审计run都没有。
- [Required · #30] AMBIGUOUS必须带 `error.details={wall_time,timezone_id,ruleset_id,candidates}`，候选恰好两个，按UTC早晚给 `fold_choice=first|second`、`offset_seconds`、`fire_at_utc`，唯一形状见design/05 §9.1。2026-11-01 01:30纽约分别为05:30Z/-14400、06:30Z/-18000；不得只拼中文文本或让客户端造候选。
- [Required · #30] Web保留原输入与服务端wall_time/timezone_id，展示两候选+数值偏移；点击first/second只以新幂等键、新请求和相应fold_choice重提议，保留纽约不能回退/me上海，日期/时区修改须清除旧候选。服务端重归一并沿既有锚点/跨午夜规则，不接受客户端UTC作为权威；成功pending后仍须按钮三件套确认，选择候选不等于建task。
- 时间归一由服务端 time-core 纯函数执行，LLM 不算时间，展示层不换算 [Required]。真实三zone/2026–2027有限覆盖、未知用户时区与缺规则区分、readyz/DB及D7兼容见design/05 §5；真实回归/部署缺失取证见§10，不把mock故障当部署演练。

## 5. R1 工作区选择与文档等待 [Required]

路由、DTO 与确认 body 的规范详情见 [API 索引 §8](../README.md#8-r1-工作区与文档批准-required)，行为见 [design/14](../../design/14-r1-document-task-loop.md)。

- 本人只读 `GET /api/v1/workspaces` 返回 `{items:[{workspace_id,label,readable_paths,writable_paths}]}`；无有效登记返回空列表，不披露宿主 root 或开放任意目录。普通用户只选已登记工作区，不配置 provider/BYOK。
- 新 Run 在既有 `frozen_context` 冻结精确 grant（workspace/owner/registration_digest/root_identity）及独立安全摘要；同入站键补读、历史 Run 查询、取消和冻结文档批准详情仍按 owner 可读，不因撤销登记而失败。`can_resume` 遇撤销/登记变更为 false；新批准/拒绝、新恢复和工具动作仍验当前登记与原精确 grant，不能凭历史展示恢复权限。
- 独立文档页使用 `GET /document-approvals/{id}` 和 `actions/confirm|reject`；确认仅记录授权，不写文件、不建 task、不产生调度事件/outbox。仍用既有 `approval_required`（带 `approval_kind:"document"`）跳页，不发文档 `card.proposed` 或假时间卡片，不增加 SSE 事件词。
- 详情将授权 `state` 与实际 `effect` 分开；`approved` 不等于已写，`applied` 仍须 apply 接受之后创建且接受的新 `workspace_read` 才能为 `verified`。只在可信零写 conflict 后，按更新后的真实全文读生成唯一后继并重新批准；拒绝、unknown 或未执行不能走此路径。
- `unknown` 正常以 `TOOL_EFFECT_UNKNOWN` 失败终结，保留既有事实，不重写、不凭相同文件 hash 补报成功、不制造可恢复 unknown checkpoint。GET/入站重放和已完成文档决议重放均不是执行恢复。
- HTTP 原始 JSON 累计上限仍为131072字节，工具接受结果应用限额为240000字节（不是240KiB）。提议还须保证完整确认 body（含再次 JSON 转义的 `seen_content=preview.body`、hash、UUID键）不超过131072字节；不能只按改后文本或 receipt 大小判断。详见 design/14 与 API 索引。

## 6. R1 可发现历史与只读恢复（#69）

本节为 Required 合同；字段、排序、一致性和取舍以 [design/17](../../design/17-r1-conversation-history.md) §3–§8 为真源。既有 §1–§5 保持其有效合同。

| 方法 | 路径                            | 用途                             |
| ---- | ------------------------------- | -------------------------------- |
| GET  | `/conversations`                | 当前 owner 的会话发现集合        |
| GET  | `/conversations/{cid}/messages` | 原样可见 user/assistant 消息档案 |
| GET  | `/conversations/{cid}/runs`     | 会话内 Run 索引及可信原话引用    |

- 新集合均需会话、no-store，不要求 CSRF。共享 strict DTO/query 归 `packages/contracts`，只返回 `{items,next_cursor}`，不附无界事件或动作权限。原 `ThreadEventSchema` 留在 `stream-protocol`，不扩包依赖。
- `limit` 默认 20，1–50；`cursor` 非空且最长 2000。未知/重复参数、畸形/错域游标或越界 limit 为 400。Run 集合另支持 `run_id` 精确读取，与 cursor 互斥；成功同页形状且一项、游标 null，不通过扫描列表定位深链。
- 列表按 `(created_at DESC,id DESC)`，消息/Run 按 `(created_at ASC,id ASC)`。游标含版本、类型、owner/父会话作用域、首屏上界和末项，保留 PG 微秒，所有 SQL 仍验 owner；`limit+1` 决定新集合是否有下一页。晚提交和新事实按约定刷新发现，不假称跨请求快照。
- 标题来自真实首条用户消息的有限显示文本，原文不改；活动时间来自已存消息及 Run 事实，不使用未维护的 `conversations.updated_at`。Run 原话分为 `available`、`legacy_unavailable`、`invalid_reference`，不得按近邻时间或模型回答猜测关联。
- 上述读取使用 `0018` 的四个非唯一查询索引（见 [schema](../../schema/conversation-and-runs-schema.md#r1-历史读取投影与查询索引69)）。其中 `conversation_idempotency(run_id)` 仅支撑旧 Run 缺少 `input_message_id` 时的回退查找：取全同 Run 引用后仍核 owner/会话作用域与原话歧义；不改变 `available`、`legacy_unavailable`、`invalid_reference` 的用户合同。
- 既有事件 GET 仅新增可选 `run_id` 筛选，并验证 Run/owner/父会话。缺省与响应保持旧合同：默认 200、最大 500，`events/next_after_seq` 和 SSE 七词不变。事件全量需按游标读完，页满后可能再读一空页，不能把 `next_after_seq` 当 has_more。
- 原 conversation 403/404 与 Run 404 隐藏边界保持；未登录 401，typed 依赖失败按原 503，实际查询异常脱敏 500，不变为空历史。独立 GET 的部分成功由 UI 逐项报告，不新增伪成功的 PARTIAL envelope。
- 历史入口、分页和 #68 重登后只 GET；不调用模型/MCP、不分配 Run/attempt，不新建决议/工具调用或写文件。全部批准按事件索引保留，任务结果见 [approval API §8](../approvals/approvals_routes.md#8-r1-历史中的真实提醒结果69)，文档冻结 effect 和当前动作授权继续分离。

## 7. R2-A 上下文容量（#83）

[Required] 设计真源为 [design/18 §2–§8](../../design/18-r2a-harness-context.md)，行为真源见 [agent-runtime](../../../openspec/specs/agent-runtime/spec.md)，分级证据见 [归档清单](../../../openspec/changes/archive/2026-10-30-manage-harness-context/tasks.md)。不新增公开 HTTP 路由、请求字段、RunView 字段或 SSE 词；新 context policy、measure_context/context_source、typed observations 为内部 wire/存储合同，不让浏览器选择额度、来源身份或 provider。

- HARNESS_CONTEXT_LIMIT 表示完整 wire/模型 HTTP/窗口/消息数或保护内容不能容纳，沿既有流内失败投影，不静默裁剪冻结输入。已建流保持 HTTP200，`thread.failed` 的 `payload.error.http_status=422`；恢复预检在 SSE 前失败则 HTTP422 通用 envelope，不创建新 attempt。
- BUDGET_EXCEEDED/429 保持累计 token 额度、迭代耗尽语义；64 工具引用容量耗尽仍为 HARNESS_CONTEXT_LIMIT。输出 cap 不等于 Run 余额，估算不作 usage，缺 usage 保持 unknown。
- TOOL_EFFECT_UNKNOWN、HARNESS_EXITED、HARNESS_PROTOCOL_ERROR 保留原义及脱敏规则；不因容量处理重发未知动作。模型/计量绑定不兼容按 HARNESS_UNAVAILABLE/503 在启动新 attempt 前拒绝，不隐式换模型。
- 新工具 read_run_observation 经既有 ToolGateway，不新增公开“按 UUID 任意取结果”端点；当前授权及新 invocation/预算照常。context_slice 不是新 workspace_read，不足以 verified。
- 继续仍是显式有效批准等待点、同 Run 唯一新 attempt；完整冻结输入/快照引用不丢弃。GET/刷新/重登/同入站补读不创建策略、调用模型/工具或自动继续。公开查询/错误不泄漏原正文、provider body 或计量配置秘密。
