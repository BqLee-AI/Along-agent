# 05 对话运行时与预算

| 状态                         | 范围                                                  | 不包含                                                   | 阶段标签                   |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------------------------- | -------------------------- |
| 跟随 design/09/11 的运行合同 | ID、执行归属、预算、task/document 批准等待与补读/恢复 | 实际供应商选型、完整 R1 真模型验收结论、无人值守通用恢复 | 正式仓颉核心与 TS 长期能力 |

> profile 作用域：单 grant/原批准恢复描述 legacy；wire v6 不代表权限升级。普通 Web Agent 显式接纳 delegation/1，实际工具与本人登记集合随 Run 冻结，生命周期为 request-bound。可信上下文、结构化目标结果见 [design/20 §1、§4–§9](../design/20-goal-scoped-delegation.md)；有限新文件创建与 server-owned 尚未实现，不能从修订推断上线。

## ID 边界

| ID                       | 语义                                                       |
| ------------------------ | ---------------------------------------------------------- |
| conversation_id          | 用户会话；只读补读不分配新运行                             |
| run_id                   | 同一次逻辑执行；批准恢复不换 Run                           |
| attempt_id / attempt_no  | 当前一次有效执行；同等待点唯一恢复时递增                   |
| invocation_id / call_key | TS 持久工具动作；native `harness/N`，不按参数/attempt 重造 |
| checkpoint_id            | 只追加事实；仅有效批准等待点可显式恢复                     |
| request_id               | 传输/审计关联，不作执行身份                                |

## 执行控制与持久化

