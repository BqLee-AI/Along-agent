# 05 对话运行时与预算

| 状态                         | 范围                                                  | 不包含                                                   | 阶段标签                   |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------------------------- | -------------------------- |
| 跟随 design/09/11 的运行合同 | ID、执行归属、预算、task/document 批准等待与补读/恢复 | 实际供应商选型、完整 R1 真模型验收结论、无人值守通用恢复 | 正式仓颉核心与 TS 长期能力 |

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

- 消息默认 `execution=business`：确定性提醒、取消和查询，无模型循环。Web 明确选择 harness 才进入正式仓颉，缺配置503，不接管/回退同一 Run。
- 仓颉构造本次上下文、模型请求，解析提议并纳入工具观察，决定继续/等待/停止；TS model transport 只负责部署固定配置的 HTTP/协议转换，普通用户不配置 provider/BYOK。每响应只接受零或一个工具调用，native 明确逐次选择、等待真实结果再继续，独立读取也不并行。transport 发送 `parallel_tool_calls:false` 但不保证供应商遵守，provider/共享回复 schema 与 native 均严格拒绝多个调用。
- 当前 attempt 的工具提议/结果由 native 保持标准函数历史：`assistant.tool_calls` 配对 `role=tool` 的原 `tool_call_id`，不以普通 assistant 文本冒充工具调用；TS 只原样传输。恢复 bootstrap 可使用已接受观察的明确数据摘要，snapshot 仍只保存事实引用。
- TS 冻结输入、revision、工具范围和时间规则；每个动作根据真实 owner/当前权限/最新 attempt/取消裁决执行资格，不信帧自报权限。workspace grant 还须符合当前登记；历史冻结事实可读不代表新动作持续获权。
- Run/checkpoint/接受结果及审计留 TS；正式 pipe 仅 `harness/v2`，snapshot2 只存有限安全引用/usage/逻辑进度，不存完整推理链或原始工具参数副本。历史 snapshot1 仅由 TS 在无 workspace grant、引用均为已完成的旧业务/task 能力且不含 document 批准时读取并构造 snapshot2 bootstrap；不改写历史、不执行/写出 v1，不作为旧运行器回退。具体 schema/API 见真源，不另立状态机。
- finish 的消息/终态/attempt/Run 同事务；cancel 先提交资格撤销和唯一事件，再终止 native/模型请求。已接受工具与按钮确认任务不被假撤销。
- 有限 workspace 仅提供 `workspace_list/workspace_grep/workspace_read/workspace_propose_replace/workspace_apply_replace` 五工具；前三个经 TS 薄只读 MCP，提案绑定本 Run 的真实全文 read。工具顺序由仓颉决定，TS 不隐藏另一套 Agent 或固定代跑链。

## 预算

- 新 harness 默认最多24迭代、64000 token，由部署服务端 `HARNESS_MAX_ITERATIONS/HARNESS_MAX_TOKENS` 配置，须为正安全整数；Web/模型不能覆盖。额度在 Run 接纳时持久冻结，后续部署配置变化不升级原 Run。仓颉在安排下一轮前检查跨 attempt 累计迭代/可得 usage，达到上限即停止；不是 TS 字符估算。
- 缺失 usage 的累计值保持未知，不编造真实 token/费用或承诺不能证明的成本上限。报告 `BUDGET_EXCEEDED` 并保留已发生事实，不默默截断成成功。
- token 上限不是账单硬上限。单次响应返回的输入与输出用量可能让累计值越过阈值；此时停止本轮后续动作，不把超限回答当成功。
- 批准等待不调用模型/工具；显式恢复沿用累计预算和 `next_call_no`，不是新额度。24/64000 是当前默认，不是实际 R1 已校准的证明；真实 provider/负载校准与计费单独举证。

## 事件补读与执行恢复

- GET `after_seq` / 同入站幂等键只补读已存七词事件，不重新归一、执行工具或分配 attempt；内部 snapshot 导致游标间隙合法。running 同键409，suspended 可回前缀而不恢复。
- pending 批准：native snapshot→suspend，TS 原子持久等待点，结束 attempt 但不 completed Run；正常挂起 EOF 不作为取消。
- 用户按钮确认可以早于等待提交。Web 批准链接打开新标签页并提示保持原会话，避免导航将尚未挂起的在途运行按普通断连取消。继续时读真实原批准决议并按接受事实判别种类：task 的 pending 不继续、consumed 将真实 task ID 纳入上下文、rejected/expired/superseded 停止该动作，不跟 successor 或同义绕拒绝；document 的 pending 不继续、rejected 停止、approved 仅作为原冻结替换的授权观察，不伪造 task ID/卡片或宣称写入完成。
- 显式 resume 仅接受最后有效批准等待点，沿同 Run 新 attempt、原调用/批准；同点并发/丢回答/换键不多启动。Web 回原运行继续，刷新/补读不自动执行，不重做确认来重试恢复。
- document approved 后仍由仓颉选择 `workspace_apply_replace({approval_id})`，每个批准仅绑定一个 `non_transactional` apply invocation；接受 applied 后须新 `workspace_read` 证明实际结果。TS 在 done 前核对文档效果链；原提案不重 invoke，批准不替代 apply/新回读，冻结内容不因恢复改变。
- 已接受结果只读，不再执行；本地回滚的 reserved 可沿原身份重交。生产非事务 unknown 立即正常 `finish(failed,TOOL_EFFECT_UNKNOWN)`，不推进调用号、不纳入 accepted 引用、不造 snapshot/checkpoint 或 suspend，也不再模型/预约/重写；failed 终态照常持久化。参数 hash 和旧审计不替代稳定动作身份。
- 任意崩溃/普通 checkpoint 自动恢复、通用 lease 或外部 exactly-once 不在此保证。通知专属许可/回执恢复见 design/08，不泛化到仓颉/文件/MCP。
- 当前 R1/v2 文档执行路径已存在，但受控模型合同、真实模型隔离探针与实际文档全链验收分开声明；探针不证明 Web→TS→native→工具→实际产物/新回读完成。既有 #46/#47 历史验收只覆盖各自适用版本，不自动升级为完整 R1 证明。

## 真源

[design/09](../design/09-agent-runtime-and-checkpoint.md) 定义生命周期与恢复级别，[design/11](../design/11-cangjie-runtime-spike.md) 定义正式链路、工具链及分级验收，[API](../api/conversations/conversations_routes.md) 定义用户入口。
