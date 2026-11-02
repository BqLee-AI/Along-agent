# 09. AgentRuntime 与 Checkpoint 设计

## 文档状态

- **状态**：Harness 与 TS 可信运行合同；design 为字段与责任真源，PRD 跟随
- **范围**：确定性业务、正式仓颉核心、工具调用、task/document 批准等待恢复、R1 有限 workspace 与事件投影
- **不包含**：实际供应商选型、完整 R1 真实产物验收结论、任意崩溃无人值守恢复或通用 external exactly-once
- **阶段标签**：业务与 Harness 明确分派；跨语言 CI 证明范围见 design/11 §4

> profile 作用域：本文 v5、单 grant、逐项批准及断流取消继续描述现行/legacy。新可信 start、GoalResult、v6、服务端执行占有和受限旧恢复见 [design/20 §4–§9](20-goal-scoped-delegation.md)（Proposed）；唯一 Harness、累计预算、稳定结果和未知不重做保留，本次无业务实现。

## 标记约定

Observed / Required / Proposed / Deferred 同 01；运行记录只写进对应验收记录或 PR，不混作长期能力保证。

## 1. Harness 与 TS 的唯一责任

- [Required] 仓颉唯一拥有模型/工具循环、本次上下文、工具观察、行动选择、迭代/usage 计数、等待/继续/停止。正式源为 `apps/harness`，不是固定动作回放器；TS 不保留第二套通用 Agent。
- [Required] TS 长期保留身份/权限、ToolGateway、批准/time-core/tasks/scheduler/notifier/outbox/worker、API/Web 与 Run/checkpoint/结果/事件持久化。memory/grep、MCP、办公和 PC/browser 属于 TS 能力边界，不在仓颉内重建后端。
- [Required] `execution=business` 是原有确定性业务；省略兼容该路径。`execution=harness` 明确进入仓颉且本阶段 `mode=chat`，不借 `chat/task` 隐式选择执行器，不因失败改走业务/fixture。
- [Required] TS 从 session/Actor 接受 Run，冻结 revision、工具范围、输入与时间规则。每个进程绑定一个有效 attempt；每次动作重新核验 owner、当前权限、Run/attempt 与取消状态。用户停用或明确撤权拒绝新动作；普通 session 轮换不自行取消已接受 Run，操作入口仍需当前认证/CSRF。

### 不信任三原则（Required）

1. 用户原话按不可信输入解析，工具参数在 TS 通过每工具 strict zod schema 重验。
2. 模型输出不确定时间、批准或业务事实；时间由 time-core，承诺只经冻结按钮确认。
3. pipe 只传建议和引用，不接收 owner、allowlist、数据库身份或自选执行资格；内部 `ToolContext` 不作为远程 DTO。

## 2. 接口语义与正式传输

HTTP 消息、Run 读/取消/恢复路由见 [conversations API](../api/conversations/conversations_routes.md)。TS adapter 与同容器固定 native 产物只通过 `harness/v5` UTF-8 NDJSON 双向交互（含只读路由帧，路由默认 off），执行/写出快照仅 `version: 2`；不执行或写出旧 wire。`shell=false`，子进程仅得到必要 locale/运行库配置，不继承 DB/auth/cookie/model key。

