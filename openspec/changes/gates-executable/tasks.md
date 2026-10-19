# P0-4 tasks（Issue #9）

## 1. change 与 spec

- [ ] 1.1 建 `openspec/changes/gates-executable/`（proposal/tasks/specs/gates/spec.md），`openspec validate gates-executable --strict` 通过
- [ ] 1.2 推 OpenSpec-only PR，reviewer 复审后合入

## 2. 可执行门禁

- [ ] 2.1 gates.json D1–D10（D8 为 partial，其余 enforced）加 `enforced_by: {job, evidence[]}`，job 名与 ci.yml 一致，evidence 为仓库相对路径
- [ ] 2.2 新增 `scripts/check-gates-executable.mjs`：读 gates.json + ci.yml（文本匹配 job 名）+ fs 存在性断言 evidence；失败报 gate 名与缺项；exit 1
- [ ] 2.3 `check-gate-manifest.mjs` 加验：每条 enforced gate 必须有非空 `enforced_by.job` 与非空 `evidence[]`
- [ ] 2.4 `scripts/verify.mjs` STEPS 加 `gates-executable`（跑新脚本，位置在 gate-manifest 之后）
- [ ] 2.5 ci.yml gate-manifest job 加跑新脚本；CONTRIBUTING §8 同步说明
- [ ] 2.6 `pnpm verify` 全绿；`openspec validate --all --strict` valid

## 3. 变红测试（D 项映射）

- [ ] D1：删 `depcruise` job 引用，新脚本必红（对应 D1 时间唯一权威）
- [ ] D2：删 `lint` job 或 `apps/web/test/presentation.test.ts` evidence，新脚本必红（对应 D2 展示禁算时间；另有 eslint.config.mjs D2 门随 lint 同跑）
- [ ] D3/D4/D5/D6：删 `migration-scan` job 或任一 `scripts/db/*.sql` evidence，新脚本必红（删 job 红、删文件红各演练一次）
- [ ] D7：删 `compose-smoke` job 或 `scripts/compose-smoke.sh` evidence，新脚本必红（对应 D7 空环境冒烟）
- [ ] D9：删 `scheduler-fault` job 或 `apps/api/test/integration/scheduler-fault.test.ts` evidence，新脚本必红（对应 D9 取消后触发数=0）
- [ ] D10：删 `scan-copy-claims` evidence，新脚本必红（对应 D10 口径天花板）
- [ ] 3.x 收口：实现 PR 写 Closes #9；收口执行 `openspec archive gates-executable -y`（specs/gates 合入 `openspec/specs/gates/`）
