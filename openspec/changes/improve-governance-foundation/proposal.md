Issue: #1

## Why

治理文档与仓库现状不符（AGENTS/READMEs 仍称无实现代码，实际已有 apps/packages）；冻结决策散在 design/Deferred，无 ADR 可追溯；提交与 PR 标题语言规则冲突。小步先立治理底座。

## What Changes

- 新增 CONTRIBUTING.md（人类贡献唯一入口）、SECURITY.md、CODE_OF_CONDUCT.md；AGENTS.md 瘦身为机器约束与索引。
- 新增 docs/adr/（README + 0000 模板 + 0001–0005 种子 ADR）。
- 修正 AGENTS.md / README.md / docs/README.md 过期描述；统一提交与 PR 标题规则。
- openspec/config.yaml、openspec/README.md、docs/README.md 补冲突矩阵（spec/design/ADR 权威顺序）。

## Capabilities

### New Capabilities

- `governance-foundation`: 人机入口分离、冻结决策 ADR 可追溯、根文档真实、提交规则唯一、权威冲突可裁决。

### Modified Capabilities

（无：不改现有 spec 行为，只新增治理能力。）

## Impact

- 影响文件：CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md、AGENTS.md、README.md、docs/README.md、docs/adr/、openspec/config.yaml、openspec/README.md。
- Spec: docs/design/13-p0-bootstrap-and-ci-rules.md §3（D1–D10 合并门槛）；docs/README.md（文档分层与真源关系）。
- 不影响业务代码、路由、schema、D1–D10 门禁语义。

## 非目标/Deferred

- PR/Issue 模板重写、verify 脚本与 CI 补门、gates.json 可执行化、depcruise 边界与每包 AGENTS（P0-2–P0-5 另开 issue）。
- Deferred 项（鉴权/LLM/市场/推送/计费）不进 spec。
