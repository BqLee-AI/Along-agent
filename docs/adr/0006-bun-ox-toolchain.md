# ADR 0006：Bun + Ox 工具链

- **Status**: Accepted
- **Date**: 2026-10-20
- **Deciders**: issue #13（已接受的 bun-ox-toolchain 契约，PR #18）
- **Supersedes / Superseded by**: Supersedes: [0002](0002-pnpm-turbo.md)

## Context

现有 TS monorepo 需要单一锁文件与依赖优先构建，但工具替换不能削弱既有门禁、测试隔离或真实容器路径。#13 已接受统一 Bun 与 Ox 工具链的行为契约；0002 的工具选择不再适用，其历史理由保留。

## Decision

固定 Bun 1.4.2，使用 workspaces 与单一 bun.lock；根 scripts 显式安排依赖构建，移除 Turbo。以 Oxlint 1.89.0、Oxfmt 0.74.0 和 bun:test 统一 lint、格式与测试入口，宿主机、CI、Docker 均使用 Bun 冻结安装与实际构建/运行路径。

选择统一入口以减少工具链分叉，同时保留 dependency-cruiser 的 D1 边界、D2 原 AST selector 与路径范围、测试断言及五个 required checks 的 DAG。不保留旧工具作为兼容旁路，也不以独立扫描脚本代替 D2 插件。具体命令与执行边界见 design/01 §5、design/13 §3–§4。

## Consequences

- 收益：本地与 CI 共用 verify；镜像不再依赖宿主机产物或旧锁文件。
- 成本：贡献者须使用固定 Bun；显式维护包依赖构建顺序，文件级并行仍须恢复时钟、spy 与 mock，不得改变共享状态语义。
- 守护：格式检查持续阻塞；迁移约束、D9 故障、API 契约双跑与真实 Compose 冒烟维持原失败传播。工具升级或边界改变须重新评审，不借迁移改写 D1–D10 业务语义。

## References

- `docs/design/01-tech-stack-and-repo-structure.md §1、§5`
- `docs/design/13-p0-bootstrap-and-ci-rules.md §3–§4`
- issue #13、PR #18（bun-ox-toolchain 行为契约）
- [ADR 0002](0002-pnpm-turbo.md)（被取代的历史决策）
