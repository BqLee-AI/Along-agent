# ADR 0004：spec 与 design 的权威关系（冲突矩阵入口）

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: P0 治理（issue #1）
- **Supersedes / Superseded by**: 无

## Context

两类真源并存：`docs/design/` 是设计真源（为什么/怎么设计、表字段、状态机、错误码），`openspec/specs/` 是可验收行为契约真源（SHALL + Scenario）。旧口径“冲突时 design 优先”一句话会在行为层压倒可验收契约，导致 spec 的 Scenario 无法作为合并依据；反过来若 spec 复制字段，又会与 design 双写漂移。

## Decision

按冲突矩阵裁决（矩阵正文三处一致：`openspec/config.yaml`、`openspec/README.md`、`docs/README.md`）：行为/验收以 spec 为准；字段/路由/状态机/错误码以 `docs/design` + `docs/api` + `docs/schema` 为准；why 以 ADR 为准。Deferred 项永不进 spec。变更路径：先改 design → 同步 prd → 再改 OpenSpec；spec 只引用 design 章节号，不复制内容。否决备选：单一真源（spec 复制字段必漂移；design 写 SHALL 不可验收）。

## Consequences

- 好：spec/design 不一致时有唯一裁决路径，无需再开决策会；design 可演进字段而不动契约措辞。
- 代价：改 design 的 PR 必须同步 prd 与索引（AGENTS 文档索引已有该约定）；三处矩阵措辞须保持逐字一致。
- 守护：`openspec validate --strict` 对 spec 格式；design 侧由评审保证“引用章节号、不复制内容”。

## References

- `docs/README.md`（文档分层与冲突矩阵）
- `openspec/config.yaml`（context 真源关系与 rules）
- `docs/design/13-p0-bootstrap-and-ci-rules.md §3`（D1–D10 门槛语境）
