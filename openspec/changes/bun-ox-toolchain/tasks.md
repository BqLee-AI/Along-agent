# Bun/ox 工具链迁移 tasks（Issue #13）

## 1. 契约与真源

- [ ] 1.1 创建 `bun-ox-toolchain` change（proposal/tasks/specs/gates/spec.md），独立 OpenSpec-only PR 经 review 合入；实现 PR 引用已接受的行为契约。
- [ ] 1.2 更新 design/01 的运行时、包管理及布局描述和 design/13 的执行方式，不改变门定义；按仓库真源规则同步对应 PRD 与 docs 索引。记录取代 ADR 0002 的 Bun/ox 决策及旧 ADR 的 Superseded 状态，不把旧决策伪装成当前命令。
- [ ] 1.3 核对本任务与 #12 的集成基线，保留 `static → {migration-scan, scheduler-fault, contracts-dual} → compose-smoke` 及五个 required check 名。

## 2. 单锁文件、执行入口与构建顺序

- [ ] 2.1 根 `packageManager` 固定 `bun@1.4.2`，根 workspaces 覆盖 apps/_、packages/_、scripts；同步 engines、Bun 类型和安装要求，删除 pnpm 专有配置及 pnpm-workspace.yaml/pnpm-lock.yaml，只提交单一 bun.lock。
- [ ] 2.2 用 Bun 根/workspace scripts 取代 Turbo，保留所有有效的 build/dev/typecheck/test/test:unit/test:contracts/test:integration 入口；移除 turbo 依赖与 turbo.json，不留旧脚本别名或伪成功占位任务。
- [ ] 2.3 显式恢复原 `^build` 前置：干净 checkout 中先产出被依赖 packages 的 dist，再检查/测试/构建消费者；不能依赖本机遗留 dist、spike 的复制产物或 CI 跨 job 文件共享。梳理 Bun filter 的运行顺序，不把并行调度误当拓扑排序。
- [ ] 2.4 保留 `scripts/verify.mjs` 作为唯一顺序编排源，由 `bun run verify` 调用；内部旧工具链命令全量切换，步名、首错终止与退出码保持可观察，不新增第二套 Node/Bun 校验逻辑。

## 3. Oxlint、D2 与阻塞式格式门

- [ ] 3.1 固定 oxlint@1.89.0，接入仓库内 JS 规则插件：原样使用 `NewExpression[callee.name='Date']` 和 `CallExpression[callee.object.name='Date'][callee.property.name='now']`；保持原 apps/web 扩展名作用域与 dist/node_modules/coverage/.next 忽略范围、原错误文案。
- [ ] 3.2 盘点 `typescript-eslint.configs.recommended` 的非 D2 规则与全仓文件覆盖；显式配置 Oxlint 对应规则、级别并给出差异清单，重点验证 no-unused-vars、类型位置用法、下划线参数等差异。不得直接照搬 spike 为隔离 D2 而使用的 correctness=off；不得为让 lint 变绿顺带改业务、删断言、宽泛 disable 或静默放宽旧规则。
- [ ] 3.3 删除所有直接 eslint/typescript-eslint 依赖、eslint.config.mjs 及活动调用；D2 不回退 ESLint、不另设独立扫描脚本替代 Oxlint。
- [ ] 3.4 固定可获取的 oxfmt 版本，将现有宽度/引号与 ignore 约定映射到受支持配置，替换 format 与 format:check 的执行器；删除直接 prettier 依赖/旧配置。格式变更与行为变更区分评审，保留阻塞失败，不设 continue-on-error。

## 4. bun:test 迁移与测试分组

- [ ] 4.1 迁移全部 27 个测试文件到 bun:test；时钟测试直接使用 Bun 的 jest 命名空间和原用例断言，不保留 Vitest 兼容 shim；补齐测试类型配置。
- [ ] 4.2 删除根 vitest.config.ts、apps/web/vitest.config.ts、apps/api/vitest.integration.config.ts 和全部直接 vitest 依赖/活动调用；以明确路径选择恢复单元、integration、契约集合，不让根默认发现无意跑数据库测试，也不因配置删除漏掉文件。合法无测试包使用 Bun 的 `--pass-with-no-tests`，不掩盖应存在的测试集为空。
- [ ] 4.3 采用 spike 已证实的文件级 `--parallel=4` 隔离语义作为起点，按 runner 核数校准；不用文件内 `--concurrent` 代替文件隔离。保留 fake timers/spy 的恢复和环境/数据库状态边界。
- [ ] 4.4 根 test:contracts 显式纳入 apps/api/test/contracts.test.ts 的进程内与 HTTP 两组断言，并保留 contracts/stream-protocol 契约覆盖；不能仅照搬原 Turbo 路由（原 API package 缺少 test:contracts）。
- [ ] 4.5 integration 仍使用真实 PostgreSQL 16 与未改的迁移，执行全部 9 个 DB 测试文件；scheduler-fault job 保留取消、调度和故障注入集合及 D9 断言。记录 scheduler-fault 导入 scheduler-schedule.test 导致 2 个 case 重复注册的现状，不以执行总数冒充独立覆盖数，不顺带重构该共享 helper。

