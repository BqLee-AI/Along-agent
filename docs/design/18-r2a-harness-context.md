# 18. R2-A 单 Run 有界上下文

> 状态：Required；实现与分级验收证据见 change tasks，不由本文证明。
> 范围：单 Run 的额度、确定性观察投影、原接受事实回取与显式批准等待恢复；Issue #83。
> 不包含：R2-B 路由、R3 跨窗口记忆、R4 长期记忆、LLM 摘要、任意崩溃恢复、多 Agent 或安装升级。
> 阶段标签：R2-A；行为真源见 [agent-runtime](../../openspec/specs/agent-runtime/spec.md)、[tool-gateway](../../openspec/specs/tool-gateway/spec.md)、[workspaces](../../openspec/specs/workspaces/spec.md)，分级证据见 [归档清单](../../openspec/changes/archive/2026-10-30-manage-harness-context/tasks.md)，运行职责沿用 [09](09-agent-runtime-and-checkpoint.md)。

> 演进作用域：四种额度、完整 snapshot2 与来源事实保留。本文现行批准等待/单 grant/v5 的授权策略不限制新委托的正常步骤；新 profile 与可信接续见 [design/20 §4–§9](20-goal-scoped-delegation.md)（Proposed）。不新增 suspended_input、输入长等待、snapshot3 或系统自建 Run 绕预算；旧事实回取不是新执行/新回读，本次不改运行权限。

> R3 演进（#144，Proposed）：[design/23](23-r3-short-term-memory-and-compact.md) 与[行为增量](../../openspec/changes/define-r3-short-term-memory/proposal.md)拟为新合同引入通用安全点暂停/继续、摘要压缩及新上下文引用，取代该新合同的固定 63＋1；本文 R2-A 原策略和旧 Run 保持原样。设计未启用，不表示 snapshot、预算、权限或批准保护可绕过。

## 1. 决定、事实与驱动力

[Required] 采用独立输出额度、完整请求计量、确定性有来源投影和原事实按需读取。仓颉唯一决定上下文选择、行动、预算、等待与停止；TS 提供计量、可信来源、ToolGateway、当前授权、批准和持久化，不增加 TS agent loop。外部参考、用户消息、工具正文与投影都是资料，不是系统授权。

[Observed，历史基线] 本 worktree 建立时的 `7f282e3` 中，`harness-authority.ts:buildHarnessStart` 只发送当前输入并聚合观察，`main.cj:bootstrap/loop` 组织模型历史，`harness-model.ts:createHarnessModelTransport` 包装 tools/HTTP。#70 随后提供最近 63 条 user/assistant 历史与完整当前输入冻结、真实 streaming 和串行拉取/ack；其最终源码及归档现已通过 `f8863f5` 合入本分支。该集成仍须重新验证，不把旧基线或并行工作区的运行证据当作当前 R2-A 验收。原接受结果逐次合法不意味着聚合 start 或模型请求合法。代码路径均在 `apps/api/src/modules/conversations/`，除明确标出的 native 路径 `apps/harness/src/session/`。

