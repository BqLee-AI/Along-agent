# 11. 仓颉宿主 Harness 与 TS 能力层

## 文档状态

- **状态**：规范基线对齐（#44；design 为真源，prd 跟随）
- **范围**：唯一 Harness 的语言/状态责任、Web→TS→仓颉→TS 工具链及验证边界
- **不包含**：R1 实现、最终跨语言 API/schema、工具链或供应商选型、全 TS 后端迁移
- **阶段标签**：v0 TS 业务资产保留；R1 目标未实现；旧 P 阶段与 S1–S3 不作完成证据

## 1. 位置与分工（Required）

仓颉从第一条真实 Agent 闭环起就是唯一宿主 Harness，不是 TS 通用 Agent 的候选第二实现。TS 后端是长期能力/业务层，不退役 API/worker，也不在工具内部隐藏另一套完整 Agent。决策原因见 [ADR 0009](../adr/0009-cangjie-harness-ts-capabilities.md)。

| 责任                                                                              | 唯一所有者                             |
| --------------------------------------------------------------------------------- | -------------------------------------- |
| 模型消息/function calling 循环、本次上下文、工具结果纳入、简短计划、行动选择      | 仓颉 Harness                           |
| 运行预算、等待/继续/恢复决策、停止后不再安排步骤                                  | 仓颉 Harness                           |
| ToolGateway、工具定义/实现、schema/权限/批准校验、执行记录                        | TS                                     |
| 长期 memory 的保存/检索/grep/修订/删除；MCP/办公连接器；PC/browser/文件执行       | TS 能力模块；不是仓颉生态重建          |
| auth/身份/凭据、批准/业务事务、time-core、tasks、scheduler/notifier/outbox/worker | 现有 TS 产品后端                       |
| PostgreSQL、消息/Run/checkpoint/结果/事件持久化、读取与 SSE 投影、Web             | TS；仓颉通过服务契约读写快照，不直连库 |

当前上下文不等于长期 memory；仓颉控制“接下来尝试什么”，TS 裁决“动作是否允许、已发生什么”。TS 不独立推进模型循环，仓颉不另存可独立裁决的事实库。

## 2. 一次请求的责任链

[Required · 目标；不是现有远程接口字段]

```text
Web → TS API（身份/输入/逻辑 Run 与可信执行资格）
    → 仓颉 Harness（模型、上下文、计划、预算）
    → TS ToolGateway（重验 schema/权限/批准/执行资格）
    → TS tools / memory / grep / MCP / PC/browser / 办公
    → 结构化结果、产物引用、回执、待批准或未知
    → 仓颉继续 / 等待 / 结束
TS 存储 Run/快照/已接受结果/事件 → SSE/补读 → Web
```

TS 从可信绑定恢复 owner、工具范围和取消状态，不信任仓颉或模型自报授权；现有同进程 ToolContext 不可原样成为远程请求。参数校验由真正执行者 TS 重验，不复制时间/批准业务规则到仓颉。

批准后恢复同一逻辑 Run，不重复动作。取消在 TS 提交并由工具边界拦新动作，仓颉观察后停止安排；不能承诺撤销既成外部效果。具体调用身份、结果账、跨语言合同分别由后续 #45/#46/#47 定义和实现，本次不预写最终字段/路由。

## 3. 现状与验证边界（Observed）

基线 `a10344c`：`conversations/service.ts#runTurn/executeRun` 是确定性 v0 turn，无真实 LLM provider；消息幂等、事件先存后发和 GET 补读在 TS。`tasks/scheduler/send.ts` 的一次许可/独立回执核对是专属发送恢复，不证明通用 Agent 恢复。当前 contracts-dual/D8 仅最小 healthz 双跑/partial，不证明仓颉 run/resume/cancel 已实现。

旧版本的“第二实现 / v0–P3 不用 / P2 末 S1–S3 竞赛转正”不再是有效目标。旧研究数字、历史 ADR 与验收记录只证明其当时范围，不重写为 R1 通过，也不因 R1 未实施把 v0 重新判失败。

## 4. 实施验收边界（Required；未执行）

- 真实 Web→TS→仓颉→TS 工具→实际产物/回读证明闭环，工具选择随输入/观察变化；固定回放和 mock 不能代替真实模型和产物。
- 仓颉预算/上下文/等待/停止，与 TS 权限/批准/执行资格分别验证；不得用 TS 隐藏循环或孤立仓颉 CLI 代替集成。
- 事件补读不执行工具。已接受结果不重执行；可能已执行但未存结果先查询或停在未知，不盲重放。checkpoint/lease/fencing 不单独保证 external exactly-once（09 §6）。
- R1 有限等待上下文与后续无人值守任意崩溃恢复分开验收；只有实际覆盖的工具/故障窗口才能声明保证。
- 复用既有五个 required checks；后续真实跨语言消费者合同进入既有 contracts-dual，不在本次新增 CI 门或提前提升 D8 状态。性能/内存目标需真实负载校准，不沿用旧实验数字为主 Harness 转正门。

## 5. 红线（Required）

1. 仓颉不直连 PostgreSQL 业务库，Run/checkpoint 存储继续 TS 所有。
2. 时间归一只在 TS/time-core；需排期经 TS propose_task 与冻结按钮确认，不自行计算 UTC。
3. 外部 MCP、PC/browser、memory/grep 与办公执行经 TS 网关；工具不得内藏完整 Agent。
4. Harness 内网接入仍须可信 Run 授权绑定；内网不是免鉴权许可。
5. 只追加事件、冻结展示、确认创建/取消单事务、取消优先、回执门和未知不盲重发不变。

## 引用

- [09 Harness 与 checkpoint](09-agent-runtime-and-checkpoint.md)、[02 模块边界](02-modular-monolith-and-split-triggers.md)、[04 五缝](04-five-seams-contract.md)、[PRD 待决 D2](../prd/04-acceptance-open-questions.md)。
- B04/B06、AF 仅作机制参考，不把其语言/进程实现复制为项目目标。
