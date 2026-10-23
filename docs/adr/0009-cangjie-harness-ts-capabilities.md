# ADR 0009：仓颉唯一 Harness 与 TS 长期能力边界

- **Status**: Accepted
- **Date**: 2026-10-23
- **Deciders**: issue #44（用户确定语言分工；本次仅规范对齐）
- **Supersedes**: [0003](0003-pg-source-of-truth-outbox.md) 中“所有跨模块副作用一律 outbox / 仅创建确认可跨模块事务”的绝对范围；PG 唯一事实源、事务可靠投递和约束继续有效。旧正文冻结保留，当前适用范围在本记录与索引说明；不修改 0005 的安全冻结。

## Context

v0 实际是 TS 确定性 turn、同步 ToolGateway/公共读取、确认创建与取消单事务。旧规范同时要求 TS 主 Agent、仓颉候选第二实现、所有调用走五缝/outbox，并把事件补读与通用执行恢复混为一谈，无法一致指导 R1。D1 实际检测存储实现导入，不能证明 SQL 所有权。

## Decision

仓颉唯一负责模型/工具循环、本次上下文、计划、预算、等待/恢复与停止；TS 长期保留 tools/memory/grep/MCP/PC/browser/办公、身份/批准/时间/任务/worker、API/Web 与 Run/checkpoint 存储。拒绝“全 TS 后端迁移”和“TS 工具内隐藏 Agent”两种替代，不重复建设业务与工具生态。

五缝是重点能力边界，非所有模块唯一通道。允许同步公共用例、显式 DTO/只读投影；批准消费与创建任务或取消请求保持受控单事务；事务后可靠异步命令走 outbox。D1 绿色不替代 SQL owner/锁/事务审查。事件补读不是执行恢复；checkpoint/fencing 不保证通用 external exactly-once，未知效果先核对，不盲重放。

## Consequences

- 保留 PG、只追加、冻结展示、按钮确认、取消优先、回执门与既有五检查，不改有效业务行为、代码或 CI。
- 代价是跨语言授权、逻辑调用身份/结果账及真实消费者验证需后续 #45/#46/#47；本记录不等于它们或 R1 已实现。
- 历史 ADR/研究/验收继续证明原适用范围，不改写为新 Harness 已通过；性能/通用恢复保证必须另有真实证据。

## References

- [design/02 §1–§2](../design/02-modular-monolith-and-split-triggers.md)、[design/04](../design/04-five-seams-contract.md)
- [design/09 §1–§6](../design/09-agent-runtime-and-checkpoint.md)、[design/11](../design/11-cangjie-runtime-spike.md)
- [当前安全行为契约](../../openspec/specs/v0-safety-contract/spec.md)（保持不变）、[issue #44](https://github.com/BqLee-AI/Along-agent/issues/44)