- HTTP 消息省略 `execution` 仍为 `business`：确定性提醒、取消和查询，无模型循环。Web 普通对话显式发送 `execution=harness`，不要求用户理解执行器或先选工具；提醒快捷入口保持 `business`，资料入口使用显式工作区的 `harness`。缺配置503，不接管/回退同一 Run。
- 仓颉构造本次上下文、模型请求，解析提议并纳入工具观察，决定继续/等待/停止；TS model transport 使用 Run 冻结的本人 OpenAI-compatible 接入，走受控出站与协议转换，不回退部署固定模型。每响应只接受零或一个工具调用，native 明确逐次选择、等待真实结果再继续，独立读取也不并行。transport 发送 `parallel_tool_calls:false` 但不保证供应商遵守，provider/共享回复 schema 与 native 均严格拒绝多个调用。
- 模型请求使用真实 `stream:true`；TS 有界解析 provider SSE，仓颉逐个接受增量并通过 `answer` 取得 TS 持久回执后再 `model_next` 拉取下一步。authority 只接受与当前 pending provider delta 逐字相等的 `answer`；direct 零模型 run 的正文只由 TS renderer 生成，native 不能自写答案。最终完整响应用于工具/历史/用量，不重发正文；工具参数组装完成并校验后才可执行。部分已接受正文可先于 provider 结束呈现，但不是成功或工具效果。取消/断连中止在途 provider，不以完整 JSON 或前端打字效果回退。
- 默认系统上下文要求简体中文，用户明确要求其他语言时遵从；代码、标识符和专有名称不强制翻译。语言规则归原生上下文，普通交流和批准恢复一致，不给前端增加翻译或替代回答。
- 新接受调用保留标准函数历史：`assistant.tool_calls` 与 `role=tool` 原 `tool_call_id` 成对。容量压力下仅仓颉按旧到新整体替换已向模型呈现过的调用对，以不可信普通资料保留来源；不伪造函数参数或留下孤立结果。恢复先发送可信有界视图，snapshot 保留全部事实引用，TS 只原样传输。
- TS 冻结输入、revision、工具范围和时间规则；每个动作根据真实 owner/当前权限/最新 attempt/取消裁决执行资格，不信帧自报权限。workspace grant 还须符合当前登记；历史冻结事实可读不代表新动作持续获权。
- 新 Harness Run 接纳事务内冻结同 owner、同 conversation 的最新 63 条已存 user/assistant 消息引用，按 PostgreSQL `created_at/id` 确定顺序，再追加本轮完整用户输入一次；总计最多64条。消息仅提供可见上下文，不重放此前工具调用，也不把文本当授权。恢复按同一冻结引用及 snapshot 顺序读取，不纳入后来消息；没有跨轮引用的旧 Run 保持原来仅本轮输入的语义。窗口是有界会话上下文而非永久记忆，超1MiB聚合帧仍以 `HARNESS_CONTEXT_LIMIT` 明确失败，不按字节截断输入。
- Run/checkpoint/接受结果及审计留 TS；正式 pipe 为 `harness/v6`，legacy 明确 `trusted_context:null`，新委托使用接纳事务产生的可信 system 事实。v5 wire 硬拒绝新 shape；只读路由仅保留原 profile。snapshot2 仍只存安全引用/usage/逻辑进度；内部路由 checkpoint 的 `harness/v5` 是冻结存储 schema，不是可执行旧 wire。历史 snapshot1 限定读取规则不变：无 workspace、已完成旧业务/task 引用、不含 document 批准；不回写历史。
- finish 的消息/终态/attempt/Run 同事务；cancel 先提交资格撤销和唯一事件，再终止 native/模型请求。已接受工具与按钮确认任务不被假撤销。
- delegation/1 使用 `finish_goal` 提交目标结果，SSE v2 和 RunView 保存逐项目标事实；最终答复、GoalResult、terminal 事件、attempt 与 Run 同事务，异常/取消按同一终结事务保留既成效果。纯正文或工具 completed 不代替目标完成。输入/规则拒绝可交同一模型反馈；`TOOL_FORBIDDEN` / `TOOL_DENIED` 只允许结果说明与 `finish_goal`，native 和 TS 均停止该 Run 后续业务动作；failed/unknown 不继续。请求断开按取消收尾，不回滚已接受偏好；导航、刷新、重登和 GET 只读，不启动新 attempt 或重做设置。
- `finish_goal` 的模型参数与 pipe 帧错误分开处理：JSON、字段、状态聚合或收据资格不合法时，native 返回配对的 `accepted:false / INVALID_GOAL_RESULT` 控制观察，不接纳目标、不伪造成功；此后只允许提交修正后的目标结果，不再预约或执行业务工具。修正使用原模型迭代/token预算，耗尽按原预算错误终结；既成领域结果与收据保留。pipe/传输故障仍按原协议失败，不捕获为可继续的业务观察。普通用户无需知道或输入控制工具名。
- TS 根据已接受效果复核目标时，如缺少写后新读收据，也返回对应的结构化拒绝原因；原运行保持未终结，模型只能修正结果，不得重做文件写入或其他业务动作。
- 已验证写入及其对应的新读回执可以分别列在不同的已达成目标中；两者仍须来自服务端核对过的同一文件效果，不能用其他读取或未达成项代替。
- owner 在途 disabled 时拒绝后续动作；内部失败追账只核验 owner/conversation/run、冻结 profile 与既成接受结果完整性，不重新索取已撤销的执行资格，因此仍能原子保存唯一终态。该内部投影不是公开读取或执行入口；普通工具/GET仍要求有效身份，撤权后的原连接也不披露包含目标结果或收据的终结内容。恢复有效身份后只读原持久事实，不自动重做。
- legacy 有限 workspace 使用五个工具；合格新 delegation 另可使用 `workspace_replace` 直接编辑，读取工具显式指定冻结集合中的 workspace。前三个读取经 TS 薄只读 MCP，提案和直接编辑均绑定同 Run 真实全文 read；写后独立新读才可 verified。工具顺序由仓颉决定，TS 不隐藏另一套 Agent 或固定代跑链。

## 预算

