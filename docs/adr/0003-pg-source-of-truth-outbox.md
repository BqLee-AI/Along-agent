# ADR 0003：PostgreSQL 唯一事实源 + outbox 最终一致

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: P0 治理（issue #1）
- **Supersedes / Superseded by**: 无

## Context

业务状态必须有单点真值：确认门要求“验 owner/pending/有效期 → 比 hash → 建 task → 记账 → 写 outbox → consumed”全回滚的单事务载体；跨模块副作用需要事务外投递载体；AF 三硬约束之一即 PG 约束为准。同时 Redis 明确延后（v0 不引入），不允许出现第二个可写状态源。

## Decision

PostgreSQL 16+ 为唯一事实源：业务状态一律以 PG 约束为准（`UNIQUE`/append-only 禁 UPDATE/DELETE 落迁移）。跨模块副作用一律经 `outbox` 领域事件（事务内写、worker claim 投递、投递幂等）；唯一允许的跨模块事务是 Approval 消费 + Task 创建同事务，其余最终一致。表名冻结为 `outbox`，旧名 `outbox_events` 作废（S0 #14）。否决备选：Redis 存业务状态（丢 DB 约束）、Kafka 等外部总线（P0 过重）、按模块分库（引入分布式事务）。

## Consequences

- 好：单事务语义简单可测；outbox 让模块拆分（design/02 判据 a–d）时只需把“进程内投递”换成 HTTP，不改写侧。
- 代价：读侧投影承担跨模块读复杂度（必须标 `[跨模块读]` 经 contracts zod 类型）；worker 投递延迟计入最终一致窗口。
- 守护：D3–D6（`UNIQUE(task_id,fire_at)`、`recreated_from` 唯一、只追加、revision 另起行）migration-scan + 运行时测试双重门禁。

## References

- `docs/design/01-tech-stack-and-repo-structure.md §1.1`（唯一事实源 Required）
- `docs/design/02-modular-monolith-and-split-triggers.md §1`–`§2`（模块/outbox 约定）
- `docs/design/08-scheduler-and-delivery.md`（worker 投递）
- `docs/design/13-p0-bootstrap-and-ci-rules.md §3` D3–D6
