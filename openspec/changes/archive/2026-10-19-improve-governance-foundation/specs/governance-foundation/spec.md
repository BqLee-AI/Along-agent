## ADDED Requirements

### Requirement: 人机入口分离

系统 SHALL 以 `CONTRIBUTING.md` 为人类贡献唯一入口（环境/分支/提交/PR/测试/AI/review），以 `AGENTS.md` 为机器约束与索引；两者流程描述不重复不冲突。引用 `docs/design/13-p0-bootstrap-and-ci-rules.md §3`（D1–D10 门槛）与 `docs/README.md`（文档分层）。

#### Scenario: 新人只读一份入口

- **WHEN** 新贡献者要提交第一个 PR
- **THEN** 只读 `CONTRIBUTING.md` 即可完成环境搭建、分支命名、提交、PR 全流程，无需再读 AGENTS 流程章节

#### Scenario: 机器只认 AGENTS 索引

- **WHEN** agent 要改仓库代码
- **THEN** `AGENTS.md` 给出模块表、禁区、验证命令与索引链接，无流程细节复述

### Requirement: 冻结决策可追溯

系统 SHALL 以 `docs/adr/` 记录已冻结决策的 why（编号单调、Accepted 不可改、只能 supersede），字段/路由细节仍指向 `docs/design/`。引用 `docs/README.md`（文档分层）。

#### Scenario: 冻结决策有唯一编号

- **WHEN** 追问"为什么用 pnpm+Turbo / PG+outbox / S0 冻结"
- **THEN** 各有一份 Accepted ADR（含 Context/Decision/Consequences/References），无两处互相否定的描述

#### Scenario: ADR 只写 why

- **WHEN** 读任一份 ADR
- **THEN** 不含表字段/路由表复制，细节指向 design 章节

### Requirement: 根文档真实

系统 SHALL 使 `AGENTS.md` / `README.md` / `docs/README.md` 描述当前仓库真实状态（有 apps/packages、可跑命令），无过期表述。引用 `docs/README.md`（文档分层）。

#### Scenario: 命令可直接跑

- **WHEN** 按 `AGENTS.md` 常用命令执行 `pnpm install` / `pnpm typecheck` / `pnpm test`
- **THEN** 在当前仓库可直接跑通（或给出真实前置条件），无占位命令

#### Scenario: 布局描述真实

- **WHEN** 按 `README.md` 仓库布局找到 apps/api、apps/web、packages/
- **THEN** 目录真实存在且与描述一致，无"目录随 #2 建出"类过期表述

### Requirement: 提交规则唯一

系统 SHALL 在 `CONTRIBUTING.md`、`AGENTS.md`、`README.md` 三处给出唯一的提交/PR 标题语言与格式规则，三处一致。引用 `docs/design/13-p0-bootstrap-and-ci-rules.md §3`（提交门槛上下文）。

#### Scenario: 规则不打架

- **WHEN** 对照 `AGENTS.md` 与 `README.md` 的提交规范
- **THEN** 语言与格式要求完全一致，squash 后 PR 标题与提交信息无冲突

#### Scenario: 人入口规则一致

- **WHEN** 对照 `CONTRIBUTING.md` 与 `AGENTS.md` 的提交规范
- **THEN** 语言与格式要求完全一致，新人按任一份执行结果相同

### Requirement: 权威冲突可裁决

系统 SHALL 在 `openspec/config.yaml`、`openspec/README.md`、`docs/README.md` 三处写明冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准；并将 `openspec/README.md` 现有的"冲突时 design 优先"迁移为矩阵中的字段级规则。引用 `docs/README.md`（文档分层）。

#### Scenario: 冲突有唯一路径

- **WHEN** spec 与 design 对同一行为描述不一致
- **THEN** 按冲突矩阵唯一裁决，无需再开决策会

#### Scenario: 旧口径已迁移

- **WHEN** 读 `openspec/README.md`
- **THEN** 无孤立的"冲突时 design 优先"，统一指向冲突矩阵的字段级规则