## 5. CI、Docker 与治理引用

- [ ] 5.1 共享 setup 改用 oven-sh/setup-bun@v2 固定 1.4.2 和 `bun install --frozen-lockfile`；各独立 job 仍安装自身所需依赖，同一 job 不重复安装，不虚构跨 runner 安装复用。保持 #12 DAG、DB service 独立状态与 static 的统一 verify 入口。
- [ ] 5.2 替换 ci.yml 全部 pnpm/Turbo/Vitest 活动命令，保留 SQL/迁移断言、integration、contracts-dual 和 compose-smoke；未经新的验收不删减构建或数据库步骤。
- [ ] 5.3 同步 infra/docker/Dockerfile 的固定 Bun 基础运行时、COPY 清单、冻结安装、构建及最终运行命令；infra/compose/compose.yaml 仍真实构建该 Dockerfile，scripts/compose-smoke.sh 仍验收实际 Bun 镜像，不保留藏在容器内的 pnpm/Corepack/Turbo/Node-only 旧安装路径。保留 api/worker/all 角色与健康/就绪语义，不在本任务部署。
- [ ] 5.4 更新 ci/gates.json D2 的配置/插件证据路径以及其他受影响的 enforced_by；必要时同步 check-gates-executable 的解析、其测试及既有 gates spec 的命令引用，保持缺 job/证据即红。
- [ ] 5.5 同步 CONTRIBUTING、README、AGENTS、PR 模板的当前命令与 required checks；清理活动 scripts/配置/文档中的旧工具链指令。历史 ADR/已归档 change 只保留有明确历史语义的文字，不纳入“活动调用”误删。

## 6. D/A 变红与收口验收

- [ ] D1：Bun 下原 dependency-cruiser 配置的正例通过；time-core 到外部包及 node:fs 的出边红例失败；反向时钟测试保持不读真实钟的断言，恢复全部变异。
- [ ] D2：在真实 Oxlint 中运行 new Date/Date.now 的 JS/TS/JSX/TSX 红例及 computed/shadow/optional 相近表达式正反例；apps/api、其他 packages、相近目录名、未覆盖扩展名与原 ignore 路径不被扩大禁令；冻结展示投影测试保持通过，恢复全部变异。
- [ ] D2/D10：非 D2 lint 质量规则的代表性红例仍阻塞；oxfmt 格式破坏使 format:check、verify 和 static 必红；治理脚本、禁词和口径扫描仍执行，移除 gate job/证据的演练仍红。
- [ ] D3–D6/D9：真实 PG integration、SQL 约束、并发写、取消/调度故障注入全部绿，无跳过或断言削弱；附执行集合和输出，不以仅单元绿代替。
- [ ] D8：bun run test:contracts 的进程内与 HTTP 两组均实际执行并通过；任一组失败时根命令和 contracts-dual job 均红。
- [ ] D7：从干净锁文件/构建输入运行实际 Docker Compose 冒烟；无 TZDB 时 /readyz 503+TZDB_UNAVAILABLE，有 TZDB 时 200，/healthz 200，未登录端点 401；Bun 镜像运行而非只在宿主机换 CLI。
- [ ] D1–D10：干净环境 `bun install --frozen-lockfile`、`bun run verify`、完整测试分组和五个 required checks 全绿；严格 OpenSpec 校验 valid。附 27 文件逐文件结果、独立用例与重复执行的区分、改前/改后 CI run URL 和墙钟；≤3 分钟为目标、≤2 分钟为冲刺，未达时据实报告而非跳门。
- [ ] 收口：独立 review 后，收口 PR 写 Closes #13；勾选实际完成任务，执行 `bunx --no-install openspec archive bun-ox-toolchain -y` 合并 gates delta，并执行 `bunx --no-install openspec validate --all --strict`，保留 archive 记录与最终验收证据。
