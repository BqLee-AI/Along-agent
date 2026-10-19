# ADR 0002：包管理与构建用 pnpm + Turbo

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: P0 治理（issue #1）
- **Supersedes / Superseded by**: 无

## Context

TS monorepo（`apps/api`、`apps/web`、`packages/*`）需要：单一锁文件保证全仓依赖一致；workspace 协议支撑模块所有权边界；任务流水线编排 CI 六环（lint → depcruise → unit → migration-scan → contracts-dual → compose-smoke）并可缓存。注：`docs/design/01 §1.1` 仍将本项标为 Proposed，该标注滞后，下次 design 修订时转 Required，以本 ADR 为准（why 以 ADR 为准）。

## Decision

包管理用 pnpm（workspace + 单锁文件 + strict 抑幽灵依赖），构建编排用 Turbo（任务依赖图 + 本地缓存，远期可开 remote cache）。否决备选：npm workspaces（单锁与隔离性弱）、Yarn（与现有占位命令及 P0 清单惯性不合）、Nx（P0 体量过重，Turbo 已覆盖流水线需求）。

## Consequences

- 好：`pnpm install` 单锁可复现；Turbo 缓存加速 CI 六环；与 AGENTS 常用命令及 design/13 P0 开工清单一致。
- 代价：贡献者须装 pnpm；锁文件冲突时以 rebase 优先、禁止双锁并存。
- 守护：design/13 §4 CI 布局跑在 Turbo 任务图上；`packages/time-core` 零依赖等边界由 depcruise 断言（D1）。

## References

- `docs/design/01-tech-stack-and-repo-structure.md §1`（选型总表）、`§5`（端口与环境）
- `docs/design/13-p0-bootstrap-and-ci-rules.md §1 #4`（monorepo 开工项）、`§4`（CI 布局）
