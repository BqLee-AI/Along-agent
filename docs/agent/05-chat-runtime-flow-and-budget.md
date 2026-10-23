# 05 对话运行时与预算

| 状态                         | 范围                              | 不包含                                    | 阶段标签                                          |
| ---------------------------- | --------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| 跟随 design/09/11 的规范摘要 | ID 边界、预算、等待/补读/恢复责任 | 最终远程 DTO、R1 实现、SQL 与通用恢复保证 | v0 确定性 TS turn；R1 仓颉唯一 Harness 目标未实现 |

## ID 边界

| ID              | 语义                                                            |
| --------------- | --------------------------------------------------------------- |
| conversation_id | 用户会话；事件补读保持同一会话                                  |
| run_id          | 一次逻辑执行；批准等待/继续保持同一 Run                         |
| attempt_id      | 执行尝试，不把网络重连当新 attempt；并发/重启分配合同随接入定义 |
| request_id      | 链路追踪，不替代入站幂等键或逻辑工具调用身份                    |

[Required] 身份/资源关联 ID-first，公开用例可传显式 DTO、返回只读投影（design/02 §1–§2）。逻辑调用身份不能由参数 hash 或每次变化的 attempt_no 代替；稳定身份与结果账为后续 #45 合同，本次不实现。

## 执行控制与持久化

- [Observed] TS conversations 的 runTurn/executeRun 是确定性分诊/单工具路径，无真实模型；它保存消息、Run 和流事件。propose_task 产批准后结束，不是已实现的同 Run 模型等待恢复。
- [Required] 仓颉唯一拥有模型/工具循环、本次上下文、计划、预算和等待/继续/恢复/停止决策。TS 长期保留 ToolGateway/能力模块、身份/批准/时间/任务/worker、API/Web 与持久存储，不保留第二套 TS Agent。
- [Required] TS 持久化快照、批准、取消与已接受结果，并裁决执行资格；仓颉通过接口读取，不另建事实库。最终 DTO/传输与 run/attempt 枚举以 design/api/schema 和后续跨语言合同为准，不发布另一份状态机。
- [Required] TS 工具执行边界拒绝越权/过期/取消后新动作；仓颉观察取消后不再安排。用户拒绝后不得换路完成同一未授权效果。

## 预算

- [Observed] v0 TS max_iterations=10、max_tokens=8000，token 使用字符估算，不是 provider 实际 usage。
- [Required · R1 目标] 仓颉累计迭代、模型/tool usage 与时间并强制停止；TS 校验/保存配置与工具执行资格，不复制模型循环，不信模型自报预算。
- [Required] 超限保留已产出并报告 BUDGET_EXCEEDED；未知费用诚实标未知，不能默默截断当成功。等待期间不发生模型/工具调用；唤醒接续同一 Run 的已用预算。
- [Proposed] 具体 token/iteration/超时起步值随真实 provider 与负载校准，不把旧实验数字当已验收 SLA。

## 事件补读与执行恢复

- [Observed · v0] run_checkpoints 保存 thread 事件，幂等 POST/GET after_seq 重放已存帧；不会再次调用工具。SSE 断线不是执行恢复或再次写入的授权。
- [Required · R1 目标] 仓颉提供可继续的当前上下文/等待点，TS 保存已接受结果与批准；同 Run 唤醒。此目标不能由现存事件行推导为已实现。
- [Proposed · 后续无人值守] 重启需核对调用、授权、取消与并发执行资格。checkpoint 保存进度，lease/fencing 拦过期执行者，不保证任意外部效果 exactly-once。
- [Required] 已接受成功结果不重调；明确未执行按工具合同重试；可能已执行但结果丢失先查状态或停在未知，不盲重放。现有 tool_calls 参数 hash 去重不是通用执行去重。
- [Observed] 任务通知一次许可/独立回执的专属恢复与真实证据见 design/08；不把它泛化为仓颉或任意文件/MCP 恢复保证。

## 真源

[design/09](../design/09-agent-runtime-and-checkpoint.md) 定义执行责任及恢复级别，[design/11](../design/11-cangjie-runtime-spike.md) 定义仓颉/TS 链路；本篇不另立远程路由、字段或枚举。
