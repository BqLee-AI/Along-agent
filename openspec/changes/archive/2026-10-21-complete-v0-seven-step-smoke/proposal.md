Issue: #26

# complete-v0-seven-step-smoke：接通站内通知并以真实七步收口

## Spec

- `docs/design/03-v0-vertical-slice.md` §3.1–§3.2：任务详情通知投影、模块所有权与七步边界。
- `docs/api/tasks/tasks_routes.md` §2.1；`docs/prd/04-acceptance-open-questions.md` 的 #26 七步章节。
- 行为增量复用 `specs/v0-safety-contract/spec.md`；取消沿用主 spec Requirement 5，模块隔离与合并门沿用 `openspec/specs/gates/spec.md`，不另造 capability。

## Why

已有 worker 持久化站内通知，但任务详情/Web 尚未展示通知；取消生产路径只检查内存撤销回执，未形成真实撤销后的持久闭环。现有测试与探针不能替代登录后浏览器、真实到点、provider 调用计数和取消终态的同次证据。旧手册的请求、响应和观察入口也需按现实现纠正。

## What Changes

- 在既有任务详情增加 owner-scoped、无副作用的通知数组与 Web 站内通知面；字段只投影既有通知 schema，不新增通知路由或任务列表字段。
- 依既有取消合同补齐实际本地队列撤销、fencing 核对与持久回执；无回执仍停 `cancel_pending`，不以测试手注或内存 Set 代替。
- 校正手册，在同一受控环境跑真实七步，分别保存通知记录、活动账与取消后 provider 实际调用数的脱敏证据；只报告实际覆盖范围。

## Delivery

先独立契约 PR，经独立 review、既有五门全绿及 CLEAN 后合并；再实现与定向测试、真实七步、审查证据，最后 archive。只有收口 PR 使用 `Closes #26`，契约/实现阶段均 `Refs #26`。

## 非目标/Deferred

不改 D1–D10、五门、按钮确认、冻结展示、取消计时点或回执含义；不改已合并迁移，不重写 brief/SSE/confirm/调度，不优化 CI。不修或宣称完成 A2 完整替代确认、A3 完整 kill/resume、A4 时间错误/规则缺失合同冲突；这些仍是完整 v0 的额外验收边界。鉴权 UI、LLM 供应商、市场、外部推送/设备送达、计费、多端、重复提醒、全 IANA 规则扩展及通用 E2E/遥测框架均不在本 change。
