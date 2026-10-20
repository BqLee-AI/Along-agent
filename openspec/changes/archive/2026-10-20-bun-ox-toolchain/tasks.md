# Bun/ox 工具链迁移 tasks（Issue #13）

## 1. 契约与真源

- [x] 1.1 创建 `bun-ox-toolchain` change（proposal/tasks/specs/gates/spec.md），独立 OpenSpec-only PR #18 经 review 合入；实现引用已接受的行为契约。
- [x] 1.2 更新 design/01 的运行时、包管理及布局描述和 design/13 的执行方式，不改变门定义；同步 PRD/docs 索引，ADR 0006 取代 0002 并更新旧 ADR 状态。
- [x] 1.3 基于 #12/#14 合入后的 `9d6f850`，保持五个 required check 名与原 DAG。

## 2. 单锁文件、执行入口与构建顺序

- [x] 2.1 固定 Bun 1.4.2、根 workspaces、单一 bun.lock 与 Bun 类型；删除 pnpm 锁、workspace 配置及专用 `.npmrc`。
- [x] 2.2 用 Bun scripts 取代 Turbo，保留有效入口（包括四个已有非空 workspace 的 test:contracts），删除 Turbo 配置与伪成功任务。
- [x] 2.3 根显式先 build:packages 再消费者，filter 未使用 `--parallel` 打破构建拓扑；真实 Docker 从不含宿主机 dist 的输入成功构建并启动。
- [x] 2.4 唯一 verify 编排保留 10 步；Bun 调用完整通过，实际 D2 红例验证首错停止；Node 调用的定向格式失败演练传播 exit 1。

## 3. Oxlint、D2 与阻塞式格式门

- [x] 3.1 固定 Oxlint 1.89.0，仓库插件原样保留两个 selector、作用域、忽略范围与文案。
- [x] 3.2 原 24 条非 D2 规则均显式为 error；完整映射及 `.d.ts`、Array 等原生差异见 design/13 §4.1。旧 ESLint 基线无错误，新 Oxlint 同样无错误；额外 12 条 escape warnings 不顺改业务。
- [x] 3.3 删除直接 ESLint/typescript-eslint 依赖、配置及活动调用；D2 不保留旁路扫描器。
- [x] 3.4 固定 Oxfmt 0.74.0，保留宽度/引号/生成物忽略；删除直接 Prettier 依赖与旧配置，真实格式破坏仍阻塞。

## 4. bun:test 迁移与测试分组

- [x] 4.1 全部 27 个基线文件及 #14 新增边界文件迁到 bun:test，新增本任务 lint 行为测试，共 29 文件；时钟直接使用 Bun jest，无 shim。四处 matcher 比较只补充合法比较域类型，未更改断言。
- [x] 4.2 删除三份 Vitest 配置与全部直接依赖；根及 API 默认非 DB 集合显式排除 integration，所有非空集合均不使用 pass-with-no-tests。
- [x] 4.3 保留 `--parallel=4` 文件隔离、原 fake timer/spy 恢复，不使用文件内 concurrent。
- [x] 4.4 根 test:contracts 实际执行 API 进程内/HTTP 与 contracts/stream-protocol，14 pass；分别破坏任一 API 模式后，根入口均 13 pass/1 fail、exit 1。
- [x] 4.5 真实 PG 全部 9 文件为 62 次通过、0 fail/skip，对应 60 个独立定义；scheduler-fault 导入 schedule 文件重复注册 2 case，未抽取或改写 helper。

## 5. CI、Docker 与治理引用

- [x] 5.1 共享 setup 固定 setup-bun v2 SHA、Bun 1.4.2 与 frozen install；每 job 安装一次，保留独立 DB 与 static 统一入口。
- [x] 5.2 workflow 全部切换 Bun，SQL/并发脚本不变；migration-scan 完整构建后运行 API integration，scheduler-fault 构建 API 依赖后运行原指定集合，避免重复编译与无关 Web 构建。
- [x] 5.3 固定 Bun 镜像、完整 manifests/锁与冻结安装、依赖先构建及 Bun 启动；实际原 Compose/Dockerfile 冒烟通过，未部署。
- [x] 5.4 D2 evidence 指向真实配置/插件/行为测试；当前 checker 中删配置、删插件、删 static 的独立副本演练均 exit 1。
- [x] 5.5 同步贡献指南、README、AGENTS、PR 模板、design/PRD/索引与 ADR；历史文字不冒充活动命令。

## 6. D/A 变红与收口验收

