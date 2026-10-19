## 1. PR 模板重写

- [ ] 1.1 重写 .github/PULL_REQUEST_TEMPLATE.md（保留 5 段，新增 Before/After、Compatibility & Migration、Verification、Reviewer focus、Checklist、AI assistance）
- [ ] 1.2 CONTRIBUTING.md §5 与新模板字段对齐（字段名一一对应）

## 2. Issue 模板补强

- [ ] 2.1 task.md 加证据边界与可观察验收；decision.md 加 alternatives、验证证据、reopen 条件；新增 config.yml

## 3. 合并门文档化与收口

- [ ] 3.1 CONTRIBUTING.md §8 补 required checks 清单（8 job）与打回规则
- [ ] 3.2 跑 `openspec validate improve-pr-templates --strict` 通过（A-治理）
- [ ] 3.3 实体验收：任举一 PR 按新模板可回答三问（改了什么/坏了什么/证据边界）；无证据 PR 可按模板打回（A-治理）
- [ ] 3.4 收口 PR 写 Closes #4 并 `openspec archive improve-pr-templates`
