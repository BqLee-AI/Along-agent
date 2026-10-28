# OpenSpec 行为契约

`openspec/specs/` 是可验收行为契约真源（SHALL + Scenario，对应 D1-D10/A1-A4 变红测试）；
`docs/design/` 是设计真源（为什么/怎么设计、表字段、状态机、错误码）。spec 只写行为并引用 design 章节，不复制字段/路由表；冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准。

## 命名

- `openspec/specs/<capability>/spec.md`：按模块拆，与 `docs/design/02` 所有权表一致（time-core、approvals、tasks-ledger、scheduler-delivery、agent-runtime、tool-gateway、workspaces、conversations、conversations-sse、briefs-cards、notifications、identity、connector-vault），归档时按需生成，不预建空壳。
- `openspec/changes/<动词>-<模块>`：kebab-case，如 `add-time-core-normalize`；不带 `-v1`；归档后由工具移入 `changes/archive/YYYY-MM-DD-<name>`。

## 流程

issue（中文 task 模板）→ 需要行为契约则建 change → `docs/<N>-spec-<slug>` 分支开 OpenSpec-only PR（标题与提交统一英文 `docs(<area>): description (#N)`，正文 Refs #N + proposal 与 design 路径，CI 跑 `openspec validate <name> --strict`）→ 实现分支 `<type>/<N>-<slug>` 按 `tasks.md` 推进 → 收口 PR 写 `Closes #N` 并 `openspec archive <name>`（改了 design 则同步 prd 与 `docs/README.md`）。