- [x] D1：真实 Bun depcruise 正例与 42 个拒绝 fixture 通过，反向时钟原断言通过；仓库图无违规（363 modules / 713 dependencies）。
- [x] D2：真实 Oxlint 拒绝四种扩展名及 nested/shadow/optional/computed identifier 的 17 个位置，放行原相近语法、其他目录/扩展名和四个原忽略路径；展示投影原测试通过。
- [x] D2/D10：代表性非 D2 红例仍 error；实际 Web probe 使 verify 在 lint 停止；格式破坏令 format:check 及 Node 兼容 verify 的格式步 exit 1（该定向演练显式跳过前 9 步，不冒充完整绿跑）。删新 D2 evidence/static 的副本演练均红；所有探针已恢复。
- [ ] D3–D6/D9：真实 PG integration、SQL 约束、并发写、取消/调度故障注入全部绿，无跳过或断言削弱；附执行集合和输出，不以仅单元绿代替。
- [x] D8：真实 Bun 镜像中根契约 14 pass/4 文件，进程内/HTTP 分别破坏时均 1 fail、root exit 1；工作树测试未改为红例。
- [x] D7：独占 Compose 项目新卷真实 Bun 镜像验收 healthz 200、未登录 me/brief 401、无 TZDB readyz 503+TZDB_UNAVAILABLE、有 TZDB 200；脚本退出清理任务卷，不碰用户项目。
- [ ] D1–D10：干净环境 `bun install --frozen-lockfile`、`bun run verify`、完整测试分组和五个 required checks 全绿；严格 OpenSpec 校验 valid。附 27 文件逐文件结果、独立用例与重复执行的区分、改前/改后 CI run URL 和墙钟；≤3 分钟为目标、≤2 分钟为冲刺，未达时据实报告而非跳门。
- [ ] 收口：独立 review 后，收口 PR 写 Closes #13；勾选实际完成任务，执行 `bunx --no-install openspec archive bun-ox-toolchain -y` 合并 gates delta，并执行 `bunx --no-install openspec validate --all --strict`，保留 archive 记录与最终验收证据。

## 7. 本地验收记录（2026-10-20）

- 环境：Windows x64、Bun 1.4.2；DB 使用任务独占 PostgreSQL 16 库和白名单环境、`TZ=Pacific/Kiritimati`。完整 verify 10 步通过；OpenSpec 3 passed。OpenSpec 的第三方遥测请求超时未影响校验退出码。
- 完整 API/Next 生产构建通过。实际 `bun run dev` 启动两个服务：首页 200、API healthz 200、同源代理未登录 401；API watch 从仓库根跟踪共享包 dist，触碰依赖时连接短暂重置，随后 healthz 200 恢复。
- 20 个非 DB 文件 132 pass / 0 fail；9 个 DB 文件 62 pass / 0 fail / 0 skip，合计 194 次执行、192 个独立定义。独立数扣除 schedule 的 2 次重复注册，不把重复执行当新覆盖。
- 四处 matcher 类型修正后的 SSE 单文件追加验证为 20 pass / 0 fail；不重复其他 DB 文件。契约根入口另外在一次性镜像中 14 pass，两个模式分别变红均退出 1。
- CI 基线：#12 run `39358591669` 首 job 到末 job 252 秒；含 #14 边界测试的 #19 run `39362035667` 为本迁移前完整五 job 证据。迁移后的 run 与墙钟在 PR 验收记录补充。

| 非 DB 文件                                          | pass |
| --------------------------------------------------- | ---: |
| apps/api/test/app.test.ts                           |    9 |
| apps/api/test/role.test.ts                          |    3 |
| apps/api/test/contracts.test.ts                     |    2 |
| apps/api/test/identity-adapter.test.ts              |    4 |
| apps/api/test/identity-crypto.test.ts               |    5 |
| apps/api/test/presentation.test.ts                  |    9 |
| apps/web/test/presentation.test.ts                  |    3 |
| packages/time-core/test/golden.test.ts              |    6 |
| packages/time-core/test/reverse-clock.test.ts       |    2 |
| packages/time-core/test/dst.test.ts                 |    3 |
| packages/time-core/test/entry-fixes.test.ts         |    5 |
| packages/time-core/test/expressions.test.ts         |    2 |
| packages/contracts/test/errors.test.ts              |    3 |
| packages/stream-protocol/test/events.test.ts        |    2 |
| packages/stream-protocol/test/thread-events.test.ts |    7 |
| packages/notifier-core/test/copy.test.ts            |    4 |
| packages/scheduler-core/test/gate.test.ts           |    9 |
| scripts/test/scripts.test.ts                        |    8 |
| scripts/test/boundaries.test.ts                     |   43 |
| scripts/test/lint.test.ts                           |    3 |

| DB 文件（apps/api/test/integration/）      | pass |
| ------------------------------------------ | ---: |
| approvals-confirm.test.ts                  |   12 |
| approvals-read.test.ts                     |    4 |
| brief.test.ts                              |    5 |
| conversations-sse.test.ts                  |   20 |
| identity-session.test.ts                   |    5 |
| scheduler-schedule.test.ts                 |    2 |
| scheduler-fault.test.ts（含 2 次导入注册） |    6 |
| tasks-cancel.test.ts                       |    4 |
| tasks-read.test.ts                         |    4 |
