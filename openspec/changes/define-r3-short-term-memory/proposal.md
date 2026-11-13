Issue: #144

## Why

当前没有通用暂停/继续，也没有对话摘要；最近 63 条消息的固定窗口和引用上限不能提供长对话连续性。阶段 0 的真实 transport 摘要重试出现指代偏移，PG16/pgvector 小样本表明检索可行但无阈值 top-k 会返回无关结果，不能把模型摘要或相似度当事实证明。

## What Changes / 范围（Proposed）

- 定义独立于批准等待的同 Run 安全点暂停/继续，作为进行中手动 `/compact` 和自动 compact 的必要前置；保留取消、真实工具效果、预算和当前权限裁决。
- 手动与自动 compact 共用隔离的摘要流程，记录有来源的覆盖边界及失败，保留原文、冻结运行事实和真实 usage；提交与取消和新消息竞争时不得误覆盖。
- 对采用新合同的新 Run 去除固定 63 条及相关消息引用限制，但保留序列化、窗口、输出、迭代和预算容量门；旧 Run 与批准恢复继续使用原冻结事实。
- 记忆仅由明确记住或 compact 提取，跨会话必须 owner 隔离；原文是权威，字面和 pgvector 是可重建派生索引，精确编号优先，并定义无答案和降级行为。

## Spec 路径与设计

唯一详细 Proposed 设计：[design/23](../../../docs/design/23-r3-short-term-memory-and-compact.md)；阶段 0 事实：[实验记录](../../../docs/verification/r3-stage-zero-2026-11-13.md)。本 change 不修改已生效 specs，不表示已实现或验收。

- [agent-runtime delta](specs/agent-runtime/spec.md)：暂停安全点、取消/恢复和预算、摘要。
- [conversations delta](specs/conversations/spec.md)：新旧 Run 边界、compact 与原文。
- [short-term-memory delta](specs/short-term-memory/spec.md)：记忆来源、隔离与检索。

## 非目标 / Deferred

不实施代码、迁移或部署，不归档；不扩展到任意崩溃恢复或 R4。top-k、相关性阈值、TTL、历史回填、自动触发数值均待实验及实施决策，不以固定默认值或小样本结果充当质量保证。阶段 0 一次协议错误的原因未知；网络波动只是可能性，不是结论；重试成功也不是完整 Web/native/Run 验收。
