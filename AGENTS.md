# AGENTS.md

## 项目概览

TypeScript + Next.js（App Router）+ PostgreSQL 16 的云端个人助理；包管理用 pnpm + Turbo；校验用 zod；实时对话走 SSE。当前只有 `docs/`，无实现代码（目录随 #2 建出）。

- 服务端：TS 模块化单体，一个镜像三种角色 `api|worker|all`；Postgres 唯一事实源，Redis 延后不引入。
- 认证：Better Auth（自建 vs OIDC 二选一待 #1 拍板，细节 Deferred）。
- 待定不猜：目标市场、LLM 供应商、推送通道、计费、是否练仓颉（见 `docs/prd/04-acceptance-open-questions.md` D1–D8）。

## 常用命令

> 以下为占位，待 #2 建出目录后补齐可跑命令；当前唯一可跑的是 OpenSpec 校验。

- 安装依赖：`pnpm install`
- 本地启动：`pnpm dev`（`apps/api` 3000 `ROLE=all`、`apps/web` 3100；需 `DATABASE_URL`、`TZDB_VERSION`）
- 类型检查：`pnpm typecheck`
- 单元测试：`pnpm test`
- 契约校验：`openspec validate <name> --strict`（当前可跑，如 `openspec validate v0-safety-contract --strict`）

## 代码约定

- TypeScript 严格模式；模块按 `apps/api/src/modules/<name>/` 划分所有权，一模块一 schema 前缀。
- 跨模块只传 id，不直读对方表；除 confirm 单事务外禁跨模块事务，其余走 outbox。
- 安全内核 5 条（硬规则）：
  1. confirm 单事务：验 owner/pending/有效期 → 比 `presentation_hash` → 建 task → 写 `task_events.created` → 写 outbox → consumed，全回滚，重复回同一 task。
  2. 时间唯一权威 `time-core.normalize` 纯函数（零依赖，不读时钟/env/网络）；入口必问（缺年份/时区/时段就问）/模糊词挡（“左右/尽快/有空时”）；`/readyz` 类型化不降级。
  3. `task_events` 只追加，DB 禁 UPDATE/DELETE；`UNIQUE(task_id, fire_at)`；`recreated_from` 唯一。
  4. 取消赢过一切（`cancel_pending` 提交计时）+ 无回执不停终态（无 `schedule_receipt` 不标 `scheduled`，无撤销回执不标 `cancelled`）。
  5. 展示只读冻结字段，不换算不改写；口径只说已记录步骤，不承诺必达。
- S0 冻结（#14）：错误码用 design 系（`PRESENTATION_MISMATCH 409`、时间四错 `422`、`BUDGET 429`）；事件词用 design/07 封闭集；表统一 `outbox`；v0 只认按钮确认；简报只读投影不建表。
- 引用外部蓝图一律用 B00–B06 / AF 代号，不复制外部产物原文；服务端行为均为[INFERENCE]。

## 测试要求

- 改了代码就要补或改对应的测试，即使没人要求。
- D1–D10 是合并门槛（见 `docs/design/13-p0-bootstrap-and-ci-rules.md` §3）：time-core 零依赖、展示禁算时间、唯一约束、只追加、空环境冒烟、契约双跑、取消后触发数=0、口径天花板，每条必有变红测试。
- 提交前类型检查和测试必须全部通过；任一红即合并不通过。

## 文档索引

- 先读 [文档中心](docs/README.md)，再读 [v0 垂直切片](docs/design/03-v0-vertical-slice.md)、[CI 死规矩](docs/design/13-p0-bootstrap-and-ci-rules.md)、[验收与待决](docs/prd/04-acceptance-open-questions.md)、[Schema 索引](docs/schema/README.md)、[API 索引](docs/api/README.md)。
- `docs/design/` 为设计真源，`docs/prd/` 跟随；`openspec/specs/` 只写 SHALL + Scenario 并引用 design 章节，不复制字段/路由表；冲突时 design 优先。
- 改 `docs/design/` 的 PR 同步 `docs/prd/` 与 `docs/README.md` 索引。

## 不要碰

- `infra/migrations/` 下已合并的迁移文件（错了另起新迁移，不改旧文件）。
- `task_events` 表的 UPDATE/DELETE（只追加是 DB 级红线）。
- S0 冻结的别名：`outbox_events`、`schedule_confirmed`、`SERVICE_NOT_READY`、`C-XXXX`、整句文本确认。
- 任何 `.env*` 文件和真实 secret/token/DSN；需要新的环境变量时告诉我，不要自己写。

## 提交与 PR

- main 禁止直推，一律走 issue → 分支 → PR；分支名 `<type>/<N>-<slug>`，OpenSpec-only 用 `docs/<N>-spec-<slug>`。
- issue/PR 正文直接用 `.github/` 官方模板（字段齐了再填，不要自创格式）：issue 选 `.github/ISSUE_TEMPLATE/task.md`（通用任务）或 `decision.md`（方案拍板）；PR 用 `.github/PULL_REQUEST_TEMPLATE.md`（关联/Spec/验收证据/Deferred 声明/OpenSpec change）。
- 提交信息用英文，格式 `type(area): description`（如 `docs(governance): add repo AGENTS (#16)`）；PR 标题同格式。
- 一个 PR 只做一件事；squash 合并；仅收口写 `Closes #N`，其余 `Refs #N`。