- TS→native：`start/reply/cancel`；native→TS：`measure_context/model/model_next/context_source/reserve/invoke/snapshot/suspend/answer/finish`，以及 `route_probe/route_decide/render_route_result`（路由默认 off）。模型流按 delta 拉取和原样 ack，完整或失败收尾前不插入上下文装配。
- 具体 strict schema 与公开 Run DTO 的唯一类型源为 [contracts/harness.ts](../../packages/contracts/src/harness.ts)。两端拒绝未知字段、版本、畸形 UTF-8/JSON、残缺 EOF 与超过 1MiB 的累计帧；发送前也检查字节大小，不静默截断上下文。
- `request_ref/reply_to` 仅关联当前 pipe，不能替代持久身份；一个请求等待 ack 后再继续。snapshot/suspend/finish 的 ack 必须在 TS 对应事实提交后返回。
- TS model transport 仅使用部署服务端固定的 OpenAI-compatible chat-completions 配置做 HTTP/协议转换；普通用户不配置 provider/BYOK。仓颉构造上下文并解析提议、选择工具与决定下一轮。未配置时新 harness Run 在任何写入/SSE 之前返回 `503 HARNESS_UNAVAILABLE`，不启用测试 transport。
- 模型 transport 请求 `stream:true`，逐次给出当前模型响应的可见增量或完整结果；native 每次将增量经 `answer` 取得 TS 持久回执后再以 `model_next` 拉取，保持单请求等待和背压。完整结果只用于工具/历史/用量，正文不重发；参数未完整时不执行工具。部分接受文本不是成功，畸形/中断流明确失败，取消关闭在途 reader，不保留非流式回退。原生系统上下文默认简体中文、明确语言要求优先。
- 每模型响应最多一个工具提议。transport 发送 `parallel_tool_calls:false`，但不保证供应商遵守；provider/共享回复 schema 与 native 严格拒绝多个调用，不只取第一项。native 明确要求一次选择一个工具、等待实际观察后才选择下一步，独立读取亦然。运行说明、固定工具链和分发 notices 见 [harness README](../../apps/harness/README.md)。
- native 持有标准函数消息历史：实际提议存为 `assistant.tool_calls`，实际结果存为 `role=tool` 并使用对应 `tool_call_id`；TS 仅按结构原样 transport，不用普通 assistant 文本模拟工具调用。恢复 bootstrap 中的已接受观察可以是明确数据摘要；snapshot 仍只存事实引用，不扩展为完整函数历史。
- 部署默认预算为24迭代、64000 token，可由服务端 `HARNESS_MAX_ITERATIONS/HARNESS_MAX_TOKENS` 配置；须为正安全整数，不能由 Web/模型请求覆盖。Run 接纳时持久冻结，仓颉按跨 attempt 累计迭代/可得 usage 强制，不因批准恢复或部署后来改配置重置。缺失 usage 的累计值保持未知，不字符估算、不编造费用；超预算后不安排后续模型/工具，保留已发生事实并失败。默认值不是实际 R1 预算校准证据，无法证明的 token/费用上限不作保证。

## 3. 事件词汇与内部快照

对外只使用 `packages/stream-protocol` 的七词：`thread.started/message.delta/card.proposed/approval_required/thread.completed/thread.failed/thread.cancelled`。内部快照不是新 SSE 事件，不把内部词交给 `ThreadEventSchema`。

- `harness_snapshot` 复用只追加 `run_checkpoints`，内容为版本、受控消息/工具结果引用、`next_call_no`、累计 usage 与批准等待引用；不存密钥、完整推理链、原始 provider body 或工具参数副本。
- TS 核对消息属于已接受 Run 输入、工具引用属于同 owner/conversation/Run 且已有接受结果；计数与 call_no 不倒退。快照不能提升权限。
- 历史 snapshot1 只由 TS 校验读取：Run 无 workspace grant、所有工具引用均为已完成的旧业务/task 能力且不含 document 批准，才在内存构造 snapshot2 bootstrap。历史行不重写；不允许旧记录获得 workspace 权限，不以历史读取保留 v1 执行/回退。
- 批准当前决议另由 approvals 公共只读 DTO 取得；不能把不可变的原 `approval` 接受结果当成当前已确认状态。

## 4. Run / attempt 与原子裁决

```text
Run:     running → suspended_approval → running → done | failed | cancelled
attempt: running → done | failed | fenced_out
```

- 挂起结束该 attempt，不终结 Run；显式恢复分配递增新 attempt。同等待 checkpoint 唯一有效恢复，旧 pipe 不重新获得执行权。
- 写者采用 `attempt → Run → invocation` 锁序，锁内验证最新 attempt、预期状态与引用。cancel 遇到 resume 改变当前 attempt 时重新定位，不重做工具效果。
- finish 将已接受助手 delta 合并的消息、唯一终态 checkpoint、attempt 与 Run 同事务提交；错误全回滚。没有助手输出的结构化失败只存终态事件，不由 TS 合成助手回合。保留已接受工具事实，未完成/unknown/failed 或未决批准不能伪装 done。
- cancel 先原子提交 cancelled、撤销执行资格和唯一取消事件，再通知/终止进程并 abort 模型 HTTP。工具先提交则事实保留，取消先提交则拒绝新动作。Run 取消不撤销独立按钮确认已建任务，也不篡改批准决定。
- 模型/pipe 等待不持 DB 事务。进程/协议失败脱敏为 `HARNESS_EXITED/HARNESS_PROTOCOL_ERROR`，不得覆盖已经提交的取消、挂起或终态。

