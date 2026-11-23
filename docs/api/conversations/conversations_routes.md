# Conversations 路由：对话与 SSE

> 状态：对话与正式 Harness 用户合同，含 R1 工作区选择和文档批准等待。范围：消息 SSE、只读补读、Run 查询、显式取消与批准等待恢复。不包含：任意崩溃自动恢复；合同不代表真实模型/用户材料/产物验收通过。
>
> 蓝图引用：B06（对话→确认；“明天”=服务端首次接收时刻+已确认时区并冻结；06 喝水用例）；B03（实时对话 SSE；WS+ws-ticket P2 起；packages/stream-protocol 版本化 zod，事件名开工对照 thread-stream.schema.json）。
>
> 时间失败、有限真实规则与 Web 候选选择按 #30 合同；安全 spec Scenario 1.2 的 typed failed 不得改成 completed。合同与实际验收记录分开。

> 本人委托：Web 普通 Agent 显式请求 `authorization_revision:'delegation/1'` 的 `harness`；合格新 Run 冻结本人登记集合，允许可选子集，具体工具由实际冻结 profile 决定。可信上下文、GoalResult、`harness/v6` 与 SSE `v2` 配套；省略授权修订仍为 legacy。合格新 Run 冻结 `server-owned`，历史 `request-bound` 不迁写；有限新文件创建须冻结输出目录资格，见 [design/20](../../design/20-goal-scoped-delegation.md)。

> 用户模型选择、请求意图幂等和 Run 历史 `model_selection` 投影见 [模型接入 API](../model-providers.md) 与 [design/22](../../design/22-model-provider-settings.md)；模型运行使用本人冻结的选择，不回退部署固定模型。

> R3（#144，Proposed）：[design/23](../../design/23-r3-short-term-memory-and-compact.md)拟增加与批准恢复分离的通用暂停/继续与手动 compact 控制；本表仍为现行接口，不以拟议能力改变 `/actions/resume` 的批准语义或声称新接口已存在。

## 1. 路由

| 方法 | 路径                                                     | 鉴权 | CSRF | 幂等键      | 说明                               |
| ---- | -------------------------------------------------------- | ---- | ---- | ----------- | ---------------------------------- |
| POST | `/conversations/messages`                                | 是   | 是   | body 或头部 | 默认 business，显式 harness；SSE   |
| GET  | `/conversations/{id}`                                    | 是   | 否   | —           | 只读已存外部事件                   |
| GET  | `/conversations/{cid}/runs/{rid}`                        | 是   | 否   | —           | 当前 Run/attempt/等待引用          |
| GET  | `/conversations/{cid}/runs/{rid}/events`                 | 是   | 否   | —           | 按游标只读跟随已持久事件           |
| POST | `/conversations/{cid}/runs/{rid}/actions/cancel`         | 是   | 是   | strict body | 先持久取消，再收回执行             |
| POST | `/conversations/{cid}/runs/{rid}/actions/resume`         | 是   | 是   | strict body | 仅显式继续有效批准等待点；SSE      |
| GET  | `/conversations/office-capabilities`                     | 是   | 否   | —           | 当前服务是否允许新办公资料接纳     |
| POST | `/conversations/attachments`                             | 是   | 是   | 头部        | 按草稿暂存一份办公文件             |
| POST | `/conversations/attachments/{id}/actions/revoke`         | 是   | 是   | —           | 撤销办公原件及受影响产物的后续读取 |
| GET  | `/conversations/{cid}/runs/{rid}/artifacts/{id}/content` | 是   | 否   | —           | 下载真实可用产物                   |

