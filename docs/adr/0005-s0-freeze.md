# ADR 0005：S0 冻结（P0 开工前冻结面）

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: P0 治理（issue #1）
- **Supersedes / Superseded by**: 无

## Context

P0 开工前有五处最易漂移：错误码口径、事件词汇、表名、确认方式、简报形态。若不冻结，实现会按直觉各写一套，事后对账成本远超冻结成本；其余未决 Deferred 项（LLM/推送/计费、是否练仓颉）不能被实现“默认选中”。注：鉴权方案已定（Better Auth 自建 credential，见 `docs/design/01 §1.1`），不在未决之列。

## Decision

冻结以下五项（S0 #14），解冻只能 supersede 新 ADR + design 变更同步 prd：① 错误码用 design 系（`PRESENTATION_MISMATCH` 409、时间四错 422、`BUDGET` 429）；② 事件词用 design/07 封闭集；③ 表名统一 `outbox`；④ v0 只认按钮确认；⑤ 简报只读投影、不建表。冻结别名永不复用：`outbox_events`、`schedule_confirmed`、`SERVICE_NOT_READY`、`C-XXXX`、整句文本确认。否决备选：不冻结（P0 反复返工）；连 Deferred 一起冻（过度，堵死 P0/P1 决策）。

## Consequences

- 好：P0 实现层无口径二选一；别名残留被“不要碰”红线挡在入库之外。
- 代价：冻结项的任何改动都走 supersede + design 同步的重流程；D10 口径扫描门禁锚定文案白名单。
- 守护：D10 文案扫描（禁“一定响/必达/已读”类承诺）；D8 契约双跑锁定事件词汇；D7 空环境冒烟锁定错误码行为。

## References

- `AGENTS.md`（S0 冻结条款与“不要碰”红线）
- `docs/design/07-task-events-ledger.md`（事件封闭集）、`design/10`（错误码）、`design/06`（确认门）、`design/03`（简报）
- `docs/design/13-p0-bootstrap-and-ci-rules.md §3` D7/D8/D10
