## 1. 治理文档底座

- [ ] 1.1 新增 CONTRIBUTING.md（环境/分支/提交/PR/测试/AI/review）、SECURITY.md、CODE_OF_CONDUCT.md
- [ ] 1.2 AGENTS.md 瘦身为机器约束与索引，流程细节迁 CONTRIBUTING，CONTRIBUTING/AGENTS/README 三处提交规则一致

## 2. ADR 与文档真源

- [ ] 2.1 新增 docs/adr/README.md + 0000-template.md + 0001–0005 种子 ADR
- [ ] 2.2 修正 AGENTS.md / README.md / docs/README.md 过期描述（可跑命令、真实布局）
- [ ] 2.3 openspec/config.yaml + openspec/README.md + docs/README.md 补冲突矩阵，旧"冲突时 design 优先"迁移为字段级规则

## 3. 校验与收口

- [ ] 3.1 跑 `openspec validate improve-governance-foundation --strict` 通过
- [ ] 3.2 实体验收：新人按 CONTRIBUTING 走通一次流程；每份冻结决策有 ADR 编号；三处提交规则逐字一致；spec/design 冲突按矩阵裁决各演练一次（A-治理）
- [ ] 3.3 收口 PR 写 Closes #1 并 `openspec archive improve-governance-foundation`（改了 design 则同步 prd 与 docs/README.md）