办公接纳默认关闭。`office-capabilities` 返回 `admission_enabled`：仅当服务端启用 `ALONG_NATIVE_OFFICE_ADMISSION=1`、配置有效的 32 字节 Base64 `ALONG_OFFICE_OBSERVATION_KEY` 且数据库池可用时为 true。此字段不是 Run 接纳承诺；发送时仍重新校验身份、会话、材料和密钥。关闭接纳不关闭已有历史、下载或撤销。Run 历史的 `office_materials` 包含授权的资料与产物元数据；`reminder` 仅在实际创建记录存在时返回任务及当前状态，否则为 `unconfirmed`，不从缺少记录推断用户未请求。细节见 [design/24](../../design/24-native-office-delivery.md)。

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
- Web 默认 Agent 对话显式传 `execution:'harness',authorization_revision:'delegation/1'`；提醒快捷入口仍为 business，资料快捷入口传 harness 与显式 `workspace_id`，均保持 legacy。HTTP 省略 execution 的默认值不变。
- `authorization_revision`：可选，唯一值 `delegation/1`；必须显式 `execution:'harness'` 且省略单数 `workspace_id`，否则400。省略按 legacy 合同执行，不能从部署、wire 或历史推断升级。实际工具以该 Run 冻结 allowlist 和资源为准。
- 严格 elapsed 的有效时区按工具显式提示、同 Run 已接受设置、接纳时冻结时区的顺序选择。有效时区来自本人明确指定时，规则不可用或无法转换须返回时间错误，不能静默换成 UTC；只有默认偏好或无时区且无明确本地要求时可采用真实 UTC 展示。
- 新 Harness Run 在接纳事务内冻结同 owner、同 conversation 最新63条可见 user/assistant 消息引用并按 `created_at/id` 排序，随后追加本轮完整用户输入一次，总计最多64条。执行和批准恢复按冻结引用读原文，不混入后来消息、其他会话或 system 消息，不把旧 tool_calls 作为待执行动作。该窗口不是永久记忆；完整窗口、工具定义与观察超1MiB时明确失败 `HARNESS_CONTEXT_LIMIT`，不截断当前输入。缺跨轮引用的旧 Run 保持仅原输入的上下文。
- 入站幂等为同 owner/key：legacy 的原 hash 域及材料保持不变；显式 `workspace_ids` 规范排序后绑定新请求材料，顺序变化不扩大权限。同键异绑定输入为409；已存同键先补读原 Run，不随当前登记变化重新解析或扩权。实际冻结集合不是客户端自报的身份或路径。
- `workspace_id`：可选非空字符串，仅 legacy 显式 `execution=harness` 可携带，选择一个本人有效登记；business、缺省 execution 或与 delegation 共用均为400。
- `workspace_ids`：可选非空且去重的 ID 数组，仅显式 delegation harness 可携带，与 `workspace_id` 互斥；省略表示接纳时本人全部有效登记，显式值只能收窄。未知、他人、撤销或不符合原目标范围的项不得获得授权；无登记保留空集合，不阻断其他能力。集合超出上下文容量时明确失败，不静默截断。
- `confirmed_timezone` / `confirmed_timezone_id`：schema 均已有、可空，取 `confirmed_timezone_id ?? confirmed_timezone`。legacy 保留原文明确时区 > 本轮确认值 > 会话先前明确值的归一/澄清合同，详见 design/05 §9.2。新 delegation 的本轮明确提示优先，否则接纳时读取 identity 已保存偏好，不回退会话旧时区；Web 不把缓存 `/me` 偏好自动作为本轮明确提示。保存/清除偏好仅经真实工具用例，单次时区提示不自动保存。
- `fold_choice`：`first | second | none`，默认 `none`；只有结构化字段决定选择，原话“第一次/第二次”不自动覆盖。歧义未选为 `AMBIGUOUS_LOCAL_TIME`；候选字段仍是 fold_choice，成功的现有归一结果与快照 `fold` 为 `0 | 1`，不混为字符串列。
- `clarification_of_run_id`：可选 UUID，精确 fold 候选重提议必填，指向原 `AMBIGUOUS_LOCAL_TIME` 失败 Run。必须同 owner/conversation、全会话唯一尚未完成候选、紧邻上一 user 消息且有实际已接受失败及冻结来源；原文完全相同、请求所选时区等于实际候选并带结构化 first/second 才可继承原锚。它不是批准、resume、任意 Run 复制或客户端时钟授权；无效/关系不明只要求完整重述，不任挑锚。
- 只补时区支持整条明确别名/规范 ID 回复；仅可接续上述同归属、唯一、紧邻、终态 done/failed 且实际 `TIMEZONE_MISSING` 的原请求。多个候选、无关中间 user 目标、旧数据缺来源及其他不明补充要求完整重述日期、时刻、时区和事项；不能只按“前一 Run”或模型历史猜关系。
- 新接纳、具备任务定位能力的 `delegation/1` Run 可用 `clarification_of_run_id` 接续实际保存的目标选择缺口：在接纳事务中验证同 owner、同会话、紧邻前一用户消息、前序终态与结构化未解决缺口，并保证唯一有效后继。已接受回执作为历史事实保留，不当作新读取，不重复执行；无效来源不获得接续授权。Web 显式选择补充上一个问题，未选择时按新请求处理。
- “明天”锚定：新明确日期请求用本轮 DB `clock_timestamp()` 接纳时刻；可信澄清保留原 anchor，本轮 received 仍单独冻结。同日本地 120 秒不报跨日，真正本地午夜 20 秒仍问具体日期。新 Run 在既有不可变 `frozen_context` 写 `reminderDateSource`，旧 Run/工具重放/批准恢复/历史不回填或重算；字段与归属见 schema，时间纯层及未来时间/有效期规则见 design/05 §3。

