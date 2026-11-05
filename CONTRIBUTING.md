# 贡献指南（CONTRIBUTING）

> 本文件是 `AGENTS.md`「提交与 PR」与 `README.md`「任务与进度」的中文展开说明。
> 冲突按冲突矩阵裁决：行为/验收以 openspec/specs 为准，字段/路由/状态机/错误码以 docs/design+api+schema 为准，why 以 ADR 为准；矩阵见 `docs/README.md` 与 `openspec/README.md`。

## 1. 环境要求

- Bun 固定 `1.4.2`，使用 workspaces 与单一 `bun.lock`；不再通过独立任务编排器运行。Node.js `>= 22` 可用于调用兼容的 `scripts/verify.mjs`，不替代 Bun 安装、构建与测试。
- Lint 使用 Oxlint `1.89.0`，格式化使用 Oxfmt `0.74.0`；命令统一经根 `package.json` scripts 调用。
- 安装依赖：`bun install --frozen-lockfile`；锁文件与 manifest 不一致即失败，不在 CI 中改锁。需要 workspace `dist/` 的构建、开发、类型检查与测试入口须先构建依赖包，不依赖宿主机旧产物或其他 CI job 的文件。
- `bun run test:contracts` 在 Linux x64 / WSL 使用 Docker，从当前树构建正式 Bun/native 镜像，自建独立网络、全新 PG16 与测试身份 secret；不使用已有数据库或个人模型凭据。原 healthz/契约包及真实本地/签名 HTTP 消费者同跑，必需 case 必须出现在本次实际报告且唯一通过。成功/失败均清理本次容器、卷、网络和镜像标签；缺前置不跳过（design/13 §4.2）。

真实可用命令（以 `package.json` 为准，禁止自创）：

| 用途                | 命令                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| 本地启动            | `bun run dev`（先构建依赖包；`apps/api` 3000 `ROLE=all`、`apps/web` 3100）                           |
| 类型检查            | `bun run typecheck`                                                                                  |
| 单元测试            | `bun run test:unit`（非数据库测试）                                                                  |
| 契约测试            | `bun run test:contracts`（正式 native + 隔离 PG 的本地/HTTP 合同、原 healthz 与契约包）              |
| 数据库测试          | `bun run test:integration`（全部真实 PG 集成文件）                                                   |
| 调度故障测试        | `bun run test:scheduler`（D9 指定集）                                                                |
| Lint                | `bun run lint`                                                                                       |
| 构建                | `bun run build:packages`（共享包）、`bun run build`（先包后应用）、`bun run build:api`（API 及依赖） |
| 依赖边界（D1）      | `bun run depcruise`                                                                                  |
| 统一门禁            | `bun run verify`                                                                                     |
| 格式修复 / 阻塞检查 | `bun run format` / `bun run format:check`                                                            |
| 契约校验            | `openspec validate <name> --strict`（如 `openspec validate v0-safety-contract --strict`）            |

数据库集成与调度入口、D8 契约入口使用每项 30 秒测试预算，涵盖真实迁移部署、行为执行与夹具清理；这不是应用 SLA，不改变各协议自身的 deadline 或业务断言。

环境变量占位（只占位，不写真实值）：`DATABASE_URL`、`TZDB_VERSION`（见 `.env.example`）。
缺 `TZDB_VERSION` 时 `/readyz` 返回 `503 TZDB_UNAVAILABLE`，属预期行为（D1/D7）。

## 2. 工作流：issue → 分支 → PR

1. 从 issue 领任务：issue 正文用 `.github/ISSUE_TEMPLATE/` 官方模板（`task.md` 通用任务或 `decision.md` 方案拍板），Spec 路径 + 章节号必填。
2. `main` 禁止直推，一律走 issue → 分支 → PR。
3. 一个 PR 只做一件事；有行为契约先建 OpenSpec-only PR，再提实现 PR。
4. #44 为规范基线对齐，不改变有效业务行为：仓颉唯一 Harness、TS 长期能力/业务/存储；同步公共用例、只读投影、确认创建/取消单事务与异步 outbox 的适用范围见 [design/02 §1–§2](docs/design/02-modular-monolith-and-split-triggers.md) 与 [design/09](docs/design/09-agent-runtime-and-checkpoint.md)。历史 ADR/验收不冒充新目标已实现；行为变化仍先独立 OpenSpec-only。

## 3. 分支命名

- 通用格式：`<type>/<N>-<slug>`，如 `feat/7-commitments-migrations`。
- 仅改 OpenSpec（proposal/tasks/spec）不用实现代码：`docs/<N>-spec-<slug>`。
- `<N>` 为 issue 号，`<slug>` 为英文短横线小写。

