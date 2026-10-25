# 05 对话运行时与预算

| 状态                         | 范围                                    | 不包含                                | 阶段标签                   |
| ---------------------------- | --------------------------------------- | ------------------------------------- | -------------------------- |
| 跟随 design/09/11 的运行合同 | ID、执行归属、预算、批准等待与补读/恢复 | 实际供应商、完整 R1、无人值守通用恢复 | 正式仓颉核心与 TS 长期能力 |

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
- 仓颉构造本次上下文、模型请求，解析提议并纳入工具观察，决定继续/等待/停止；TS model transport 只负责固定配置的 HTTP/协议转换。
- TS 冻结输入、revision、工具范围和时间规则；每个动作根据真实 owner/当前权限/最新 attempt/取消裁决执行资格，不信帧自报权限。
- Run/checkpoint/接受结果及审计留 TS；snapshot 只存有限安全引用/usage/逻辑进度，不存完整推理链或原始工具参数副本。具体 schema/API 见真源，不另立状态机。
- finish 的消息/终态/attempt/Run 同事务；cancel 先提交资格撤销和唯一事件，再终止 native/模型请求。已接受工具与按钮确认任务不被假撤销。

## 预算

- 新 harness 的服务端起步配置为最多8迭代、8000 token，接纳时冻结。仓颉在安排下一轮前检查累计迭代/可得 usage，达到上限即停止；不是 TS 字符估算。
- 缺失 usage 保留未知，不编造真实 token/费用或承诺不能证明的成本上限。输出已发生事实后报告 `BUDGET_EXCEEDED`，不默默截断成成功。
- 批准等待不调用模型/工具；显式恢复沿用累计预算和 `next_call_no`，不是新额度。真实 provider/负载校准与计费单独决策。

## 事件补读与执行恢复

- GET `after_seq` / 同入站幂等键只补读已存七词事件，不重新归一、执行工具或分配 attempt；内部 snapshot 导致游标间隙合法。running 同键409，suspended 可回前缀而不恢复。
- pending 批准：native snapshot→suspend，TS 原子持久等待点，结束 attempt 但不 completed Run；正常挂起 EOF 不作为取消。
- 用户按钮确认可以早于等待提交。Web 批准链接打开新标签页并提示保持原会话，避免导航将尚未挂起的在途运行按普通断连取消。继续时读真实原批准决议：pending 不继续；consumed 将真实 task ID 纳入上下文；rejected/expired/superseded 停止该动作，不跟 successor 或同义绕拒绝。
- 显式 resume 仅接受最后有效批准等待点，沿同 Run 新 attempt、原调用/批准；同点并发/丢回答/换键不多启动。Web 回原运行继续，刷新/补读不自动执行，不重做确认来重试恢复。
- 已接受结果只读，不再执行；本地回滚的 reserved 可沿原身份重交；非事务 unknown 只核对或停止。参数 hash 和旧审计不替代稳定动作身份。
- 任意崩溃/普通 checkpoint 自动恢复、通用 lease 或外部 exactly-once 不在此保证。通知专属许可/回执恢复见 design/08，不泛化到仓颉/文件/MCP。

## 真源

[design/09](../design/09-agent-runtime-and-checkpoint.md) 定义生命周期与恢复级别，[design/11](../design/11-cangjie-runtime-spike.md) 定义正式链路、工具链及分级验收，[API](../api/conversations/conversations_routes.md) 定义用户入口。