响应：`Content-Type: text/event-stream`，`200` 建连；新消息首事件 `thread.started` 含 conversation/Run。终结事件为 completed/failed/cancelled；harness 在批准等待时只结束该段流，不发 completed。显式 resume 不重放旧 started/delta。每行 `data: {protocol_version,seq,type,payload,request_id}`，`seq` 是不透明全局游标；内部 snapshot 产生间隙合法，不能要求连续。具体七词 schema 以 `packages/stream-protocol` 为准：

Harness 正文来自真实 provider SSE：原生逐次提交增量，TS 持久接受后才投影 `message.delta`，不等完整响应再拆分模拟。最终模型响应保留工具调用和用量，不重复提交正文；工具参数必须组装完整且校验后才执行。部分正文不等于运行成功，生成中错误/取消沿既有终态合同。Web 对实时与历史回复共用安全 Markdown，默认中文由原生系统上下文约束、明确语言要求优先，不由前端伪造。

新委托的 v6 `start.trusted_context` 由服务端冻结身份关联、请求锚、偏好及真实能力后进入模型 system 层，不从用户文本或工具观察取得权威；legacy 在同一 v6 wire 显式传 `trusted_context:null`，继续原工具、预算、快照和批准语义。旧 v5 执行器不能消费 v6；snapshot 仍为2，不回写旧快照。新委托通过 `finish_goal` 提交 `GoalResult={status,outcomes,clarification,answer}`：状态为 completed/partial/blocked/cancelled/unknown，逐项状态为 achieved/not_done/blocked/unknown，`receipt_refs` 指向真实已接受调用 UUID，clarification 为空或 typed 缺口。TS 校验归属、接受结果和真实设置事实，将目标结果、最终 answer 消息、终结事件与 Run/attempt 终态原子保存；模型正文、工具完成或 Run done 均不独立证明目标完成。

名称未固定时，目标结果可附带创建撞名恢复声明，引用真实用户消息、零写冲突、后续创建和独立全文回读。服务端验证来源和效果事实；声明反映模型对委托的理解，不能单凭引用或相同内容独立证明语义授权。原冲突不会改写为成功。

