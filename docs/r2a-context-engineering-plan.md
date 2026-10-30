# R2-A 上下文工程：合同入口

> 状态：已收敛到正式设计真源；本文件只作导航，不维护第二套合同。
> 范围：Issue #83 的单 Run 上下文工程。
> 不包含：运行时实现、部署或真实模型验收结论。
> 阶段标签：R2-A；实现与分级验收记录见 OpenSpec tasks。

- [设计真源：18. 单 Run 有界上下文](design/18-r2a-harness-context.md)：额度/计量、策略冻结、确定性投影、来源分页与批准恢复。
- 行为真源：[agent-runtime](../openspec/specs/agent-runtime/spec.md)、[tool-gateway](../openspec/specs/tool-gateway/spec.md)、[workspaces](../openspec/specs/workspaces/spec.md)；[归档提案](../openspec/changes/archive/2026-10-30-manage-harness-context/proposal.md)、[决策与证据边界](../openspec/changes/archive/2026-10-30-manage-harness-context/design.md)、[实现及验收记录](../openspec/changes/archive/2026-10-30-manage-harness-context/tasks.md)。
- [策略存储](schema/conversation-and-runs-schema.md#r2-a-上下文策略83)、[公开接口边界](api/conversations/conversations_routes.md#7-r2-a-上下文容量83)、[产品验收](prd/04-acceptance-open-questions.md#r2-a-单-run-上下文83)。

草案中的候选、源码基线与历史流程陈述由上述真源取代。63＋1 与 streaming 沿用 #70 合同；R2-A 的集成、受控消费者及独立真实模型验收分别记账，不沿用旧版本或离线合成容量实验宣称 token、性能或任务成功。原安装升级依据生命周期指南另行执行。
