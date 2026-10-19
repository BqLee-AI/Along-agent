Issue: #4

## Why

PR 模板只有 5 段，缺行为变化、兼容迁移、未跑项、reviewer focus、AI 声明；issue 模板缺证据边界与 reopen 条件；无 required checks 指引。reviewer 只能凭经验挑刺，不能按模板打回。

## What Changes

- 重写 .github/PULL_REQUEST_TEMPLATE.md：保留关联/Spec/验收证据/Deferred/OpenSpec，新增 Before/After、Compatibility & Migration、Verification（含未跑项）、Reviewer focus、Checklist、AI assistance。
- task.md 加证据边界与可观察验收；decision.md 加 alternatives、验证证据、reopen 条件；新增 ISSUE_TEMPLATE/config.yml。
- 文档化 required checks 清单（8 个 job）与 reviewer 打回规则，落 CONTRIBUTING §8。

## Capabilities

### New Capabilities

- `pr-templates`: PR/Issue 模板证据化与合并门文档化。

### Modified Capabilities

（无：不改现有 spec 行为，只新增模板治理能力。）

## Impact

- 影响文件：.github/PULL_REQUEST_TEMPLATE.md、.github/ISSUE_TEMPLATE/task.md、decision.md、config.yml（新增）、CONTRIBUTING.md §5/§8。
- Spec: docs/design/13-p0-bootstrap-and-ci-rules.md §3（D1–D10 合并门槛）；CONTRIBUTING.md §5（PR 要求）。
- 不改业务代码、路由、schema、D1–D10 语义。

## 非目标/Deferred

- verify 脚本与 CI 补门（P0-3）、gates.json 可执行化（P0-4）、depcruise 边界（P0-5），各另开 issue。
- Deferred 项（鉴权/LLM/市场/推送/计费）不进 spec。