- 新 harness 默认最多24迭代、64000 token，由部署服务端 `HARNESS_MAX_ITERATIONS/HARNESS_MAX_TOKENS` 配置，须为正安全整数；Web/模型不能覆盖。额度在 Run 接纳时持久冻结，后续部署配置变化不升级原 Run。仓颉在安排下一轮前检查跨 attempt 累计迭代/可得 usage，达到上限即停止；不是 TS 字符估算。
- 单次输出由独立必填 `HARNESS_COMPLETION_CAP` 限制，provider `max_tokens` 只取该上限内显式选择的 O，绝不取累计余额。窗口 `HARNESS_MODEL_WINDOW_TOKENS` 可未知，`HARNESS_CONTEXT_RESERVE_TOKENS` 默认0。完整请求 UTF-8 字节精确计量；无可信完整输入 tokenizer 时明确 unavailable，不由字符估算伪造 token。
- token 上限不是账单硬上限。单次响应返回的输入与输出用量可能让累计值越过阈值；此时停止本轮后续动作，不把超限回答当成功。
- 批准等待不调用模型/工具；显式恢复沿用累计预算和 `next_call_no`，不是新额度。24/64000 是当前默认，不是实际 R1 已校准的证明；真实 provider/负载校准与计费单独举证。
- 任次缺 usage 后累计 token 保持 unknown；仍限制独立输出和实际字节，不承诺无法证明的费用/窗口上限。已耗尽累计预算为 `BUDGET_EXCEEDED`；保护集、窗口、输出 length 或完整请求超容量为 `HARNESS_CONTEXT_LIMIT`。流式失败保留已接受 delta 和可得 usage，不执行残缺函数参数。

## 事件补读与执行恢复

- GET `after_seq` / 同入站幂等键只补读已存七词事件，不重新归一、执行工具或分配 attempt；内部 snapshot 导致游标间隙合法。running 同键409，suspended 可回前缀而不恢复。
- pending 批准：native snapshot→suspend，TS 原子持久等待点，结束 attempt 但不 completed Run；正常挂起 EOF 不作为取消。
- 用户按钮确认可以早于等待提交。Web 批准链接打开新标签页并提示保持原会话，避免导航将尚未挂起的在途运行按普通断连取消。继续时读真实原批准决议并按接受事实判别种类：task 的 pending 不继续、consumed 将真实 task ID 纳入上下文、rejected/expired/superseded 停止该动作，不跟 successor 或同义绕拒绝；document 的 pending 不继续、rejected 停止、approved 仅作为原冻结替换的授权观察，不伪造 task ID/卡片或宣称写入完成。
- 显式 resume 仅接受最后有效批准等待点，沿同 Run 新 attempt、原调用/批准；同点并发/丢回答/换键不多启动。Web 回原运行继续，刷新/补读不自动执行，不重做确认来重试恢复。
- document approved 后仍由仓颉选择 `workspace_apply_replace({approval_id})`，每个批准仅绑定一个 `non_transactional` apply invocation；接受 applied 后须新 `workspace_read` 证明实际结果。TS 在 done 前核对文档效果链；原提案不重 invoke，批准不替代 apply/新回读，冻结内容不因恢复改变。
- 已接受结果只读，不再执行；本地回滚的 reserved 可沿原身份重交。生产非事务 unknown 立即正常 `finish(failed,TOOL_EFFECT_UNKNOWN)`，不推进调用号、不纳入 accepted 引用、不造 snapshot/checkpoint 或 suspend，也不再模型/预约/重写；failed 终态照常持久化。参数 hash 和旧审计不替代稳定动作身份。
- 任意崩溃/普通 checkpoint 自动恢复、通用 lease 或外部 exactly-once 不在此保证。通知专属许可/回执恢复见 design/08，不泛化到仓颉/文件/MCP。
- R1 文档执行路径按正式原生协议运行；受控模型合同、真实模型隔离探针与实际文档全链验收分开声明。探针不证明 Web→TS→native→工具→实际产物/新回读完成；既有 #46/#47 历史验收只覆盖各自适用版本，不自动升级为完整 R1 证明。
- 既有历史证据不能自动证明 R2-A 长资料投影、回取和用户产物正确。

## 真源

[design/09](../design/09-agent-runtime-and-checkpoint.md) 定义生命周期与恢复级别，[design/11](../design/11-cangjie-runtime-spike.md) 定义正式链路、工具链及分级验收，[API](../api/conversations/conversations_routes.md) 定义用户入口。
