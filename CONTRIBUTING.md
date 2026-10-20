# 贡献指南（CONTRIBUTING）

> 本文件是 `AGENTS.md`「提交与 PR」与 `README.md`「任务与进度」的中文展开说明。
> 冲突按冲突矩阵裁决：行为/验收以 openspec/specs 为准，字段/路由/状态机/错误码以 docs/design+api+schema 为准，why 以 ADR 为准；矩阵见 `docs/README.md` 与 `openspec/README.md`。

## 1. 环境要求

- Bun 固定 `1.4.2`，使用 workspaces 与单一 `bun.lock`；不再通过独立任务编排器运行。Node.js `>= 22` 可用于调用兼容的 `scripts/verify.mjs`，不替代 Bun 安装、构建与测试。
- Lint 使用 Oxlint `1.89.0`，格式化使用 Oxfmt `0.74.0`；命令统一经根 `package.json` scripts 调用。
- 安装依赖：`bun install --frozen-lockfile`；锁文件与 manifest 不一致即失败，不在 CI 中改锁。需要 workspace `dist/` 的构建、开发、类型检查与测试入口须先构建依赖包，不依赖宿主机旧产物或其他 CI job 的文件。

真实可用命令（以 `package.json` 为准，禁止自创）：

| 用途                | 命令                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| 本地启动            | `bun run dev`（先构建依赖包；`apps/api` 3000 `ROLE=all`、`apps/web` 3100）                           |
| 类型检查            | `bun run typecheck`                                                                                  |
| 单元测试            | `bun run test:unit`（非数据库测试）                                                                  |
| 契约测试            | `bun run test:contracts`（API 进程内与 HTTP 双跑 + 契约包）                                          |
| 数据库测试          | `bun run test:integration`（全部 9 个 DB 文件）                                                      |
| 调度故障测试        | `bun run test:scheduler`（D9 指定集）                                                                |
| Lint                | `bun run lint`                                                                                       |
| 构建                | `bun run build:packages`（共享包）、`bun run build`（先包后应用）、`bun run build:api`（API 及依赖） |
| 依赖边界（D1）      | `bun run depcruise`                                                                                  |
| 统一门禁            | `bun run verify`                                                                                     |
| 格式修复 / 阻塞检查 | `bun run format` / `bun run format:check`                                                            |
| 契约校验            | `openspec validate <name> --strict`（如 `openspec validate v0-safety-contract --strict`）            |

环境变量占位（只占位，不写真实值）：`DATABASE_URL`、`TZDB_VERSION`（见 `.env.example`）。
缺 `TZDB_VERSION` 时 `/readyz` 返回 `503 TZDB_UNAVAILABLE`，属预期行为（D1/D7）。

## 2. 工作流：issue → 分支 → PR

1. 从 issue 领任务：issue 正文用 `.github/ISSUE_TEMPLATE/` 官方模板（`task.md` 通用任务或 `decision.md` 方案拍板），Spec 路径 + 章节号必填。
2. `main` 禁止直推，一律走 issue → 分支 → PR。
3. 一个 PR 只做一件事；有行为契约先建 OpenSpec-only PR，再提实现 PR。

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
  - `Verification`：跑了什么（命令+结果）与未跑项+原因，未跑项必填。
  - `验收证据`：CI 链接 / 测试输出 / 变红测试 PR 链接。
  - `Reviewer focus`：请 reviewer 重点看的风险点/不确定处。
  - `未触碰的 Deferred 声明`：明确列出没动的 Deferred（如鉴权/LLM/市场/推送/计费）。
  - `AI assistance`：用则写工具名+人工复核了什么，没用写"无"。
  - `OpenSpec change`：`openspec/changes/<name>` 路径，或写「无 + 原因」（纯文档/脚手架/CI 类按 config.yaml 可不建 change）。
  - `Checklist`：逐项勾选；收口 PR 勾选 `tasks.md 已勾选对应项` 与 `已 archive`，非收口 PR 不勾 archive。
- 改 `docs/design/` 的 PR 必须同步 `docs/prd/` 与 `docs/README.md` 索引。
- 引用外部蓝图一律用 B00–B06 / AF 代号，不复制外部产物原文。

## 6. 测试门槛（提交前必过）

- `bun run verify`、`bun run test:contracts` 及相关数据库门必须全部通过；任一红即合并不通过。
- 改了代码就要补或改对应的测试，即使没人要求。
- D1–D10 是合并门槛（见 `docs/design/13-p0-bootstrap-and-ci-rules.md §3`）：time-core 零依赖、展示禁算时间、唯一约束、只追加、空环境冒烟、契约双跑、取消后触发数 = 0、口径天花板，每条必有变红测试。
- S0 冻结别名禁入：`outbox_events`、`schedule_confirmed`、`SERVICE_NOT_READY`、`C-XXXX`、整句文本确认。

