Issue: #31

# close-v0-approval-revision：显式修改待确认提议

## Spec

- `docs/design/06-approvals-confirmation-gate.md` §9：A2显式目标、时间边界、持久幂等、原子替代、竞争、发布与验收（全部新增内容为 Proposal）。
- 字段/路由：`docs/api/approvals/approvals_routes.md` §6；持久化：`docs/schema/commitments-schema.md`“审批修改持久化增量”。
- 行为 delta：`specs/v0-safety-contract/spec.md`，只新增 A2 requirements；主 spec 不在本契约 PR 改写，archive 时才合入。

## Why

现有创建入口只生成独立 pending，详情只有确认/拒绝；虽能拒绝 superseded，尚无用户可达的生产替代写入。预置 superseded 测试不能证明完整 A2。现有确认/拒绝也缺少等待行锁期间到期的锁后复查，修改不能复制这一缺口。

## What Changes [Proposal]

- 由 approvals 独占显式 revise action，完整重述本人有效 pending create_task，创建新快照/回显并原子 supersede 旧项；不建 task，必须重新按钮确认，不覆盖同会话其他新提醒。
- 首次持久接收冻结相对时间 anchor；approvals 自有最小预约/结果映射支持同键重放、异body/跨目标冲突、响应丢失与重启，不借 outbox 或 conversation 表。
- 新迁移仅增加唯一后继约束与映射表；脏链停止发布，不删业务行。修改与确认/拒绝共用 owner 后、行锁后实时时限和既有错误。
- 依赖 #30/A4 公共规则上下文/时间入口，不复制 fixture/alias/解析；Web 从详情明确修改目标，稳定重试键，跳新详情重回显再确认。

## Delivery

本 PR 仅合同、`Refs #31`；独立 review + 固定五门 SUCCESS + CLEAN 合入后才实施。后续迁移/API/Web/测试、真实 A2 验收、代码与证据独立 review 完成后 archive；仅收口 PR `Closes #31`。保留 D1–D10、Bun 1.4.2、OpenSpec 1.3.1、static / migration-scan / scheduler-fault / contracts-dual / compose-smoke。

## 非目标/Deferred

不实施源码/测试/SQL/依赖/CI；不改已合并迁移，不重开 #26、brief、通知投影或生产取消。不支持 consumed task 直接改期、cancel_task 修改、会话自动替代、文本确认、批量/重复提醒。A3恢复及A4规则本体由各自change拥有；鉴权UI、LLM供应商、市场、外部推送、计费、全IANA库、通用幂等平台与后台清理均不在本change。
