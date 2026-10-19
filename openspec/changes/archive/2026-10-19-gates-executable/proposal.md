Issue: #9

# P0-4 gates 清单可执行化

`ci/gates.json` 当前是静态清单，`check-gate-manifest.mjs` 只验字样。任一条 gate 的 CI job/脚本/测试被删，门禁照样绿。

## Spec

docs/design/13-p0-bootstrap-and-ci-rules.md §3（D1–D10）；ci/gates.json v1。

## 变更

- gates.json 每条 enforced gate 加 `enforced_by: {job, evidence[]}`，指向 ci.yml job 名与脚本/测试路径。
- 新增 `scripts/check-gates-executable.mjs`：逐条断言 job 存在于 ci.yml、evidence 文件存在；缺一即红；接入 verify 与 gate-manifest job。
- `check-gate-manifest.mjs` 同步验 `enforced_by` 非空。
- CONTRIBUTING §8 同步。

## 非目标/Deferred

- 不改 D1–D10 语义；不改业务代码/路由/schema。
- depcruise 边界细化（P0-5 另开）；鉴权/LLM/市场/推送/计费均未动。