- 一键 verify：`bun run verify`，保留 `scripts/verify.mjs`；也可用 `bun scripts/verify.mjs` 或 `node scripts/verify.mjs` 调用，内部统一执行 Bun 命令。按序跑 `lint → typecheck → depcruise → gate-manifest → gates-executable → frozen-names → copy-claims → test:unit → openspec validate --all --strict → format:check`，任一失败即停并报步名与非零退出码。`openspec/changes` 下无 active change 时 OpenSpec 步提示跳过，也可用 `--skip openspec` 主动跳过。
- 同次 `verify` 仅在 `typecheck` 成功后，让后续单元步骤复用其已构建的共享 packages，省去重复构建；失败即停，不消费失败构建。共享包构建保留依赖拓扑，其后的 workspace 类型检查用 `--sequential` 串行执行，不省略源码、测试或 Next route typegen。独立 `bun run test:unit` 或 `verify --skip typecheck` 仍先构建包，不以旧 `dist/`、跨次运行标记或其他 job 的产物代替准备。
- 红例含义：`lint/typecheck` 红=代码或类型坏；`depcruise` 红=越 D1 依赖边界；治理脚本红=门清单/执行证据/冻结名/文案断言坏（看输出行）；`test:unit` 红=单元坏；`openspec validate` 红=change 的 proposal/tasks/spec 不一致；`format:check` 红=跑 `bun run format` 后重提，不能作为非阻塞警告放行。
- 测试统一使用 `bun:test`，通过文件级并行提速，保留文件状态隔离与 mock/spy/时钟恢复；不把有共享状态的用例改成文件内 concurrent。单元入口排除数据库集，契约入口不能只跑契约包而漏掉 API 两种传输。数据库与调度故障入口使用真实 PostgreSQL 16、原迁移和明确测试环境，不跳过唯一性、只追加或取消窗口断言。

### D1 依赖边界与变红证据

- `bun run depcruise` 实际扫描 `apps packages`；`scripts/test/boundaries.test.ts` 使用 `bun:test` 运行真实 depcruise 的正反 fixture，属于 `bun run test:unit`，两者均由 `bun run verify` 执行。
- API 按执行目录下 `apps/api/src/modules/` 的实际子目录逐模块生成规则，新增模块无需维护名单。禁止直接引用其他模块的 `repository`、`schema`、`schemas` 同名文件/目录或 `-repository`、`-schema`、`-schemas` 后缀实现；包含嵌套路径和 `import type`。自身存储访问和公共服务调用仍合法，不新增公共服务封闭白名单。
- 保留 conversations→tools/gateway、tasks→notifications/service、tools→approvals/create/presentation 和 approvals/confirm→tasks/cancel；confirm 改为引用 tasks/cancel-repository 仍报 `no-approvals-cross-module-storage`，没有事务存储层通配豁免。
- Web 不得直接引用 API 源码（含类型），报 `no-web-to-api`；HTTP 客户端不受影响。
- 共享包依赖范围：time-core 仅自身源码；contracts、stream-protocol 仅自身源码与 zod；scheduler-core 仅自身源码、contracts、time-core；notifier-core 仅自身源码、contracts。未声明的 workspace、应用、外部包和 Node 内置模块均拒绝。
- `scripts/fixtures/boundaries/` 保留扫描输入；测试复制到只读使用的临时目录并链接已安装的真实 zod/TypeScript，最多两个异步 CLI 同时运行，逐条断言 depcruise 退出码、违规规则名且无未解析依赖。绿例保留 err/JSON 两种真实扫描，清理前等待已排队及运行中的 CLI 结束；红例输出 `[red] exit=1 <规则>: <来源> → <目标>`，D1 evidence 由 `ci/gates.json` 登记。此并发仅用于边界 fixture，不改共享时钟、mock 或数据库用例的并发。

## 7. AI 辅助声明

- 使用 AI 辅助（代码/文档/测试）须在 PR 正文 `验收证据` 或 `Deferred 声明` 附近加一行声明，例如：`AI 声明：本 PR 由 <工具名> 辅助起草，已人工复核 design 引用与测试证据。`
- AI 生成内容同样受 S0 冻结与 D1–D10 约束；不确定的服务端行为标 `[INFERENCE]`，不猜字段/路由。

## 8. Review 证据与合并门

- PR 必须附：① CI 全绿链接；② 关键测试输出（粘贴或 CI 日志链接）；③ 若触及 D1–D10，每条附变红测试链接或变异证明。
- Reviewer 只看证据合入：无验收证据、无 Deferred 声明、无 Spec 引用的 PR 直接打回，不进入代码细节评审。
- Required checks（5 个，必须全部成功才允许合并）：static、migration-scan、scheduler-fault、contracts-dual、compose-smoke。`static` 一次安装后运行本地同一 `verify` 入口；其余四个 job 都只依赖 `static`，通过后各自隔离并行，static 失败则全部下游不运行。Compose 不等待三个 DB/契约 job，因此其中一项失败时 Compose 可能已经消耗构建与运行资源，但不改变合并门，也不共享用户数据或可变数据库。Compose 宿主不安装没有宿主消费者的依赖，镜像内仍真实冻结安装与构建，保留两轮全新卷 D7。含义见 `docs/design/13-p0-bootstrap-and-ci-rules.md §3–§4`。
- `scripts/check-gates-executable.mjs` 断言每条 enforced 门在 `ci/gates.json` 的 `enforced_by`（CI job 名 + evidence 文件）真实存在，跑在 `static` job 与本地 verify 的 gate-manifest 步之后。