## 5. ToolGateway 交互（Required）

- 工具范围为 Run 冻结产品策略与当前授权的交集；allowlist 外调用 `TOOL_DENIED`，执行资格拒绝遵循工具绑定合同。
- 先独立持久预约 `invocation_id`，再执行。native 单调分配 `harness/N` slot，恢复沿原引用与已用计数；hash/provider call id/request/attempt 不替代动作身份。同参数新动作才分配新 slot。
- `tool_invocations` 是身份/冻结上下文/接受结果事实源，`tool_calls` 只追加提交审计。本地批准、接受结果及审计同一 client 事务；原冻结结果不可变，当前权限可遮蔽但不能删除事实。
- tasks 的候选/列表、brief 的卡片投影、identity 的偏好通过各自公共 query-client 用例读取，保留原字段、过滤、排序、limit 与 caller 事务。不在 gateway 查询其他模块私表。
- 原生回答按实际回执与工具查询范围解释证据：用户要求 N 条不等于已创建 N 条；标题/备注中的第 k/N 条只是用户内容，不是数量或后续计划回执，历史助手承诺也不是回执。创建/执行进度仅据实际已消费的创建批准、任务记录和执行回执陈述，并区分已创建与已执行。部分完成或缺证据时区分已完成、未完成/未知，不承诺自动继续，不擅自补建或重跑。
- `list_tasks` 是有界当前状态查询，默认只读活动状态，不包含 fired/missed/cancelled。空列表只说明该范围内无匹配；空或非空都不能证明历史创建失败、剩余请求已存在或稍后会出现，不能否定已确认的批准/任务回执或据此建议重复创建。当前上下文未携带原回执也不等于原回执不存在，不能仅因缺失或本次查不到就声称先前明细虚构、没有真实回执；只能说明本次读取无法核实先前创建/执行。回答确需补证时，仅按目标做相关明确状态或既有回执的只读核实；否则说明未知，不为回答列表反复查询无关状态。此约束不改变原按钮确认、批准消费与调度执行回执合同。
- 普通当前列表问题只报告本次匹配、过滤与上限，不主动评判旧回答或推测历史任务。只有用户询问批量完成情况时才按可核实记录区分已确认数量与未知部分；标题中的序列标签不形成自动续建安排。
- 已接受结果只读回，不再执行；reserved 按原身份重交，本地事务回滚不产生脱节批准。非事务 unknown 只能核对或停下，不盲重发。完整规则见 design/04 §3、agent/02 与调用 schema。

## 6. 事件补读、有限等待恢复与效果恢复

- GET `after_seq` 与同入站幂等键只补读已存外部帧，绝不分配 attempt、启动 native、归一或调用工具。running 同键仍409，suspended 可读已存前缀；同 owner/key 换 execution 冲突，不另开幂等空间。历史 business 的 hash 材料保持兼容，harness 使用独立版本域。
- native 取得真实批准提议后先存有限快照，再 suspend；TS 核对同 Run 接受调用/批准，原子保存等待引用并 ack。该段流没有 completed；正常挂起结束流不触发取消。
- 用户确认可早于 suspend。恢复按真实接受结果判别批准种类，不信 native 自报 kind：task 的 pending 拒绝继续，consumed 交付真实 task ID；rejected/expired/superseded 立即停止原动作，不跟 successor 或同义绕拒绝。document 的 pending 拒绝继续、rejected 停止，approved 仅作为授权观察继续原 bootstrap，后续 apply/新 read 由仓颉选择。两者均沿原预算/计数，已接受提案不重 invoke；document 不伪造 task ID 或 task 卡片。
- 只允许最后有效批准等待 checkpoint 的显式恢复。同键丢回答可定位原新 attempt，同点换键不多启动；不重放旧 started/delta，不重做原 invocation。
- 浏览器运行中真实断连请求持久取消，Next 代理转发实际 abort；Web 的显式停止更可靠。刷新仅查询/补读。当前 Harness 提醒等待点可在对话内完整审阅后明确点击“确认创建并继续”或“确认取消并继续”，同一次点击依次执行原确认和原Run继续；只有核验consumed回执后才继续，绑定原批准与checkpoint，不扩展到business快捷入口、文档批准或后继提议。继续失败只恢复原继续请求，不重新提交确认。
- [Deferred] 自动重启、任意 checkpoint、无人值守崩溃恢复仍需独立工具/授权/并发证据；lease 字段、checkpoint 与取消 fencing 都不保证通用 external exactly-once。design/08 的通知专属一次许可/回执证据不泛化到仓颉/文件/MCP。

