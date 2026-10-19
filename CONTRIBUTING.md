# 贡献指南（CONTRIBUTING）

> 本文件是 `AGENTS.md`「提交与 PR」与 `README.md`「任务与进度」的中文展开说明。
> 冲突按冲突矩阵裁决：行为/验收以 openspec/specs 为准，字段/路由/状态机/错误码以 docs/design+api+schema 为准，why 以 ADR 为准；矩阵见 `docs/README.md` 与 `openspec/README.md`。

## 1. 环境要求

- Node.js `>= 22`，pnpm `>= 10`（仓库当前 `packageManager: pnpm@11.25.0`，见 `package.json`）。
- Monorepo 编排：Turbo（当前 `turbo@2.11.9`），命令全部经由根 `package.json` 的 scripts 调用。
- 安装依赖：`pnpm install`（只需要执行一次，锁文件变更后重跑）；随后必须先跑 `pnpm build` 构建各 workspace 的 `dist/`（`apps/api` 经 tsx 直载 `@along/*` 的 `dist` 产物，无 `dist` 则 `pnpm dev` 起不来）。

真实可用命令（以 `package.json` 为准，禁止自创）：

| 用途                     | 命令                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| 本地启动                 | `pnpm dev`（`turbo run dev`；`apps/api` 3000 `ROLE=all`、`apps/web` 3100）                |
| 类型检查                 | `pnpm typecheck`（`turbo run typecheck`）                                                 |
| 单元测试                 | `pnpm test` / `pnpm test:unit`                                                            |
| 契约测试                 | `pnpm test:contracts`                                                                     |
| Lint                     | `pnpm lint`（`eslint . && turbo run lint`）                                               |
| 构建                     | `pnpm build`                                                                              |
| 依赖边界（D1）           | `pnpm depcruise`                                                                          |
| 契约校验（当前唯一可跑） | `openspec validate <name> --strict`（如 `openspec validate v0-safety-contract --strict`） |

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

- `pnpm typecheck` 与 `pnpm test`（含 `test:unit` / `test:contracts`）必须全部通过；任一红即合并不通过。
- 改了代码就要补或改对应的测试，即使没人要求。
- D1–D10 是合并门槛（见 `docs/design/13-p0-bootstrap-and-ci-rules.md §3`）：time-core 零依赖、展示禁算时间、唯一约束、只追加、空环境冒烟、契约双跑、取消后触发数 = 0、口径天花板，每条必有变红测试。
- S0 冻结别名禁入：`outbox_events`、`schedule_confirmed`、`SERVICE_NOT_READY`、`C-XXXX`、整句文本确认。

- 一键 verify：`node scripts/verify.mjs`（等价 `pnpm verify`），按序跑 `lint → typecheck → depcruise → 三个治理脚本 → test:unit → openspec validate --all --strict → format:check`，任一失败即停并报步名。`openspec/changes` 下无 active change 时该步提示跳过，也可用 `--skip openspec` 主动跳过。
- 红例含义：`lint/typecheck` 红=代码或类型坏；`depcruise` 红=越 D1 依赖边界；治理脚本红=门清单/冻结名/文案断言坏（看输出行）；`test:unit` 红=单元坏；`openspec validate` 红=change 的 proposal/tasks/spec 不一致；`format:check` 红=跑 `pnpm format` 后重提。

## 7. AI 辅助声明

- 使用 AI 辅助（代码/文档/测试）须在 PR 正文 `验收证据` 或 `Deferred 声明` 附近加一行声明，例如：`AI 声明：本 PR 由 <工具名> 辅助起草，已人工复核 design 引用与测试证据。`
- AI 生成内容同样受 S0 冻结与 D1–D10 约束；不确定的服务端行为标 `[INFERENCE]`，不猜字段/路由。

## 8. Review 证据与合并门

- PR 必须附：① CI 全绿链接；② 关键测试输出（粘贴或 CI 日志链接）；③ 若触及 D1–D10，每条附变红测试链接或变异证明。
- Reviewer 只看证据合入：无验收证据、无 Deferred 声明、无 Spec 引用的 PR 直接打回，不进入代码细节评审。
- Required checks（8 个，任一红即合并不通过）：gate-manifest、lint、depcruise、unit、migration-scan、scheduler-fault、contracts-dual、compose-smoke。含义见 `docs/design/13-p0-bootstrap-and-ci-rules.md §3–§4`。