## 4. 提交与 PR 标题（与 AGENTS/README 逐字一致）

提交信息与 PR 标题统一用英文，格式 type(area): description（如 docs(governance): add repo AGENTS (#16)）；issue/PR 正文用中文并套用 .github/ 模板。

- `type` 与 `area` 均为英文小写；`description` 用英文短语。
- 提交信息单行 ≤ 72 字符；一个提交只做一件事；合并一律 squash（PR 标题即 squash 后的提交信息）。

## 5. PR 要求（正文中文，用模板）

- PR 正文必须用 `.github/PULL_REQUEST_TEMPLATE.md` 原字段填写，不要自创格式，字段与模板一一对应：
  - `关联`：`Refs #N` 或 `Closes #N`。一个 issue 可对应多个 PR，**只有收口 PR 写 `Closes #N`**（收口含 `openspec archive`），其余一律 `Refs #N`。
  - `Before / After`：行为变化一句话 + 前后对比。
  - `Spec`：必填，`<路径> §章节`（如 `docs/design/03-v0-vertical-slice.md §2`），或 `openspec/changes/<name>/proposal.md`。
  - `Compatibility & Migration`：坏了什么、迁移/回滚路径；无则写"无"。
  - `Verification`：按 §6.1 说明测试策略、保护的行为及 Red/Green 或替代依据；记录实际命令、结果、真实路径验证和未跑项+原因，未跑项必填。
  - `验收证据`：CI 链接 / 测试输出 / 变红测试 PR 链接。
  - `Reviewer focus`：请 reviewer 重点看的风险点/不确定处。
  - `未触碰的 Deferred 声明`：明确列出没动的 Deferred（如鉴权/LLM/市场/推送/计费）。
  - `AI assistance`：用则写工具名+人工复核了什么，没用写"无"。
  - `OpenSpec change`：`openspec/changes/<name>` 路径，或写「无 + 原因」（纯文档/脚手架/CI 类按 config.yaml 可不建 change）。
  - `Checklist`：逐项勾选；收口 PR 勾选 `tasks.md 已勾选对应项` 与 `已 archive`，非收口 PR 不勾 archive。
- 改 `docs/design/` 的 PR 必须同步 `docs/prd/` 与 `docs/README.md` 索引。
- 引用外部蓝图一律用 B00–B06 / AF 代号，不复制外部产物原文。

## 6. 测试门槛（提交前必过）

- 提交前运行与改动范围对应的检查；完整范围须通过 `bun run verify`、`bun run test:contracts` 及相关数据库门。分类规则与 main 完整验证见 design/13 §4。
- 代码变更必须有对应行为覆盖；新增或改变行为、修复重要缺陷时补或改测试，保持行为的重构可复用已验证的充分覆盖。测试策略按 §6.1 自主选择。
- D1–D10 的业务不变量不变（见 `docs/design/13-p0-bootstrap-and-ci-rules.md §3`）；每条必有变红测试，按变更范围执行，跳过不视为本次通过。
- S0 冻结别名禁入：`outbox_events`、`schedule_confirmed`、`SERVICE_NOT_READY`、`C-XXXX`、整句文本确认。

- 一键 verify：`bun run verify`，保留 `scripts/verify.mjs`；也可用 `bun scripts/verify.mjs` 或 `node scripts/verify.mjs` 调用，内部统一执行 Bun 命令。按序跑 `lint → typecheck → depcruise → gate-manifest → gates-executable → frozen-names → copy-claims → test:unit → openspec validate --all --strict → format:check`，任一失败即停并报步名与非零退出码。`openspec/changes` 下无 active change 时 OpenSpec 步提示跳过，也可用 `--skip openspec` 主动跳过。
- 同次 `verify` 仅在 `typecheck` 成功后，让后续单元步骤复用其已构建的共享 packages，省去重复构建；失败即停，不消费失败构建。共享包构建保留依赖拓扑，其后的 workspace 类型检查用 `--sequential` 串行执行，不省略源码、测试或 Next route typegen。独立 `bun run test:unit` 或 `verify --skip typecheck` 仍先构建包，不以旧 `dist/`、跨次运行标记或其他 job 的产物代替准备。
- 红例含义：`lint/typecheck` 红=代码或类型坏；`depcruise` 红=越 D1 依赖边界；治理脚本红=门清单/执行证据/冻结名/文案断言坏（看输出行）；`test:unit` 红=单元坏；`openspec validate` 红=change 的 proposal/tasks/spec 不一致；`format:check` 红=跑 `bun run format` 后重提，不能作为非阻塞警告放行。
- 测试统一使用 `bun:test`，通过文件级并行提速，保留文件状态隔离与 mock/spy/时钟恢复；不把有共享状态的用例改成文件内 concurrent。单元入口排除数据库与正式 native 合同集；契约入口保留 healthz/契约包，并运行相同业务的本地公共用例与真实签名 HTTP/native 消费者。本次报告缺失、必需 case 漏跑/重复/跳过/失败均拒绝，不以声明或旧测试绿色代替。数据库与调度故障入口使用真实 PostgreSQL 16、原迁移和明确测试环境，不跳过唯一性、只追加或取消窗口断言。
- PostgreSQL 集成测试每文件用 `createIntegrationDatabase()` 创建随机独立 schema，并在其中应用原始迁移；连接的 `search_path` 不回退 public，worker 不能消费其他文件的夹具。新连接用该句柄的 `connect()`，子进程显式继承该句柄的连接串；结束时 `close()` 只清理本文件创建的 schema。测试角色需有数据库 CREATE 权限。
- 共享调度驱动放在非 `.test.ts` helper；测试文件不得互相导入来复用函数，避免重复注册套件。数据库夹具与临时故障注入只验证测试边界，不替代生产 Web、真实到点与强杀验收。
- 并发测试若要求指定先提交者，须在该业务事务已取得目标行写锁后设置可观察屏障，再启动并确认后写者等待；不能把“先调用”或“先等待第三方行锁”当作取得写入权。夹具同步仅放在本文件的隔离 schema，结束时清理，不修改生产锁或添加重试。

### 6.1 测试策略与测试先行

实现者（包括 agent）按每项行为自主选择策略，而非给整个 issue 贴一个方法标签；同一 issue 可以既有探索，也有测试先行。不向用户逐项询问是否使用 TDD；先查已有 Spec、代码与覆盖，只有业务合同存在实质歧义才升级确认。测试难写不是跳过行为验证的理由。

选择前先明确：保护哪项合同或不变量、什么可观察结果能区分正确与错误、是否已有有效覆盖。测试不能替代 Spec，也不能把实现碰巧具有的行为自动变成合同。

| 情况                                        | 默认策略                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| 新增或改变明确、可验证的行为                | 测试先行：先表达一项预期，观察失败，再最小实现                                   |
| 可复现且值得长期保护的重要缺陷              | 先补失败回归，再修复；保护合同、现实可重现的问题或重大安全/数据完整性风险        |
| 保持行为的重构，已有充分覆盖                | 先确认相关覆盖有效，再在绿色保护下重构；不为凑流程新增测试                       |
| SDK、协议或外部能力未知                     | 先最小真实实验，确认能力后再为正式行为选择测试；实验不自动成为正确合同或永久测试 |
| 纯文档、labels 或无需新增行为覆盖的机械更新 | 不强套 TDD，执行对应内容、配置或运行检查并说明依据                               |

测试先行按小步循环执行：

1. **Red**：先写保护一项行为的测试，实际运行并确认因目标行为缺失而失败。环境、依赖、导入或编译失败须先定位；仅有这类失败不足以证明行为被保护。测试一开始就通过时，检查行为是否已存在或断言过弱，不制造假红。
2. **Green**：做满足当前合同的最小实现，使同一有效行为断言通过；不通过削弱验收、吞掉错误或扩建无关框架转绿。
3. **Refactor**：在绿色保护下整理职责和重复，再运行受影响覆盖；保持合同的内部重构不应迫使测试跟随私有实现大量改写。
4. 选择下一项边界或行为，重复循环；不要求一次写完整套测试后才允许实现。

永久测试保护长期有效的合同和可观察结果，例如权限决定、数据库状态、协议事件或文件内容；不测试源码文案、mock 回显或非合同的私有调用顺序。数据库事务、真实 HTTP、跨语言接口等应在能暴露问题的边界验证，不能为了方便只检查 mock 被调用。LLM 的权限、预算与停止规则可做确定性测试，开放式任务质量需真实场景评估，不锁死非合同的措辞或唯一工具顺序。

在现有 PR `Verification` 中简短记录：

- 保护的行为、所选策略和依据。复用覆盖时指出相关测试及保护范围；先探索时说明实际实验和后续正式覆盖；不适用时说明替代检查。
- 测试先行时记录 Red 的命令、目标失败原因，以及 Green 的命令与结果，并能对应测试及代码版本。实现后补测、变异或故障注入可证明回归检测能力，但不得伪称已经测试先行。
- 实际用户路径的验证和未覆盖项。测试通过不替代可达的真实 HTTP、数据库、Web、仓颉或工具产物验收；只报告实际执行的范围。

不要求单独提交红色 commit 或合入失败测试；CI 检查最终行为和回归，不能仅凭绿色结果证明开发顺序。沿用现有 issue、Spec、PR 字段和合并门，不新增 TDD 文档、labels、审批或独立 CI 门。

本人目标内委托的拟议合同见 [design/20](docs/design/20-goal-scoped-delegation.md) 与 #105 change。审阅/实现时区分正常自主、实际缺口、新增影响与硬拒绝；授权修订不证明后台或未交付能力，连接按冻结 request-bound/server-owned 分别验证，不用旧文案拒绝新目标或冒称后台已上线。保留 owner、纯时间、事务、append-only、取消/回执、文件版本/许可及 unknown 有效覆盖，不以源码字符串重钉实现。真实模型/消费者/产物与纯规范分别举证；规范不启用权限、不归档未实施 change。

### D1 依赖边界与变红证据

- `bun run depcruise` 实际扫描 `apps packages`；`scripts/test/boundaries.test.ts` 使用 `bun:test` 运行真实 depcruise 的正反 fixture，属于 `bun run test:unit`，两者均由 `bun run verify` 执行。
- API 按执行目录下 `apps/api/src/modules/` 的实际子目录逐模块生成规则，新增模块无需维护名单。禁止直接引用其他模块的 `repository`、`schema`、`schemas` 同名文件/目录或 `-repository`、`-schema`、`-schemas` 后缀实现；包含嵌套路径和 `import type`。自身存储访问和公共服务调用仍合法，不新增公共服务封闭白名单。
- 保留 conversations→tools/gateway、tasks→notifications/service、tools→approvals/create/presentation 和 approvals/confirm→tasks/cancel；confirm 改为引用 tasks/cancel-repository 仍报 `no-approvals-cross-module-storage`，没有事务存储层通配豁免。
- Web 不得直接引用 API 源码（含类型），报 `no-web-to-api`；HTTP 客户端不受影响。
- 共享包依赖范围：time-core 仅自身源码；contracts、stream-protocol 仅自身源码与 zod；scheduler-core 仅自身源码、contracts、time-core；notifier-core 仅自身源码、contracts。未声明的 workspace、应用、外部包和 Node 内置模块均拒绝。
- `scripts/fixtures/boundaries/` 保留扫描输入；测试复制到只读使用的临时目录并链接已安装的真实 zod/TypeScript，最多两个异步 CLI 同时运行，逐条断言 depcruise 退出码、违规规则名且无未解析依赖。绿例保留 err/JSON 两种真实扫描，清理前等待已排队及运行中的 CLI 结束；红例输出 `[red] exit=1 <规则>: <来源> → <目标>`，D1 evidence 由 `ci/gates.json` 登记。此并发仅用于边界 fixture，不改共享时钟、mock 或数据库用例的并发。
- D1 绿色仅证明上述静态导入规则，不解析 SQL 表归属、owner 过滤或事务原子性。公共函数中直接 SQL 仍需按模块所有权人工审查及行为验证；受控确认事务包含创建和取消分支，不是跨模块存储导入豁免（design/02 §1–§2，ADR 0009）。

## 7. AI 辅助声明

- 使用 AI 辅助（代码/文档/测试）须在 PR 正文 `验收证据` 或 `Deferred 声明` 附近加一行声明，例如：`AI 声明：本 PR 由 <工具名> 辅助起草，已人工复核 design 引用与测试证据。`
- AI 生成内容同样受 S0 冻结与 D1–D10 约束；不确定的服务端行为标 `[INFERENCE]`，不猜字段/路由。

## 8. Review 证据与合并门

- PR 必须附：① CI 全绿链接；② 关键测试输出（粘贴或 CI 日志链接）；③ 若触及 D1–D10，每条附变红测试链接或变异证明。
- Reviewer 只看证据合入：无验收证据、无 Deferred 声明、无 Spec 引用的 PR 直接打回，不进入代码细节评审。
- Required checks 为 `checks`、`integration`，两者均须成功；PR 根据变更范围执行，main 完整验证。文档范围仅检查文案、规范和格式；Web 范围执行 `verify` 与 Web 构建；其余或未知范围执行完整验证。详细路径规则见 `docs/design/13-p0-bootstrap-and-ci-rules.md §4`。
- 完整范围下，`integration` 并行执行真实 PG 数据库/调度检查、独立 native 合同和两轮全新卷 Compose 冒烟；任何一项失败均阻塞。`scripts/check-gates-executable.mjs` 校验门禁声明及证据文件，不能证明本次运行了这些检查；根契约入口另校验本次 Bun JUnit 报告的 D8 必需消费者。
