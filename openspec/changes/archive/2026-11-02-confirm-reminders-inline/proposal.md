Issue: #91

## Why

当前 Harness 提醒提议需要打开独立批准页，再返回原 Run 继续。用户应能在当前等待点完整审阅冻结提醒后，以一次明确按钮依次确认并继续原运行，同时保留逐条授权、真实回执、原等待点和只读历史边界。这不是 #90 的免逐条确认，也不依赖 #88 的 R2-B 路由。

## What Changes

- 当前选中 Harness 提醒等待点完整展示原话、冻结正文、日期及其时区、有效期和通知边界，提供明确创建/取消并继续按钮；独立批准页仍可新标签打开。
- 同一次有效点击绑定原 conversation、Run、批准和 checkpoint，核验 consumed 与真实任务引用后才沿既有恢复 API 继续；后继和文档需各自授权。
- 确认与恢复使用各自稳定键，双击互斥，未知确认回执先 GET；已确认后的恢复失败只核对并重试原恢复，不重新确认或创建消息、Run、任务。
- 浏览、历史、刷新、回退、重登和网络恢复只读；真实任务结果与调度状态、运行终态分别呈现，不虚构 business 的可恢复等待点。

## Spec

设计依据：[design/09](../../../../docs/design/09-agent-runtime-and-checkpoint.md) §6、[design/17](../../../../docs/design/17-r1-conversation-history.md) §5–§8。行为基线：[conversations](../../../specs/conversations/spec.md) 的“精确批准与显式继续原运行”、[agent-runtime](../../../specs/agent-runtime/spec.md) 的“批准等待与同一 Run 显式恢复”；增量见本 change 的 [conversations spec](specs/conversations/spec.md)。

行为合同先经独立 OpenSpec-only PR，再由独立实施 PR 交付。规范批准、实施合并与完整验收归档分别取证，不以其中一项替代其他项；分版本结果见[验收记录](../../../../docs/inline-reminder-verification-2026-11-02.md)。

## Impact

仅影响现有 Web 对话提醒展示、确认/恢复编排、对应行为测试及跟随文档/工具描述。复用既有批准事务、CSRF、Run 查询、resume、幂等和真实结果合同，不新增公开 API、DTO、表、SSE 词或执行状态机。实际 UI 验收在全隔离测试安装进行，不操作原安装及真实用户任务。

## 非目标 / Deferred

不实施免批准、自动批准、后台继续、文档就地批准、任意 checkpoint 恢复、自动跟随后继或通用崩溃恢复；不扩展 business 提醒快捷入口，该路径保留既有独立批准页。不改 R2-B 路由默认 off、编码器、时间解析、用户配置/凭据/资料或已合并迁移；不以本 change 收口 #88 或 #90。
