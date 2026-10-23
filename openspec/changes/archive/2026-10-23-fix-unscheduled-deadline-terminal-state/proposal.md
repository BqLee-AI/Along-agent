Issue: #42

# 未排期提醒过窗终结

## Why

确认已保存任务，但首次调度已经超过触发时间 15min 时，只终结 schedule outbox 会留下活跃任务。历史已排期恢复证据不覆盖此路径。

## What Changes

- 未排期的 saved/pending_schedule 任务超窗后进入 missed；在任务锁与同一事务内提交状态版本、唯一 missed 事件及队列终结。
- 恢复扫描覆盖旧 worker 已将 schedule 命令终结、但任务仍活跃的情况，不要求重开旧命令或补造回执。
- 取消先提交则保留取消路径；已排期任务的真实接收核对、未知不重发和冻结时间合同不变。

## Spec 路径与章节

- `docs/design/08-scheduler-and-delivery.md` §4–§5、§8。
- `openspec/specs/v0-safety-contract/spec.md` Requirement 2、Requirement 5。

## 非目标 / Deferred

不超窗补发、不新增状态或事件词、不改已合并迁移、不重开历史 v0 验收。不实现 LLM、仓颉、MCP、周期提醒或外部推送。本 PR 仅 Refs #42；实现、PG16 失败回归、worker 验证与 archive 后才结案。
