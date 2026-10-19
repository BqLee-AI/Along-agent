# ADR 0001：用 ADR 记录已冻结决策的 why

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: P0 治理（issue #1）
- **Supersedes / Superseded by**: 无

## Context

冻结决策此前散在 `docs/design/` 正文与 Deferred 描述里：只写了是什么、没写为什么否决备选；口头与会议纪要不可追溯，新人无法判断某条约束是深思熟虑还是随手一写。同时 design 必须保持“怎么写/字段是什么”的真源密度，不适合再塞决策心路。

## Decision

引入 ADR：凡进入冻结（S0 类）或长期约束的决策，立一份一页内 ADR 只写 why，字段/路由/状态机细节仍链 design 章节。`Accepted` 正文冻结，只可 supersede（见 `docs/adr/README.md` 机制）。否决备选：纯 design 行内注释（淹没在细节里）与会议纪要存档（无编号、难引用）。

## Consequences

- 好：每条冻结有唯一编号可引用（PR/issue/争议可直接链 ADR 号）；`Accepted` 不可改带来 P0 开工稳定性。
- 代价：新增冻结必须配 ADR，多一份一页写作成本；存量冻结（0002–0005）一次性回补。
- 守护：`docs/adr/README.md` 清单即索引；无对应 ADR 的“冻结口径”不得作为合并依据。

## References

- `docs/adr/README.md`（编号/不可改/模板机制）
- `docs/README.md`（文档分层与真源关系）
- Issue #1（P0-1 治理底座）