## 7. 不可变 revision（Required，对标 a13n）

- Agent、prompt、skill 的已发布 revision 不可变，新版递增，不原位改旧定义。
- 每个 Run 冻结实际 agent revision、presentation/time 规则版本及工具范围；续跑不能升级。支持范围外的旧时间规则不可用时类型化拒绝，不偷偷用新规则重算。
- revision 冻结只证明选择与解释边界，不单独证明供应商、模型质量、成本或完整 R1 验收。

## 8. 流投影（SSE，Required；WS 延后）

- 在线消息与显式 resume 使用既有 SSE 版本/schema，事件落库再投影；持久 assistant 与终态原子一致。合法长回答按每帧最多4000个 UTF-16 code units 分块，不拆开代理对；拼接保持原文本，不扩大七词 schema。
- `event_seq` 是不透明全局游标。内部快照造成间隙合法；同 conversation 对外追加序列化分配和提交，避免小游标晚提交被 GET 永久漏读。游标锁采用与外键 KEY SHARE 兼容的 NO KEY UPDATE，避免并发终态消息写者升级锁死锁。
- WS/ws-ticket、Web Push/其他推送按原阶段与 Deferred 决策，不因 native 接入自动扩展。

## 9. R1 文档批准与正常未知终结（Observed / Required）

[14 §7](14-r1-document-task-loop.md) 与 `harness/v5`/snapshot2 共同说明 task/document 批准判别、有限 workspace 上下文和同 Run 文档批准恢复；不增加事件词或任意恢复入口。五个 workspace 工具负责文件能力，`read_run_observation` 仅回取原接受事实；TS 提供授权/工具事实，仓颉决定顺序，不由 TS 固定脚本代跑。

- document 提案绑定本 Run 接受的全文 read 和精确替换，按钮只授权原冻结内容。恢复 DTO 使用 `kind=document`、`approval_id`、`pending|approved|rejected`、可空 `apply_invocation_id`，不携带伪造 task_id；等待快照只存原 invocation/approval 身份。
- 每个批准仅绑定一个 `non_transactional` apply invocation；批准与写入分离，接受 applied 后仍需新 `workspace_read` 证明实际内容。done 前 TS 核对真实文档效果链，不把批准或模型自述当完成。
- 生产 unknown 正常 `finish(failed,TOOL_EFFECT_UNKNOWN)`，不加入 accepted tool_refs、不推进调用号、不造 snapshot/checkpoint 或 suspend，也不再调用模型/预约/重写。这里禁止的是 unknown 恢复快照，不是禁止持久 failed 终态；已接受 denied/failed 仍可保存其有限事实快照后失败。
- 冻结批准/历史结果仍可审阅；新 attempt 恢复及每次新动作仍核验当前 workspace 登记、owner、权限与取消资格。冻结事实不是持续授权，不能因已批准而绕过当前登记。

这些是当前可执行合同，不代表完整真实 R1 已验收；受控合同和真实模型隔离探针不能替代真实 Web→TS→仓颉→工具→文档产物/新回读证据。

## 10. R2-A 有界上下文合同（#83）

[Required] [18](18-r2a-harness-context.md) §2–§9 统一定义累计预算/窗口/单次输出/字节容量、不可变 per-Run policy、确定性来源投影、原接受事实回取及有界 start/批准恢复。wire 为 harness/v5（R2-B 后继），snapshot 仍 version=2；本节容量/回取行为不变，保留 63＋1 完整冻结输入、model_next 拉取/ack 与流式错误的 usage。公开 HTTP/SSE/RunView 不因容量管理扩张。

