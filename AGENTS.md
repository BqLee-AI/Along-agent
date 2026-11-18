# AGENTS.md

## 项目概览

TypeScript + Next.js（App Router）+ PostgreSQL 16 的云端个人助理；包管理与运行用 Bun 1.4.2 workspaces（单一 bun.lock），根 scripts 显式编排依赖，不使用 Turbo；校验用 zod；实时对话走 SSE。

- 服务端：TS 模块化单体，一个镜像三种角色 `api|worker|all`；Postgres 唯一事实源，Redis 延后不引入。
- 认证：Better Auth 自建 credential（#1 已定，单租户；v0 端点只暴露 `GET /me`）。
- 布局：`apps/api`（服务端入口）、`apps/web`（Next.js）；`packages/time-core|scheduler-core|notifier-core|stream-protocol|contracts`；详见 `docs/design/01-tech-stack-and-repo-structure.md §2`。
- 待定不猜：目标市场、LLM 供应商、推送通道、计费（见 `docs/prd/04-acceptance-open-questions.md`）。仓颉唯一 Harness 与 TS 长期能力/业务/存储分工见 design/09、11；R1 受管工作区与文档批准合同见 design/14，实现、受控合同和真实材料验收分别取证。

## 常用命令

> 以根 `package.json` scripts 为准，禁止自创。

- 安装依赖：`bun install --frozen-lockfile`
- 构建：`bun run build:packages`；`bun run build` 先包后应用，`bun run build:api` 构建 API 及依赖；其他需要产物的入口先构建依赖包。
- 本地启动：`bun run dev`（`apps/api` 3000 `ROLE=all`、`apps/web` 3100；需 `DATABASE_URL`、`TZDB_VERSION`）
- 类型检查：`bun run typecheck`；Lint：`bun run lint`（Oxlint 1.89.0）
- 测试：`bun run test:unit`、`bun run test:contracts`（API 进程内/HTTP 双跑及契约包）、`bun run test:integration`（全部 DB 集成文件）、`bun run test:scheduler`（D9 指定集）；使用 `bun:test`，保持文件级隔离，不以文件内 concurrent 替代。
- 统一检查：`bun run verify`；格式修复/阻塞检查：`bun run format` / `bun run format:check`（Oxfmt 0.74.0）。
- 契约校验：`openspec validate <name> --strict`（如 `openspec validate v0-safety-contract --strict`）

## 代码约定

- TypeScript 严格模式；`apps/api/src/features/<name>/` 划分业务所有权，`agent/` 持有跨功能操作与执行状态；功能通过公共用例和投影协作。
- 跨模块资源关联 ID-first；允许同步公共用例、显式 DTO 与只读投影，不直读对方私有表。确认创建或取消保持受控单事务，其他可靠异步命令/事件走 outbox，不将公共读取/同步调用强制入队；D1 只证明存储实现导入边界，不证明 SQL 所有权（见 design/02、04、ADR 0009）。
- 授权边界见 `docs/design/20-goal-scoped-delegation.md` 和 OpenSpec 主规范；变更记录在 `openspec/changes/archive/2026-11-12-refactor-assistant-capability-authorization/`。下列安全内核保留；“全部写入必须按钮/只提议”和 wall 缺字段必问仅约束 legacy profile。新 profile 的本人委托内设置、明确提醒、受管资料正常写入无需逐项审批，严格 elapsed 不问无关时区；实质缺口/新增影响才问，硬资格不能按钮突破。旧 pending 不自动消费；TS/native/Web 配套，不能模拟 confirm。
- 安全内核 5 条（硬规则）：
  1. confirm 创建分支单事务：验 owner/pending/有效期 → 比 `presentation_hash` → 建 task → 写 `task_events.created` → 写 outbox → consumed，全回滚，重复回同一 task。取消分支经相同冻结校验后，同事务调用 tasks 公共取消用例并 consumed，取消状态/事件/命令保持原子；重复回原目标，仍须遵守撤销回执门（design/06）。
  2. 时间唯一权威为 `time-core.normalize` 纯函数（零依赖，不读时钟/env/网络）；wall 入口缺关键年份/时区/时段才问，模糊词挡（“左右/尽快/有空时”）；拟议 elapsed 按可信 UTC 锚纯计算，不伪造规则版本；`/readyz` 类型化不降级（design/05、20）。
  3. `task_events` 只追加，DB 禁 UPDATE/DELETE；`UNIQUE(task_id, fire_at)`；`recreated_from` 唯一。
  4. 取消赢过一切（`cancel_pending` 提交计时）+ 无回执不停终态（无 `schedule_receipt` 不标 `scheduled`，无撤销回执不标 `cancelled`）。
  5. 展示只读冻结字段，不换算不改写；口径只说已记录步骤，不承诺必达。