新委托事件显式 `protocol_version:'v2'`：`thread.started` 带 `stream_protocol_version:'v2'`、`authorization_revision` 和 `execution_lifecycle`，三个终结事件均带持久 `goal_result`；legacy 和历史 `v1` 保持原 strict shape 可读，不能往 v1 暗塞字段。事件词和游标语义不变。

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
- `GET /conversations/{cid}/runs/{rid}/events?after_seq=`：以 SSE 从指定全局游标之后补读并跟随该 Run 的持久事件；参数仅允许可选的非负安全整数 `after_seq`。流在 Run 终态或批准挂起且事件读完后结束，断开订阅不创建消息、attempt、工具调用或恢复动作。交付时复验会话和账户资格；已交给网络的字节无法撤回。
- SSE POST 幂等回放也在每条已存事件交给流前复验当前请求的会话与账户资格，等待下游读取时不持授权事务。若撤权先提交，流停止交付，不追加失败事件、不改写已存事实，也不重启 Run；已交给流的事件无法撤回。
- `server-owned` 断开 SSE、刷新或退出只停止交付，已接纳执行在原预算和超时内继续；禁用账户或撤销资源资格阻止后续动作及披露。显式停止先持久撤销执行资格，再中断模型和 native；已接受结果不回滚，在途未知效果不重放。持锁会话失联或宿主崩溃后，取得同锁的收尾者只终结原运行，不重启执行。旧 `request-bound`/legacy 断连仍按原合同取消；批准挂起的正常 EOF 不触发取消。
- 服务端每个 API 进程使用独立、有界的持锁连接池，最多同时持有 4 个执行；容量不足时拒绝新接纳或恢复，不降级为 request-bound。每次执行最多持有动作资格 5 分钟，超时后中断，不自动重做；已派发的外部效果及迟到记账结束前仍占用执行槽，避免耗尽控制连接。停机先撤销资格并等待在途结果，进程保留 5 秒强制退出上限；超过上限未确认的效果保持 unknown，不推断成功或重发。数据库连接必须保持 PostgreSQL session 语义，不能使用 transaction-pooling 代理承载 advisory lock。
- 孤儿候选扫描使用同一个持锁池的剩余连接，连接获取和查询均有超时；连接异常时丢弃该连接，下次扫描重新读取，仍须取得原 Run 的锁才可收尾。扫描不占用普通控制池，也不增加连接池容量。
- 仓颉累计迭代/可得 usage，超限 `thread.failed`、`BUDGET_EXCEEDED`/429；缺 usage 保留未知，不再使用 TS 字符估算或保证不可证明的费用。前端保留已发生事实，不自动重开流。

### Run 查询

`GET /conversations/{cid}/runs/{rid}` 返回通用 envelope `data`，由共享 `RunViewSchema` 校验：

- `run_id/conversation_id/execution/status/attempt_id/attempt_no`；
- `waiting=null | {checkpoint_id,invocation_id,approval_id}`；文档等待额外带 `approval_kind:"document"`，旧 task 等待不加此字段。`can_resume` 表示当前是否可显式继续，不泄漏凭据/内部推理；缺少模型绑定的旧 Harness Run 为 `false`，即使其批准已决议，也不能用当前默认模型补绑定；
- 可选 `workspace={workspace_id,label,readable_paths,writable_paths}` 为接纳 Run 时冻结的安全摘要，不是当前登记的动态替代，也不返回 root/物理 identity/登记摘要。历史缺摘要不从当前登记补造；
- 新 delegation 可投影 `workspaces:[{workspace_id,label,readable_paths,writable_paths}]`、`authorization_revision:'delegation/1'`、冻结的 `execution_lifecycle:'request-bound'|'server-owned'` 和 `goal_result:GoalResult|null`；均来自原 Run 冻结事实，不公开 owner、root、digest 或 root identity，不按当前登记补造。legacy 的 `workspace` 和历史 shape 不变。
- `document_effects` 可选只读数组：每项含 `workspace_id,path,invocation_id,read_invocation_id,version,status` 和可选 `operation`，其中 `read_invocation_id` 和 `version` 可空；状态为 `applied|verified|conflict|failed|unknown`。applied 不是 verified；后者须同目标的独立新全文读取证据。此投影不是动作入口，Run done 也不等于目标完成。
- `created_reminders` 为新 delegation 的可选只读数组，每项为真实 `task_created` 冻结结果加 `invocation_id`，包含 task ID、保存状态、原墙上时间/时区/fold/偏移/规则身份/UTC和备注。读取核对真实任务与接受结果，不读取模型自报事实。Web 提供任务详情链接和创建回执；此数组不声明实时排期、触发或通知状态。
- `reminder_time_errors` 为该 delegation Run 的可选只读数组，每项含真实 `create_reminder` 接受结果中的 `invocation_id/error`，不表示成功创建。遇到已持久 time 澄清且实际 DST 候选唯一时，Web 复用 first/second 选择，保留原文及真实候选时区并显式关联前序 Run；提交的是用户选择，不是批准或前端计算的 UTC。不同候选来源不自动合并。
- owner-scoped，不存在或他人 Run 返回404。读取不执行，不因状态可继续而自动唤醒。