仓颉唯一选择上下文及动作，TS 计量完整包装/查询可信来源，不增加第二 loop。snapshot2 全 message_refs/tool_refs、usage、next_call_no 和 waiting identity 不裁剪；accepted_result/冻结输入不改写。没有回取资格不淘汰唯一正文，保护集不能容纳则失败，旧 Run 不自动扩大 allowlist。精确修改/新回读与 unknown 规则仍沿 §9、design/14；实施和真实模型验收以 change tasks 分账，不由本文证明。

## 11. R2-B 只读意图路由（已实现，默认 off，#88）

本节记录已实现的 R2-B 合同，不替换上文 Required 或 R2-A 合同。[wire schema](../../packages/contracts/src/harness.ts) 为 `harness/v5`；native 仅在 `eligible_phase=fresh_first_step` 的首 attempt、首模型前发一次 `route_probe`（规则未命中时再一次 embedding），`route_decide` 后 direct 只走原 reserve/invoke 与 `render_route_result`；off 时不发 probe。内部合同、不可变记录、工具/展示和失败边界分别以 [design/19](19-r2b-readonly-intent-routing.md) §7、§8、§9、§10 为真源，字段和约束不在本文另立一套；实现与启用/验收分账。

- 仅 fresh Run 首 attempt 首模型前允许一次路由；`off` 默认且零分类，缺路由策略的旧 Run 按 off，不补录。GET、同入站键补读、批准 resume 零分类；这不改变 R2-A 对上下文策略的独立恢复合同。business/省略 execution 不变，不新增 auto 或公开 execution/SSE。
- 仓颉唯一决定下一步、工具和停止；TS 只提供可信事实、字面匹配事实、参数来源、编码/打分及 authority、原 ToolGateway、持久化和固定展示，不复制一套 TS agent loop。shadow 只记潜在候选并最终 fallback，不调用候选旁路业务工具，回答仍走原模型路径。
- `harness/v5` 已同批切换 contracts、TS、native 与消费者；start 增加冻结 routing policy 和阶段资格，内部新增 `route_probe`、`route_decide`、`render_route_result`，snapshot2 不加字段。新 Run 在原接纳事务首 attempt 记录 policy（含 off）；三种内部 checkpoint 由迁移 `0020_conversation_readonly_routing.sql` 建立，详见 design/19 §8，不写入 frozen_context、不进入外部七词。
- enforce 仅接管已批准的 `task_list_bounded→list_tasks`、`prefs_timezone_read→get_user_prefs`、`brief_cards_read→read_brief_cards`。来源必须是本轮原话可定位范围或明确合同默认，owner 由 TS 注入；其他目标完整交原 LLM，不能丢掉筛选、否定或第二目标来凑白名单。
- direct 接纳后仅一个绑定目标/参数的原 reserve/invoke；真实成功 accepted_result 与 snapshot 接受后，TS 纯 renderer 由事实生成固定展示，同事务保存 delta 和 render 回执，native 不提交任意正文。done 须唯一真实成功结果、render 回执和零模型；不伪造 provider 调用或 usage。展示遵守有界列表/单日卡片限制，不把空值、截页或读取快照说成已配置、查全或新核实。
- authority 只接受与当前真实 pending provider delta 逐字相等的 `answer`；direct 决策后拒绝 `answer/model/model_next/measure_context/suspend`，任何零模型 `finish(done)` 都必须有受控 render 回执。正文来源因此只有真实 provider delta 或 TS renderer，native 不能自写答案。
- direct 前低分/不适用/可选编码失败才可回原 LLM；事实、协议、权限或 DB 错误不能伪作拒识。direct 接纳后 reserve/invoke/render 失败不得再切模型或新 slot 重做。取消先提交仍拒绝迟到候选/输出；编码在锁外且可 abort，原 invocation、入站/取消幂等与只读重放保护不变。

## 引用

- B02§2/B04/AF§4–§7、B06§8 仅作机制参考，不复制外部产物。
- [11 工具链与分工](11-cangjie-runtime-spike.md)、[API](../api/conversations/conversations_routes.md)、[存储](../schema/conversation-and-runs-schema.md)、[ADR0009](../adr/0009-cangjie-harness-ts-capabilities.md)。