- S0 冻结（#14）：错误码用 design 系（`PRESENTATION_MISMATCH 409`、时间四错 `422`、`BUDGET 429`）；事件词用 design/07 封闭集；表统一 `outbox`；v0/legacy 批准只认按钮确认，新 profile 授权按 design/20；简报只读投影不建表。
- 引用外部蓝图一律用 B00–B06 / AF 代号，不复制外部产物原文；服务端行为均为[INFERENCE]。

## 测试要求

- 代码变更必须有对应行为覆盖；新增或改变行为、修复重要缺陷时补或改测试，保持行为的重构可复用已验证的充分覆盖。
- 按每项行为自主选择测试策略，不逐项询问用户是否使用 TDD；明确行为默认测试先行，未知能力先最小真实实验，纯文档不强套 TDD。只有业务合同存在实质歧义才升级询问；不能因测试麻烦跳过验证。
- 测试保护合同和可观察结果；测试先行须实际观察目标行为缺失导致的 Red，再最小实现 Green、绿色下重构。环境失败、事后补测或变异证据不得冒充 TDD。
- 在现有 PR Verification 中如实记录策略、Red/Green 或替代依据及真实路径验证；不要求红色 commit，不以测试通过替代真实验收。详细规则见 [CONTRIBUTING §6.1](CONTRIBUTING.md#61-测试策略与测试先行)。
- D1–D10 是合并门槛（见 `docs/design/13-p0-bootstrap-and-ci-rules.md` §3）：time-core 零依赖、展示禁算时间、唯一约束、只追加、空环境冒烟、契约双跑、取消后触发数=0、口径天花板，每条必有变红测试。
- 提交前类型检查和测试必须全部通过；任一红即合并不通过。

## 文档索引

- 先读 [文档中心](docs/README.md)，再读 [v0 垂直切片](docs/design/03-v0-vertical-slice.md)、[CI 死规矩](docs/design/13-p0-bootstrap-and-ci-rules.md)、[验收与待决](docs/prd/04-acceptance-open-questions.md)、[Schema 索引](docs/schema/README.md)、[API 索引](docs/api/README.md)。
- 冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准。
- 改 `docs/design/` 的 PR 同步 `docs/prd/` 与 `docs/README.md` 索引。
- 流程细节见 [CONTRIBUTING](CONTRIBUTING.md)，本文件只保留机器约束。

## 不要碰

- `infra/migrations/` 下已合并的迁移文件（错了另起新迁移，不改旧文件）。
- `task_events` 表的 UPDATE/DELETE（只追加是 DB 级红线）。
- S0 冻结的别名：`outbox_events`、`schedule_confirmed`、`SERVICE_NOT_READY`、`C-XXXX`、整句文本确认。
- 任何 `.env*` 文件和真实 secret/token/DSN；需要新的环境变量时告诉我，不要自己写。

## 提交与 PR

- 提交信息与 PR 标题统一用英文，格式 type(area): description（如 docs(governance): add repo AGENTS (#16)）；issue/PR 正文用中文并套用 .github/ 模板。
- main 禁止直推，一律走 issue → 分支 → PR；分支名 `<type>/<N>-<slug>`，OpenSpec-only 用 `docs/<N>-spec-<slug>`；一个 PR 只做一件事；squash 合并；仅收口写 `Closes #N`，其余 `Refs #N`。
- 细节见 [CONTRIBUTING](CONTRIBUTING.md) §2–§5。
