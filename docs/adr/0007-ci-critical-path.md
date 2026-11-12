# ADR 0007：CI 关键路径局部修订

- **Status**: Accepted
- **Date**: 2026-10-20
- **Deciders**: issue #21（已接受的 optimize-ci-critical-path 契约，PR #22）
- **Supersedes**: [0006](0006-bun-ox-toolchain.md) 的 CI 编排与失败传播部分；不取代 Bun/Ox 工具选型，0006 其他决策继续有效
- **Superseded by**: [0008](0008-static-scheduling.md) 修订 static 内部类型检查和只读边界 fixture 的并发；CI job 编排现以 [design/13 §4](../design/13-p0-bootstrap-and-ci-rules.md#4-ci-布局required) 为准，构建复用继续有效

## Context

五个合并门分别验证静态与单元、真实数据库约束、调度故障、契约双跑和空环境容器行为。三个 DB/契约 job 与 Compose 没有产物或用户数据依赖，让 Compose 等待三者会把独立验证串入通过路径。同次 verify 中，成功 typecheck 已经构建共享包，单元步骤重复构建不增加独立性。

## Decision

保留 static 为共同前置；migration-scan、scheduler-fault、contracts-dual、compose-smoke 都只依赖 static，各自隔离并行。static 失败仍阻止全部下游，五个 required checks 必须全部成功才允许合并；人工保护约定不变。

仅同次 verify 的单元步骤复用成功 typecheck 构建的共享 packages，失败构建不消费。独立单元入口与跳过 typecheck 的 verify 仍真实构建，不依赖旧 dist、跨次运行标记或跨 job 产物。Compose 宿主不安装没有宿主消费者的依赖，镜像内仍真实执行 fresh frozen install、依赖优先构建与 Bun 运行，不引入缓存，不改变 typecheck 或用例并发。

## Consequences

- 收益：消除独立 job 的串行等待及同次 verify 的重复包构建，保留各入口自足性。
- 权衡：三个 DB/契约 job 失败时，Compose 可能已经消耗构建与冒烟资源；这不使失败可合并，也不共享可变数据库或用户数据。
- 守护：真实 PostgreSQL 16、原迁移、SQL/并发/故障断言、契约双跑、格式阻塞及缺/有 TZDB_VERSION 的两轮全新卷 D7 均不变；不改 D1–D10 语义，不更换 Bun/Ox 工具。

## References

- [ADR 0006](0006-bun-ox-toolchain.md)（仍有效的 Bun/Ox 工具选型）
- `docs/design/13-p0-bootstrap-and-ci-rules.md §3–§4`
- issue #21、PR #22（optimize-ci-critical-path 行为契约）
