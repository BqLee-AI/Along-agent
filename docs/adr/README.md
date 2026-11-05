# ADR（架构决策记录）

> 位置：`docs/adr/`。记录已冻结决策的 **why**；字段 / 路由 / 状态机细节仍在 `docs/design/`，可验收行为在 `openspec/specs/`。本目录不碰业务代码、路由、schema 与 D1–D10 语义。

## 机制

- **编号**：零填充四位、单调递增（`0001`、`0002`、…）；`0000` 为模板保留号。编号只增不减：不复用、不跳号、不改号，错了另起新号。
- **不可改**：状态 `Accepted` 的 ADR 正文冻结，只能被 supersede——新 ADR 头部写 `Supersedes: 旧号`，旧 ADR 头部追加 `Superseded by: 新号`并保留原文。
- **生命周期**：`Proposed` → `Accepted`（→ 被 supersede 后标 `Superseded`）。只有 `Accepted` 才可作为开工依据。
- **一页原则**：每份一页以内，只写 why，不复制表字段 / 路由表，细节一律链到 design 章节。
- **模板**：`0000-template.md`，正文四节 `Context / Decision / Consequences / References`，头部含 `Status / Date / Deciders / Supersedes`。
- **权威**：why 以 ADR 为准。冲突矩阵见 `docs/README.md`、`openspec/config.yaml`、`openspec/README.md` 三处（行为/验收以 spec 为准，字段/路由以 design 系为准）。

## 清单

| 编号                                            | 标题                               | 状态                         | 依据                                                                                |
| ----------------------------------------------- | ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| 0000                                            | 模板（不决策）                     | —                            | 本 README                                                                           |
| 0001                                            | 为什么用 ADR                       | Accepted                     | 本 README                                                                           |
| [0002](0002-pnpm-turbo.md)                      | 包管理与构建：pnpm + Turbo（历史） | Superseded                   | 被 [0006](0006-bun-ox-toolchain.md) 取代，正文保留                                  |
| [0003](0003-pg-source-of-truth-outbox.md)       | 唯一事实源 PG + outbox             | Accepted（局部由 0009 修订） | PG/可靠异步投递保留；所有调用/outbox 与仅创建事务的绝对范围以 0009 为准，旧正文冻结 |
| 0004                                            | spec / design 权威关系             | Accepted                     | docs/README.md；openspec/config.yaml；design/13                                     |
| 0005                                            | S0 冻结                            | Accepted                     | AGENTS.md S0 条款；design/07、10、06、03；design/13 D10                             |
| [0006](0006-bun-ox-toolchain.md)                | Bun + Ox 工具链                    | Accepted                     | design/01 §1、§5；design/13 §3–§4；#13                                              |
| [0007](0007-ci-critical-path.md)                | CI 关键路径局部修订                | 历史编排                     | Bun/Ox 选型及构建复用保留；当前 CI 调度见 design/13 §4；#21                         |
| [0008](0008-static-scheduling.md)               | static 内部调度                    | Accepted（编排已修订）       | 内部并发边界和构建拓扑保留；当前 CI 分类见 design/13 §4；#24                        |
| [0009](0009-cangjie-harness-ts-capabilities.md) | 仓颉唯一 Harness / TS 长期能力     | Accepted                     | 局部修订 0003 的调用/事务范围；design/02/04/09/11；不改业务、安全 spec 或 CI        |
