Issue: #88

## Why

部分自足只读请求可由现成公共用例完整交付，无需聊天模型收尾；但相似度本身不能证明完整目标、可靠参数、权限或真实完成。需要在仓颉唯一 Harness 内定义默认关闭、可拒识且有来源的首步路由，而不是新增 TS Agent 或改写业务入口。

## What Changes / 范围

- Proposed：仅 fresh Harness 首 attempt、首次模型前提供一次 L1 完整命令与 L2 全竞争语义路由；仅接管活动提醒有限列表、本人记录时区、单个明确日期简报卡片，其余完整回原 LLM。
- 定义 off/shadow/enforce、不可变路由策略与 append-only 决议/展示事实；shadow 零旁路工具，旧 Run、重放和批准恢复不分类、不补策略。
- direct 只经原网关执行一个绑定只读工具，由 TS 对真实接受结果确定性展示；区分接纳前拒识与接纳后不可改道，保持取消、回执和来源裁决。
- 内部 v5 同批切换，snapshot2 与外部七事件不扩张；冻结编码/目录/参数/模板版本，逐意图以消费者、目标部署、独立评估和自然 shadow 证据决定启用。

## Spec 路径与设计章节

唯一详细设计：[design/19](../../../docs/design/19-r2b-readonly-intent-routing.md) §1–§14；请求/白名单 §3–§4，模型/打分 §5–§6，协议/账/展示 §7–§10，部署/校准/验收 §11–§14。

- `openspec/specs/agent-runtime/spec.md`：新增首步路由、完整目标、编码、版本与生命周期行为，见 [delta](specs/agent-runtime/spec.md)。
- `openspec/specs/tool-gateway/spec.md`：新增唯一 direct 调用、真实接受结果与确定性展示来源，见 [delta](specs/tool-gateway/spec.md)。
- `openspec/specs/conversations/spec.md`：新增有限结果与只读历史行为，完整修改“常驻输入与连续会话”以区分冻结输入和实际模型请求，见 [delta](specs/conversations/spec.md)。

## 非目标 / Deferred

本轮只编写正式合同，审阅后另行授权实现；不安装/运行模型、不部署、不做自然流量或直接上线、不归档。不得新增 auto、写意图、批准/恢复文本入口、全量查询/分页能力、跨 Run 记忆、聊天分类器、第二 TS 循环或并行能力目录；不改变原业务/LLM、安全基线及市场、provider、推送、计费等 Deferred 决策。离线合成与静态审阅不代表正式 Linux HTTP 服务、真实 Web 或自然流量已验收。