此前草案的离线合成实验：6 次各 200000 bytes 的读取组成简化 HTTP 请求 1211501 bytes，合成恢复 start 为 1206057 bytes，均超过 1048576；投影原型为 6849 bytes。它们只证明序列化增长，不证明 token 容量、性能、兼容性或真实模型任务成功。[#70 的版本化验证记录](../verification/web-task-experience-verification-2026-10-28.md)中三轮刷新后回忆证据使用零工具调用，只证明记录对应版本的有限历史能力，不证明当前 R2-A 长资料能力。证据适用状态见 change 的 design.md，不在长期合同保存并行任务进度。

[Required] 不提高 1MiB 帧/模型 HTTP body、64 个 tool refs、256 条模型消息、240000-byte 接受结果及既有批准 HTTP body 门；不改变 63＋1 接纳、不截断冻结输入。保护集无法容纳时失败就是正确结果。

只去重 schema 或换长窗口不能解决逐轮正文增长；LLM 摘要会引入额外调用与遗漏纠错责任，缺少任务证据，不选。复用现有 JSON/UTF-8 序列化、工具结果账、网关及模型 transport；只增加领域投影，不自建 tokenizer/MCP/配置平台。

## 2. 四种额度与计量

| 概念         | 权威与规则                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Run 累计预算 | 接纳时冻结的 max iterations/max tokens；默认 24/64000；批准恢复不重置。实际 usage 记账，任次缺失后累计 token 为 unknown            |
| 模型窗口 W   | 部署模型能力证据，不从模型名或 Run 预算推导；未知为 null                                                                           |
| 单次输出 C   | 独立正安全整数 completion_cap；不是 remaining_tokens 的别名                                                                        |
| 字节容量     | UTF-8 实际序列化 wire 每帧及最终 HTTP body 各不超过 1048576 bytes；HTTP body 包含 tools、stream 等完整包装，不把字符数当字节/token |

[Required] 输入计量结果为 `{quality:'verified'|'estimated'|'unavailable', input_tokens:number|null, meter_revision:string}`。verified 要覆盖所选模型的消息角色、工具描述/schema、函数参数、函数结果及 provider 隐含包装，具有可核对计量依据；部分 tokenizer 或 bytes/characters 比率最多 estimated。unavailable 的 input_tokens 必须 null。估算永不填入 provider usage。

设完整输入 P、窗口 W、输出 cap C、可证明剩余 Run token R、预留 S。P/W/R 均可信时，仓颉选择整数 `1 <= O <= min(C, W-P-S, R-P)`；无可行 O 不发请求。S 是冻结的非负整数，不能用于宣称估算变精确。W 未知时不宣称窗口保证；R 因缺 usage 未知时省略 R 项、不重置为默认余额；P estimated 时可按估算保守限制，但结果标 estimated，不保证精确窗口/费用。没有 P 时 O 仍不超过 C 和可得 R，字节门仍精确。

当 P 不可用或仅为 estimated 时，累计 max tokens 不是调用前可证明的费用硬上限：一次在途请求可能使实际累计超额，取得真实 usage 后停止后续请求。不得将后验停止写成从未超额，也不能通过投影抹去已用额度。

已知累计预算/迭代耗尽或可信 `R-P<1` 为 BUDGET_EXCEEDED；wire/HTTP/消息数/窗口空间不足为 HARNESS_CONTEXT_LIMIT。两者同时存在先报已耗尽预算，再报容量。provider 明确窗口拒绝或输出 length 截止为 HARNESS_CONTEXT_LIMIT，不把残缺函数参数执行成工具；可得 usage 照实累计。无法识别的供应商/协议错误不猜成容量错误，不自动裁剪重试。

## 3. 冻结策略及旧 Run

[Required] conversations 拥有按 Run 唯一、建后不可改的 `run_context_policies`，不修改 `agent_runs.frozen_context`。存储字段/约束以 [conversation schema 的 R2-A 节](../schema/conversation-and-runs-schema.md#r2-a-上下文策略83) 为准。

策略 payload：`revision`（投影算法版本）、`completion_cap`、`model_window_tokens:number|null`、`input_meter`、`meter_revision`、`reserve_tokens`，以及不含凭据的 `model_binding`。整数为安全整数，C>=1、W>=1 或 null、S>=0；verified 必须有完整计量依据，但 W 可以未知。部署使用必填 `HARNESS_COMPLETION_CAP`、可选 `HARNESS_MODEL_WINDOW_TOKENS` 和默认0的 `HARNESS_CONTEXT_RESERVE_TOKENS`；本地私有配置对应 `model.completionCap/modelWindowTokens/reserveTokens`。现行基线不新增 Web/provider/BYOK 控件；拟议扩展见 design/22，不写仓库 .env。

`model_binding` 为 `{model:string,adapter_revision:string}`，均非空；不保存 endpoint/key。C 为部署必填值、无默认借用 Run 余额；W 默认未知、无可信 meter 时 input_meter=unavailable、reserve_tokens 可为0。部署变更不静默替换冻结绑定。无独立模型 registry 是现行基线；拟议本人接入与独立 Run 版本引用见 [design/22](22-model-provider-settings.md)，不改此策略结构。

新 harness Run 在原接纳事务同时插入策略；business 不插入。恢复读原策略，部署变更不能替换值。model_binding 或计量适配已不兼容时 HARNESS_UNAVAILABLE，先于新 attempt；若只是实时计量能力暂不可用，报告 unavailable，不冒用 frozen verified。策略记录能力依据，不保证每次都可得到精确计量。

拟议模型接入切换后，新绑定 Run 的恢复按原配置版本核验，不与当前部署唯一模型或当前默认比较；旧 Run 的安全处置见 design/22 §4。此项为 Proposed，不表示当前恢复代码已切换。

旧 Run 仅在显式恢复的有效等待点、原资格/预算/决议预检通过后，于分配唯一新 attempt 的同事务补入一次策略；同点并发只保留一个值，回滚不留孤儿策略。GET/同入站重放不创建策略。旧预算/revision/输入/allowlist/waiting 不改，新增工具绝不自动进入旧 allowlist。无回取资格的旧 Run 不省略唯一正文；原完整观察放不下就 HARNESS_CONTEXT_LIMIT。旧快照的限定读取迁移仍沿 design/09，不扩大恢复范围。

## 4. 事实账、保护集与投影类型

[Required] messages、tool_invocations.accepted_result、批准冻结目标/当前决议仍分别是事实权威。模型视图是可重建派生数据，不能回写原接受结果或快照。snapshot2 的完整 message_refs/tool_refs、usage、next_call_no、waiting identity 原样受原集合/单调校验，不引入 snapshot3。

保护集：完整冻结输入与系统规则；每个接受调用的持久身份、tool id、状态、来源/版本；失败和冲突/zero_write；当前批准决议与原批准/apply/新读取的关系；正在用于精确核实的正文片段与新的全文修改基线。逐文件 failures 可分页，但失败数量/不完整事实不可省略。unknown 不进入可恢复投影，沿原正常失败终结。

`start.observations` 为与 snapshot tool_refs 一一对应、同顺序的 union：

- `{view:'full',invocation_id,tool_id,result}`：原 accepted ToolResult，绝不伪造业务 kind；
- `{view:'projected',invocation_id,tool_id,outcome,source}`：source 是 TS 生成的可信元数据，包含原 result_version、kind、可回取字段及总数/单位；有正文省略必须 `omitted:true`。

source 的按 kind 字段：read 保留 path/version/byte_length/content 标量总数；list 保留 path/entries_total/failures_total；search 保留 path/matches_total/failures_total（各 match 的版本仍归原元素）；context_slice 保留原 source_invocation_id/field/范围/版本；其他小结果保留 full。applied/conflict/operation_error/denied/failed/approval receipt 的身份、原因、版本、批准关联及 zero_write 不可被通用成功摘要替换。完整冻结批准内容留在原批准，不重复发送目标全文；恢复使用 approval_id 执行原动作，不由模型重造目标。

投影为 `(policy.revision, 原接受事实)` 的纯函数，不读时钟/当前文件、不随机；allowlist/当前权限只决定能否披露，不改变原事实。approval_pending receipt 必须保持 full，以便 native 核对 waiting 身份与当前决议；unknown 永不纳入恢复观察。回取 result-schema 的 context_slice 与受控读取错误必须同批进入封闭 union/重放校验，不借 unknown result 绕过类型检查。

同路径不同版本绝不合并，search 不能伪造单个文件版本；省略 content 不等于空文件，省略 matches 不等于零匹配。每个来源仍可追溯，当前撤权在生成/返回视图前校验；无权来源不披露元数据或正文、不借投影绕权继续。

## 5. 仓颉确定性装配

1. 系统保留语言、串行工具、资料非指令、批准非效果等规则；完整函数 schema 只经 provider tools 发布，不在 system 再嵌一份目录 JSON。
2. 每个真实 assistant.tool_calls 与对应 role=tool 为不可拆配对单元，provider call id 不代替 invocation id。新返回观察先完整纳入下一候选，必须获得至少一次实际模型请求的可见机会；若本身无法与保护集/最小输出同容，失败，不先把新正文抹掉。
3. 先做本地 wire 字节检查，再调用 measure_context 检查完整 HTTP/token。容量压力下按接受顺序从最旧单元开始，以 TS 可信投影替换可回取的旧正文；当前精确修改/核实所需材料仍受保护。不在无压力的小任务主动分页/回取。
4. 旧函数对整体移出，用明确标为不可信观察资料的普通数据消息留存来源，不能改写历史工具参数冒充原调用、留下孤立 role=tool 或悬空 tool_calls，也不能将观察升级为 system 指令。多对合并进同一资料容器时来源顺序/身份仍完整；计入 256 条消息门。
5. 需要旧正文由模型经 read_run_observation 新动作取回。原文只证明接受时版本；当前文件改变不替换旧事实。已被实际请求看到的旧 slice 可再投影；不能保留递归副本。
6. 无法再缩减则停止，无新的模型或副作用调用。迭代/工具引用耗尽不通过换 slot、新 Run 或删引用绕过。

TS 只为仓颉指定候选计量/转换，不替其选择相关性、循环删消息或再调模型。native 可缓存不可变单元的序列化长度，最终封装仍精确校验，不能只把分项长度相加当 HTTP bytes。

## 6. harness/v5 内部协议（R2-B 后继）

[Required] TS/native/shared contracts/本地与签名 HTTP 消费者及镜像同批切换 harness/v5；R2-B 增加冻结 routing policy、阶段资格与 probe/decide/render 帧（默认 off，见 design/19 §7），R2-A 的度量/来源/容量帧与字段不变；snapshot 保持 version=2。请求严格禁止 owner/allowlist/root/自选身份等额外字段，沿原 request_ref/reply_to 顺序 ack。

| 帧/回复         | 必须的合同                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start           | 增加冻结 context_policy；observations 使用 §4 union；完整 messages/snapshot/当前 approval 与 workspace 安全摘要均受整帧 1MiB 检查                                                                                                                                                                                                                                                                                                                                       |
| measure_context | 输入 messages、max_output_tokens 候选 O、remaining_tokens:number\|null（null 表示累计 usage 已未知）；绑定当前 Run/tools/policy。回复 `wire_bytes,http_bytes,input_meter,output_ceiling,limit_reason`；bytes 是此 O 对应的 model 帧及完整 HTTP body 实际 UTF-8 长度，ceiling 为非负安全整数，reason 为 null/budget/context。O 改变后重验最终序列化；本帧自身也先验 1MiB，不把超帧候选发给 TS 缩减。纯本地计量，零 provider 请求、零 iteration/invocation/checkpoint/SSE |
| model           | 同一候选 messages/余额，新增正整数 max_output_tokens；TS 从真实累计状态校验余额，使用与 measure 相同构造函数和当前冻结 tools，provider max_tokens 只取显式 O；不让帧自报余额成为预算权威                                                                                                                                                                                                                                                                                |
| context_source  | 输入 accepted invocation_id 与 view='full' 或 'projected'；回复 §4 单个 observation。仅当前有效 attempt、snapshot/本 attempt 已接受引用；复用 tools 公共查询与当前权限；不得接受任意路径或 field/offset 来替模型分页                                                                                                                                                                                                                                                    |

v5 保留 #70 的 `model_next{model_ref}` 与 `delta|complete` 拉取/ack 语义，流活跃期间不插入 measure/context_source，不变更在途候选；complete 或失败收尾后才装配下一轮。remaining_tokens 在已知累计时为非负安全整数、未知为 null（不再把最后已知差额冒充可信 R）；model/measure 的值必须与本 Run 累计事实一致。provider finish_reason 由 transport 严格分类，length/明确窗口错误返回容量失败并携带可得 usage，TS/native 同步接受计数，不执行部分函数；无 usage 仍 unknown，不因失败丢掉本次实际模型请求的 iteration。流式已接受 delta 保留，不能用失败伪撤销。

模型 step 增加显式失败分支 `{type:'failed',error:{code,message},usage:{total_tokens:number}|null}`，可由初始 model 或后续 model_next 返回；length/窗口拒绝及网络/协议中断均不伪造 complete。native 接受 failed 时本次实际请求的 iteration 计一次，usage 不可得则累计 unknown，保留已接受 delta 后以真实错误终结；既有 snapshot2 usage 单调规则不变。`measure_context` 的失败不是此分支、不计 iteration。无 provider 请求就拒绝的候选也不增加模型 iteration。

context_source 只重呈现仓颉已合法得到的来源，不创建新 invocation、不调用 MCP、不扩展信息范围。full 用于必须完整呈现的新观察/旧 Run 原观察及恢复首轮装配；模型已看到省略后主动索取精确片段必须走网关工具，不能经内部帧免费代查或后台自动补文。内部帧/measure 也须校验当前 attempt/取消，不接受旧 pipe，返回前重验披露资格。

内部查询经 tools/query.ts 的 `readRunContextObservations`/`readRunContextSource` 公共边界；与 invocation 重放共用只读 accepted-result 水合，不反向导入执行层或文档动作服务。在调用者已持锁时传同一个事务 client，不另开连接重新取 Run 锁，不持锁等待模型/MCP。快照校验先读完整 invocation 状态/引用元数据，不每次水合全部正文再检查 start；`validateSnapshot` 的 start 容量预检同样使用 bounded views。`run_checkpoints.stream_protocol_version` 对内部 snapshot 仅为来源审计标签，不作 snapshot2 读取版本判据；不把内部 v5 标签交给外部 SSE parser。

bootstrap 在 TS 中先取全部引用的安全元数据并核权，直接生成 bounded views，不能先拼全量 results 再缩减。新 Run/恢复 start 初始为最小投影；无回取能力和小的不可省略结果保留 full。恢复首轮由仓颉按引用逆序逐个尝试完整原观察，每次本地字节门及完整请求计量通过才保留，否则还原该来源投影；不聚合全量再缩减，不增加模型轮次或重做原读取。恢复不保证逐字复原上 attempt 函数历史。全部引用及等待身份必须完整，保护集自身超限在启动前 HARNESS_CONTEXT_LIMIT，不偷偷少发。

## 7. 原接受观察的网关回取

[Required] 新静态工具 `read_run_observation`，risk=low（仅模型可见元数据，不是授权引擎），可信 execution_kind=read_only，strict args：

```ts
{ source_invocation_id: UUID,
  field: 'content' | 'matches' | 'entries' | 'failures',
  offset: nonnegativeSafeInteger,
  limit: positiveSafeInteger }
```

仅映射 read.content、search.matches/failures、list.entries/failures；其他 kind/不存在字段/context_slice 来源返回已接受 `operation_error(reason='unsupported_source',path='')`，不递归切片；此 reason 仅用于来源读取，须同批扩展受控 schema。未知、未完成/无 accepted_result、跨 owner/conversation/Run、当前撤权等沿既有 TOOL_FORBIDDEN，冻结 allowlist 外沿 TOOL_DENIED，不披露存在性/内容；不把无权限变空页。既验回取工具本身资格，也验原来源工具与 workspace 当前授权。

新 harness Run 明确冻结授予该工具；无 workspace 时仍不能借此获得 workspace 来源。旧 Run 无该工具时不自动加入。每次读取先预约持久 invocation、按原网关审计/接受，计入 64 tool refs、调用号和既有迭代/预算；同引用重放返回原页，新 slot 为新动作。不重跑原 MCP、文件 IO 或批准动作；当前权限遮蔽不覆写历史。

结果为 `kind='context_slice'`，包含 source_invocation_id、source_tool_id、source_result_version、source_kind、field、unit、offset、end、total、has_more，以及 content 或 items 二选一。read 另含原 path/version/byte_length；search 每个 item 保留原 path/line/text/version；list/failures 保留原元素。范围为半开 [offset,end)，下一页 offset=end；offset>=total 返回空、end=offset、has_more=false，不作为来源缺失。total=原标量数或元素数，不是字节。

content 按 Unicode 标量分页，不拆代理对/UTF-8；BOM 和 CR/LF 都是原标量，拼接原范围保持原文本，不归一换行。数组按接受时稳定下标，不按当前文件重排；允许边界跨 CRLF，禁止默默删除其中一半。

每页**整个接受结果 JSON UTF-8**不超过 16384 bytes，同时遵守全局 240000 门。选择此保守页上限：远小于 1MiB，给当前请求的冻结输入/tools/历史保留空间，不把一个旧事实回取再次放大为 240000；不是 token 保证，也不意味着 64 页可同时装入 start。按实际转义后字节缩小到最大可容纳前缀，返回实际 end/has_more；请求 limit 是数量上限而非必须满足的长度。单个数组元素或元数据加一个标量也放不下时返回 operation_error(range_too_large)，不得半个元素或零进展 has_more。实施用多字节/引号/反斜杠/长匹配行边界验证；真实任务若证明页数成本不可接受再改合同，不先建可调分页平台。

`context_slice` 不是 workspace_read，不可当全文替换基线，也不可满足 apply 后新的 workspace_read 守卫。proposal 继续引用同 Run 原完整 read invocation，由 TS 核对完整原文、唯一 old_text 与当前版本；片段可以帮助复制 old_text，但不更新基线。apply 后必须新 slot、新接受的真实 workspace_read，旧事实回取不等于重新验证。

## 8. 生命周期、错误与发布

| 情况                                  | 可观察结果                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| 保护集/新全文/完整包装不能容纳        | HARNESS_CONTEXT_LIMIT；不丢原事实、不调用下一模型/工具                               |
| 累计 token/迭代耗尽；64 refs 容量耗尽 | 前者 BUDGET_EXCEEDED，后者 HARNESS_CONTEXT_LIMIT；不重置/换 slot，不用投影造额外余额 |
| 当前权限/旧 attempt/取消              | 拒绝新测量后的 model/来源读取及工具，不披露撤权事实；已发生事实保留                  |
| 来源账缺失或类型损坏                  | HARNESS_PROTOCOL_ERROR，不能拿当前文件/空结果修补；合法但无权来源仍走拒绝            |
| 非事务 unknown                        | TOOL_EFFECT_UNKNOWN 正常失败，不快照、不压成成功、不重发                             |
| 程序退出/畸形帧                       | 保留 HARNESS_EXITED/HARNESS_PROTOCOL_ERROR 脱敏分类                                  |

显式批准恢复仍验证 owner、最后等待点、真实当前决议、原预算/策略与登记，分配唯一新 attempt；pending 不继续，拒绝不绕行。投影/回取不新增 SSE 词、自动 continue、后台恢复或 GET 压缩/执行。公开错误映射见 [对话 API R2-A 节](../api/conversations/conversations_routes.md#7-r2-a-上下文容量83)。

新增迁移 `0019_conversation_context_policies.sql`，不改旧迁移；生命周期核验包含0019策略表/约束/不可变触发器。停旧写者、迁移后同批 TS/native 发布，不生产双协议混跑。历史 snapshot2 和原接受结果可读，新事实接纳后旧二进制不是无损回滚，停止新接纳并按原备份/前滚合同处理，不删除策略或结果适配旧代码。安装/真实模型验收与 #70 串行协调；私有旧模型配置须显式补独立 completionCap，不借用累计预算。

## 9. 实现顺序与验收所有权

1. 合同与可比基线：对齐 #70 最终接口与 streaming；保持完整 63＋1、取消、usage、函数历史及文档效果守卫。OpenSpec-only 不等于运行验收。
2. 额度/计量：策略新迁移、独立 C、schema 去重、共享请求构造与无网络 measure；不据此宣布长 Run 完成。
3. 回取/投影/恢复一起交付：tools 公共源查询与新工具、native 装配、v5/bounded start、旧 Run 兼容；没有合法回取时绝不淘汰唯一原文。
4. 正式消费者、真实模型任务和归档：按 change tasks 推进，五门有效后收口；运行任务须另获授权。

| 验收                                                 | 唯一验证负责人 | 必须的证据                                                                                   |
| ---------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| 六个合法大读总量>1MiB、恢复与下一轮有界              | native 集成    | 正式 native＋隔离 PG＋真实本地/签名 HTTP；原正文和全 refs 不变（D8）                         |
| C/W/P/S/R 边缘、unknown usage、输出 length、累计恢复 | native 集成    | 完整 provider 请求/调用计数，P+O+S=W、R=P/P+1、C<余额、tools/转义包装；不可行零请求（D8/D9） |
| 同路径多版本/失败/Unicode/分页及权限                 | TS tools       | 原接受快照字节、首次接受、跨 owner/Run/旧 attempt/撤权/取消拒绝（D1/D8/D9/D10）              |
| 合法函数配对、保护集过大、64 refs/256 messages       | native 集成    | 实际 HTTP 消费，零悬空/假调用，无法缩减诚实停止（D8/D9/D10）                                 |
| 精确批准/唯一 apply/新回读、小任务与长任务           | 端到端集成     | 正式 Web/PG/native/TS MCP/真实模型与产物（D6/D8/D10）                                        |

真实任务至少六份各自合法的大资料、冲突日期及一次读取失败，查证后完整预览→批准零写→显式原 Run 继续→唯一 apply→新全文 read。必须记录发生投影且旧事实确经新 invocation 回取、变化资料影响选择，不以只看投影猜测过关；负例保护内容无法容纳时应失败。小任务核对没有新增无谓模型请求。

每轮记录完整请求 bytes、计量质量/依据、可得 usage（缺失 unknown）、调用数、实际延迟、保留/省略/回取来源与产物，不记录秘密/原始 prompt 到普通日志。合成实验、受控合同、真实模型分账，复用 #70 有效证据，只补受影响边界。确定性行为按 CONTRIBUTING §6.1 先 Red 后 Green；真实模型质量不锁死措辞或唯一工具顺序。五门和 A1–A4 原保证不扩张，归档只在完整验收之后。