### 显式取消

strict body `{idempotency_key,reason?}`，可选 reason 长度1–200个 UTF-16 code units，与冻结取消事件上限一致；超限400且不占动作键/改变状态。同键同请求重交回原裁决，同键换 Run/reason 为409；已终态不能假撤销，返回真实状态。非终态取消将唯一取消事件、Run/attempt 资格原子提交后才通知/终止 native 和 abort 在途模型请求；活跃 harness 原流仍连接时投影该已存取消回执，不另建终态。工具先提交则接受事实保留，取消先提交则拒绝后续动作。

### 有限批准恢复

strict body `{checkpoint_id,idempotency_key}`，仅 harness Run 的最后有效批准等待点；business、他人、旧点、普通 checkpoint、取消或其他终态不可新启动。pending 决议409；确认可以早于 suspend，继续时读取原批准真实当前决议，不依赖通知。
恢复只使用原冻结工具集合；若目标构件不支持其中任一工具，返回状态冲突，不静默删除该工具后继续。快照引用不匹配、已用尽的累计预算或已经使用的等待点不能继续；历史事实仍供读取。`can_resume` 是只读时点的资格提示，不代替接纳事务中对时间规则、模型绑定、登记和并发状态的重新核验。

- consumed：同 Run 新递增 attempt，将原 invocation/批准和真实 task ID 交给 native，原接受结果不改写、不重执行；
- rejected/expired/superseded：将决议交给 native 停止原动作，不追 successor/同义绕拒绝；
- 同等待点唯一有效恢复。并发、同键回答丢失重交或换键不得分配第二进程；已恢复且仍运行时409，已结束同键只补读原恢复 attempt 的帧。
- 容量不足等未接纳请求后，若读取仍确认同一等待点可继续，用户可主动重交同一 checkpoint 和幂等键；读取、刷新或重登本身不提交。资格不明或不可继续时不以新键自动重放。
- 恢复决议按可信提议结果区分 `kind=task|document`，不是客户端指定查表。document 的 approved 仅授权原冻结目标的唯一 apply，不等于保存；新 delegation 的 rejected 不得开启后续业务动作或绕拒绝，legacy 按原恢复合同处理。

新 delegation 对真实新增影响提供完整冻结预览及一次明确“授权并继续”；只有原 Run 的有效等待点、当前资格、预算和决议均满足才继续。早于挂起的确认可保存决议，但没有有效等待点时不得排队自动继续；停止、撤权、终态或 unknown 不得复活。legacy 独立文档页仍需返回原 Run 显式继续；GET、刷新和重登都不授权或恢复。

## 4. 错误（HTTP 建连层 + 流内层）

