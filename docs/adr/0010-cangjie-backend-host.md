# ADR 0010：仓颉生产服务宿主

- Status: Accepted
- Date: 2026-11-26
- Deciders: #189、#190
- Supersedes: ADR 0009 中生产 API、Run 宿主编排和 Worker 的语言归属，按迁移切片生效

## Context

仓颉 Harness 持有模型和工具循环，TS 进程持有服务入口、Run 的接纳与继续编排及 Worker 调度。生产宿主迁移将这些运行职责交给仓颉，使请求、执行和后台生命周期由仓颉统一推进。

## Decision

仓颉直接监听 HTTP/SSE、编排 Run 并驱动 Worker。TS 通过操作级能力接口提供资格审核、模型与外部传输、领域规则及数据库原子事务。PostgreSQL 裁决执行权、批准、取消、调用账与回执。Web 保留现有接口语义和类型约束。

## Consequences

切片按真实入口和退出条件验收。服务交接保留历史快照消费、唯一写入资格和回执约束。生产切换前通过新旧版本交接和回滚演练。原有 Harness 协议退役由 #176 独立推进。

## References

- [迁移矩阵](../plans/cangjie-backend-migration.md)
- [迁移设计](../../openspec/changes/migrate-cangjie-backend-host/design.md)
- design/08 §2–9、design/09 §1–8、design/10 §1–6、design/15 §5–7
