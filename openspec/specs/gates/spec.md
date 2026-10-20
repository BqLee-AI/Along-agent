# gates Specification

## Purpose

TBD - created by archiving change gates-executable. Update Purpose after archive.

## Requirements

### Requirement: gate 清单机读可执行

清单 SHALL 让每条 enforced gate 可机读定位其 CI 执行位置，不靠人工对照。

#### Scenario: enforced gate 有执行指向

- WHEN 读取 `ci/gates.json` 任一 status 为 enforced 的 gate
- THEN 其 `enforced_by.job` 非空且等于 `.github/workflows/ci.yml` 中的 job 名，其 `evidence[]` 非空且每项为仓库内存在路径

#### Scenario: partial gate 不强制指向

- WHEN 读取 status 为 partial 的 D8
- THEN 允许缺 `enforced_by`，但 SHALL 在 scope 注明补齐条件（contracts-dual 已覆盖最小双跑）

### Requirement: 缺执行即红

可执行检查 SHALL 在 gate 执行链缺失时失败，不静默放行。

#### Scenario: 删 job 必红

- WHEN 从 ci.yml 删除某 enforced gate 对应 job 名
- THEN `node scripts/check-gates-executable.mjs` exit 1 且输出含该 gate 名与缺失 job 名

#### Scenario: 删证据必红

- WHEN 删除某 enforced gate 任一 evidence 文件
- THEN `node scripts/check-gates-executable.mjs` exit 1 且输出含该 gate 名与缺失路径

### Requirement: 字样门同步验指向

清单字样检查 SHALL 与执行指向检查同进退，不出现字样绿但无执行。

#### Scenario: 缺 enforced_by 即红

- WHEN 某 enforced gate 缺 `enforced_by.job` 或空 `evidence[]`
- THEN `node scripts/check-gate-manifest.mjs` exit 1 且输出含该 gate 名

#### Scenario: 字样与执行一致

- WHEN 两脚本都通过
- THEN gates.json 中 enforced 条数等于 check-gates-executable 实际校验条数

### Requirement: verify 主链覆盖

一键 verify SHALL 跑可执行检查，本地与 CI 同行为。

#### Scenario: verify 含 gates-executable 步

- WHEN 运行 `node scripts/verify.mjs`
- THEN 输出含 `开始：gates-executable` 且任一步失败即停

#### Scenario: CI 同跑

- WHEN static job 经 `node scripts/verify.mjs` 执行静态校验
- THEN 同 job 内在 gate-manifest 步之后跑 `check-gates-executable.mjs`，红则整 job 红

### Requirement: D 项变红映射

每条死规矩 SHALL 有删执行链即红的演练记录。

#### Scenario: D1/D2/D10 映射

- WHEN 删除 static job，或分别删除 D1 的 .dependency-cruiser.cjs / D2 的 presentation.test.ts / D10 的 scan-copy-claims.mjs evidence（演练后恢复）
- THEN 新脚本对受影响的 D1/D2/D10 报红（对应 D1 时间唯一权威、D2 展示禁算时间、D10 口径天花板）；static job 缺失时三项均红

#### Scenario: D3–D6 映射

- WHEN 删 migration-scan job 或任一 scripts/db evidence（演练后恢复）
- THEN 新脚本对 D3/D4/D5/D6 报红（对应 D3 唯一约束、D4 后继唯一、D5 只追加、D6 不可变）

#### Scenario: D7/D9 映射

- WHEN 分别删 compose-smoke job 或 compose-smoke.sh / scheduler-fault job 或 scheduler-fault.test.ts（演练后恢复）
- THEN 新脚本对 D7/D9 报红（对应 D7 空环境冒烟、D9 取消后触发数=0）
