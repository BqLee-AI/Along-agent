Issue: #29

# v0 崩溃恢复与不确定调用边界

## Why

worker 在调用 provider 后才提交通知、fired 与发送结果；崩溃可回滚这些结果，却保留先前已提交的 dispatched send。默认本地 provider 没有独立接收事实，无法证明恢复不会再次调用。通知唯一约束不是实际调用次数证明。

用户明确选择安全优先：可能已调用时禁止盲重发，允许未知或超窗未完成；仅对具有独立接收事实的项保证只核对后恢复完成。不再承诺任意崩溃空隙均调用一次且必然完成。取消提交后实际调用零的保证不变。

## What Changes

- 在调用前持久化一次性许可，未知项不得重新进入发送；许可与 owner、task、冻结时刻、版本、发送键绑定。
- 本地 inapp 提供独立于 worker 结果事务的持久接收事实，恢复通过 notifications 公开 service 核对。
- 修订 kill/resume 场景，分别验收确定未调用、已接收、许可后无接收事实；实际调用、接收、通知、fired 分开计数。
- 保留取消行锁、回执门、15min 宽限、旧版本隔离；真实 SIGKILL 和回答丢失演练，不注入业务状态。

## Spec 路径与章节

- 设计真源：`docs/design/08-scheduler-and-delivery.md` §2、§4、§7–§9。
- 跟随：`docs/prd/04-acceptance-open-questions.md` A3；`docs/schema/commitments-schema.md`。
- 行为增量：`specs/v0-safety-contract/spec.md`，修改 Requirement 5 并新增崩溃接收/许可要求。

## 非目标 / Deferred

不解冻外部推送、LLM、计费或 Redis，不构建通用 provider 平台，不新增 task 状态或事件词，不重开 #26，不优化 CI。回执不证明设备送达或用户已读。本契约 PR 仅 `Refs #29`；实现、真实验收、证据及 archive 完成才 `Closes #29`。