- 建连失败走通用 envelope：`401` / `403`（含CSRF不符、他人conversation）/ `404`（conversation不存在）/ `400 VALIDATION_ERROR`（zod 失败）/ `409 STATE_CONFLICT`（幂等键复用但请求体不同，或同键原 run 仍在执行；后者 `details` 带 `run_id`，客户端改用 GET `after_seq` 补全）。
- 启动时模型配置或固定可执行产物检查不满足，新 harness 在开流前503 `HARNESS_UNAVAILABLE`，不占幂等键或写新事实。运行库/进程/协议等后续异常明确失败并脱敏，不回退到其他执行器；进程错误用 `HARNESS_PROTOCOL_ERROR/HARNESS_EXITED`。开流后只持久一次 failed，不把 raw stderr/provider body 写入响应，不覆盖已提交取消/挂起/终态。
- [Required · #30] legacy/business 拟作新时间归一时，认证、CSRF、结构及既有 owner/幂等只读边界在先；规则不可用在任何新 conversation/message/run/attempt/幂等写入与 SSE 头之前返回 HTTP503 envelope（顶层 `code=400006`、`data=null`、`error.code=TZDB_UNAVAILABLE`）。同键已存结果重放不新归一；新 delegation 不为保存/清除偏好预先归一整句，而冻结实际可空规则能力，保存工具再验所需规则，清除可独立完成，readyz 的规则故障仍如实报告。
- [Required] 已建流仍为 HTTP200。以下 legacy 时间归一错误沿原冻结合同：`NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME / UNKNOWN_TIMEZONE` 为 `thread.failed`，`payload.error.http_status=422`，不是 delta+completed；普通缺信息澄清可 completed 但不建 approval。新 delegation 目标缺口则由结构化 GoalResult 的 blocked/partial 与 clarification 表达，不把 Run done 当目标完成；工具失败不得伪造成功回执。
- [Required · #30] 已建流之后发现 `TZDB_UNAVAILABLE`（包括支持zone但所需目标/锚点范围外），以 `thread.failed`、`http_status=503` 终结；不改外层200，不写JSON envelope到SSE。时间失败run恰好一个终结，解释delta可有，不能再completed/cancelled或发新approval。GET恢复重放相同帧；失败审计允许保留conversation/message/run/checkpoint/tool_calls，但approval/task/task_events/outbox/notification及发送调用为零；预检拒绝则连新审计run都没有。
- [Required · #30] AMBIGUOUS必须带 `error.details={wall_time,timezone_id,ruleset_id,candidates}`，候选恰好两个，按UTC早晚给 `fold_choice=first|second`、`offset_seconds`、`fire_at_utc`，唯一形状见design/05 §9.1。2026-11-01 01:30纽约分别为05:30Z/-14400、06:30Z/-18000；不得只拼中文文本或让客户端造候选。
- [Required · #30/#92] Web保留原输入、原失败 Run ID 与服务端 wall_time/timezone_id，展示两候选+数值偏移；点击 first/second 只以新幂等键、新请求、`clarification_of_run_id=原失败Run` 和相应 fold_choice 重提议。原文须完全一致、请求时区须等于实际候选，保留纽约不能回退 `/me` 上海；输入/日期/时区修改须清除旧候选及来源引用。服务端核验唯一未完成来源和紧邻关系后沿原锚/本地午夜规则重归一，缺来源只要求完整重述，不接受客户端 UTC 作为权威；成功 pending 后仍须按钮三件套确认，选择候选不等于建 task。
- 时间归一由服务端 time-core 纯函数执行，LLM 不算时间，展示层不换算 [Required]。真实三zone/2026–2027有限覆盖、未知用户时区与缺规则区分、readyz/DB及D7兼容见design/05 §5；真实回归/部署缺失取证见§10，不把mock故障当部署演练。

## 5. R1 工作区选择与文档等待 [Required]

路由、DTO 与确认 body 的规范详情见 [API 索引 §8](../README.md#8-r1-工作区与文档批准-required)，行为见 [design/14](../../design/14-r1-document-task-loop.md)。

- 本人只读 `GET /api/v1/workspaces` 返回 `{items:[{workspace_id,label,readable_paths,writable_paths}]}`；无有效登记返回空列表，不披露宿主 root 或开放任意目录。普通用户只选已登记工作区，不配置 provider/BYOK。
- legacy Run 冻结单个 grant 与安全摘要；新 delegation 冻结本人 grant 集合，每次调用只选择集合中的一个并复验当前 owner、登记摘要和 root 身份。历史摘要及已存结果不是当前动作资格；登记新增、变更或撤销不扩权原 Run。
- 独立文档页使用 `GET /document-approvals/{id}` 和 `actions/confirm|reject`；确认仅记录授权，不写文件、不建 task。新 delegation 的正常编辑不生成批准，真实新增影响才走精确预览；legacy 保持冻结所见/hash、唯一 apply 和原显式恢复。
- `approved` 不等于已写，`applied` 仍须接受之后创建且接受的同 Run 独立完整 `workspace_read`，内容、版本和字节数均匹配才为 `verified`。只有已接受的真实零写版本冲突可新读重算；legacy 需新批准。拒绝、unknown 或未执行不能借其他工具绕过。
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
- 从飞书受控读取产生的已交付 assistant 归档带有 `source_run_id`，用于同一 Run 的流式回复去重；未交付的归档不进入列表。
- 既有事件 GET 仅新增可选 `run_id` 筛选，并验证 Run/owner/父会话。缺省与响应保持旧合同：默认 200、最大 500，`events/next_after_seq` 和 SSE 七词不变。事件全量需按游标读完，页满后可能再读一空页，不能把 `next_after_seq` 当 has_more。
- 原 conversation 403/404 与 Run 404 隐藏边界保持；未登录 401，typed 依赖失败按原 503，实际查询异常脱敏 500，不变为空历史。独立 GET 的部分成功由 UI 逐项报告，不新增伪成功的 PARTIAL envelope。
- 历史入口、分页和 #68 重登后只 GET；不调用模型/MCP、不分配 Run/attempt，不新建决议/工具调用或写文件。全部批准按事件索引保留，任务结果见 [approval API §8](../approvals/approvals_routes.md#8-r1-历史中的真实提醒结果69)，文档冻结 effect 和当前动作授权继续分离。

## 7. R2-A 上下文容量（#83）

[Required] 设计真源为 [design/18 §2–§8](../../design/18-r2a-harness-context.md)，行为真源见 [agent-runtime](../../../openspec/specs/agent-runtime/spec.md)，分级证据见 [归档清单](../../../openspec/changes/archive/2026-10-30-manage-harness-context/tasks.md)。不新增公开 HTTP 路由、请求字段、RunView 字段或 SSE 词；新 context policy、measure_context/context_source、typed observations 为内部 wire/存储合同，不让浏览器选择额度、来源身份或 provider。

- HARNESS_CONTEXT_LIMIT 表示完整 wire/模型 HTTP/窗口/消息数或保护内容不能容纳，沿既有流内失败投影，不静默裁剪冻结输入。已建流保持 HTTP200，`thread.failed` 的 `payload.error.http_status=422`；恢复预检在 SSE 前失败则 HTTP422 通用 envelope，不创建新 attempt。
- BUDGET_EXCEEDED/429 保持累计 token 额度、迭代耗尽语义；64 工具引用容量耗尽仍为 HARNESS_CONTEXT_LIMIT。输出 cap 不等于 Run 余额，估算不作 usage，缺 usage 保持 unknown。
- TOOL_EFFECT_UNKNOWN、HARNESS_EXITED、HARNESS_PROTOCOL_ERROR 保留原义及脱敏规则；不因容量处理重发未知动作。模型/计量绑定不兼容按 HARNESS_UNAVAILABLE/503 在启动新 attempt 前拒绝，不隐式换模型。
- 新工具 read_run_observation 经既有 ToolGateway，不新增公开“按 UUID 任意取结果”端点；当前授权及新 invocation/预算照常。context_slice 不是新 workspace_read，不足以 verified。
- 批准恢复仍是显式有效批准等待点、同 Run 唯一新 attempt；完整冻结输入/快照引用不丢弃。用户安全点暂停与继续见 §9，不消费批准等待。GET/刷新/重登/同入站补读不创建策略、调用模型/工具或自动继续。公开查询/错误不泄漏原正文、provider body 或计量配置秘密。

## 8. R2-B 只读路由的公开边界（已实现，默认 off，#88）

本节跟随 [design/19](../../design/19-r2b-readonly-intent-routing.md) 的只读路由合同，不替换 §1–§7。配套 `harness/v6` 支持 legacy 和新 delegation；默认 off，只有新 Run 冻结策略为 enforce 且命中时才执行 direct。委托直达的目标结果绑定唯一真实读取回执与已展示正文；续接仍不分类。

委托 Run 的冻结工作区集合非空时，即使请求看似符合只读意图，也不走 direct；未显式选择时该集合默认为本人有效登记。无有效登记的空集合不阻止路由；legacy 仍按单个冻结工作区判断。

- R2-B 本身不新增 HTTP 路由、execution 值、请求策略字段、RunView 字段或 SSE 词；business/省略 execution 仍原业务，显式 harness 仍正式 native，不新增 auto，不用路由掩盖 `HARNESS_UNAVAILABLE`。内部路由帧和 routing checkpoint 不传给浏览器；§2 的授权修订与 v2 目标结果不代表路由开启。
- 新接纳 harness Run 冻结路由策略（默认 off），仅 fresh 首 attempt 首模型前可分类一次。off、缺策略旧 Run、所有 GET/历史补读、同入站键重放及批准 resume 零分类、不补路由策略；R2-A 上下文策略的独立恢复规则不受此限制替换。shadow 只记潜在候选，不调用候选旁路业务工具，最终仍原模型回答。
- enforce direct 仅对已启用白名单且来源/参数/当前资格满足的请求生效；目标/参数由本轮原话或明确默认绑定，owner 从认证事实注入，工具仍通过原 ToolGateway。模型 fallback 继续处理完整其他目标，不把多目标或筛选请求缩水为一次有限查询。
- direct 回答是既有 provider 正文之外的明确受控来源：唯一真实只读成功 accepted_result、已接受 snapshot 和 TS 固定 renderer，不接受 native 自写正文，不伪造 provider 调用/usage。delta 与内部 render 回执同事务保存后才投影原 `message.delta`，成功终结须真实结果、回执及零模型；GET/重放只读这些原已存事实，不重新查工具或生成答案。
- 展示不扩大工具结果含义：提醒仅当前有界活动集合，不宣称查全/筛选/已核实；时区仅本人记录的 timezone_id 或未设置，不声称写入；简报仅明确合法单日且最多50张，不将截页说成全量。精确模板及来源约束归 design/19 §9。
- direct 前可拒识/可选编码失败回原 LLM，事实、协议、权限或 DB 错误不伪作正常拒识；direct 接纳后 reserve/invoke/render 任一失败不切 LLM、不新 slot 重做。原入站 hash/同键冲突、取消动作幂等和当前权限不变；取消先提交仍禁止迟到候选、工具动作或正文，编码等待可 abort。原 SSE 断连、终态和显式批准恢复语义保持。

## 9. 用户安全点暂停和继续

以下动作需当前用户有权访问会话；POST 要求 CSRF 和 UUID `Idempotency-Key`。同键成功后重试重放同一动作，不创建额外的暂停或继续。并发继续时，首个请求占用运行容量期间，同键请求可能先收到 409；稍后以同键重试可读取已接纳结果。

- `POST /conversations/{cid}/runs/{rid}/actions/pause`，body 为 `{"reason":"user","purpose":"none"}`。响应给出 `pause_id` 和 `pending` 或 `paused`；在途模型流和已接纳工具动作须先按真实状态收尾，登记不等于已暂停。
- `POST /conversations/{cid}/runs/{rid}/actions/continue`，body 为 `{"pause_id":"<uuid>"}`。仅显式继续有效的用户暂停，在同一 Run 创建唯一后继 attempt 并返回 SSE；预算累计、冻结权限及已接受效果保持，继续前重验当前资格。
- 只读 direct 路由决策先接纳时该有界动作可完成；暂停先登记时不接纳新的 direct 决策。已接纳工具进入批准等待时，未到达的用户暂停失效，仍按原批准合同处理；取消或终态也使暂停资格失效。未知工具效果不能伪装为可恢复暂停。
- GET、刷新或重连只读既有状态，不自动继续。暂停不等于批准，也不保证任意崩溃恢复。

## 10. 手动与自动 compact

- `POST /conversations/{cid}/runs/{rid}/actions/compact` 请求活动 Run 在安全点压缩并受控继续同一 Run；`POST /conversations/{cid}/actions/compact` 在会话空闲时接纳独立的用户控制 Run。两个请求均需 CSRF、UUID `Idempotency-Key` 和空对象 `{}`；同键重放不重复创建操作。没有可压缩内容时空闲操作返回 `no_content`，不伪造摘要。
- `GET /conversations/{cid}/runs/{rid}/compacts/{pause_id}` 只读查询操作回执；等待、发布、继续、失败和取消以持久事实为准，不因读取而执行或继续。手动压缩与自动压缩均保留累计预算、原授权和已接受效果；普通用户暂停仍只能显式继续。
- 自动触发使用冻结规划窗口的 80% 与应用估算，既不是实测窗口占用，也不替代供应商 usage；计量不可用时不自动触发。摘要和候选是可追溯的低信任历史，不是授权或语义正确性证明。
