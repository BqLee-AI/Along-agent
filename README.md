# Along-agent

云端多租户 personal agent：Web 先行，后期再做桌面常驻壳。

## 这是什么

v0 范围一段：用户说清一件事和一个时间 → 服务端算出唯一的触发瞬间 → 用户点头 → 到点私下响一次；任何一步没把握就停下来说明白，绝不报成功。

诚实口径：只报告系统记录到的步骤，不承诺到点一定响；取消后触发数 = 0 为一级指标。

许可证：Apache-2.0（见 [#6](https://github.com/BqLee-AI/Along-agent/issues/6)）。

## Spec 入口

- [文档中心](docs/README.md)：`docs/design/` 为真源，`docs/prd/` 跟随；[OpenSpec 行为契约](openspec/README.md)管 SHALL + Scenario。
- 必读：[v0 垂直切片](docs/design/03-v0-vertical-slice.md)、[P0 开工与 CI 死规矩](docs/design/13-p0-bootstrap-and-ci-rules.md)、[验收与待决](docs/prd/04-acceptance-open-questions.md)、[Schema 索引](docs/schema/README.md)。

## 任务与进度

- [Issues](https://github.com/BqLee-AI/Along-agent/issues)：中文，spec-driven + issue-driven。
- 里程碑：M0 P0 准出（#1、#6、#2、#3 四基准）、M1 v0/P1 准出（#7、#4、#8、#9、#10、#5、#3 五十表达）、M2 P2 Spike 结案。
- 当前阻塞已解除：[#1 P0 决策](https://github.com/BqLee-AI/Along-agent/issues/1)已定（Better Auth 自建 + Next.js）；待办见 [#6](https://github.com/BqLee-AI/Along-agent/issues/6)（许可证文件替换 + 中文名）。

issue → Spec 章节 → OpenSpec change（如需）→ 分支 → PR → CI 六步：

1. 从 issue 领任务，Spec 字段的路径 + 章节号必填；有行为契约再建 change（OpenSpec-only PR 先于实现 PR）。
2. 分支名 `<type>/<N>-<slug>`，如 `feat/7-commitments-migrations`；OpenSpec-only 用 `docs/<N>-spec-<slug>`；禁止直推 main（约定式，私有免费版无强制保护）。
3. 提交信息与 PR 标题统一用英文，格式 type(area): description（如 docs(governance): add repo AGENTS (#16)）；issue/PR 正文用中文并套用 .github/ 模板。
4. 改 design 的 PR 同步 prd 和 docs/README 索引；一个 issue 可多 PR，只有收口 PR 写 `Closes #N`（收口含 `openspec archive`），其余一律 `Refs #N`。
5. D1-D10 是合并门槛，见 [CI 死规矩](docs/design/13-p0-bootstrap-and-ci-rules.md#3-ci-死规矩required每条必有变红测试)。

模板：[issue 模板](.github/ISSUE_TEMPLATE/)、[PR 模板](.github/PULL_REQUEST_TEMPLATE.md)。

## 仓库布局

`apps/api`（服务端：api|worker|all 三角色入口）、`apps/web`（Next.js App Router）；`packages/time-core|scheduler-core|notifier-core|stream-protocol|contracts`；详见 [design/01 §2](docs/design/01-tech-stack-and-repo-structure.md#2-monorepo-布局required)。

## 本地运行

- 工具链：Bun `1.4.2`（workspaces + 单一 `bun.lock`），Oxlint `1.89.0`、Oxfmt `0.74.0`；安装依赖：`bun install --frozen-lockfile`。
- 本地启动：`bun run dev`（先构建依赖包；`apps/api` 3000 `ROLE=all`、`apps/web` 3100）。
- 构建：`bun run build:packages` 构建共享包；`bun run build` 先包后应用；`bun run build:api` 构建 API 及其依赖。
- 检查：`bun run verify`；类型与 lint 可分别运行 `bun run typecheck`、`bun run lint`；格式修复/阻塞检查为 `bun run format` / `bun run format:check`。
- 测试：`bun run test:unit`（非数据库）、`bun run test:contracts`（API 进程内/HTTP 双跑及契约包）、`bun run test:integration`（全部 9 个真实数据库文件）、`bun run test:scheduler`（D9 指定集）；数据库测试需 PostgreSQL 16 与测试环境，详见 [贡献指南](CONTRIBUTING.md)。
- 契约校验：`openspec validate <name> --strict`（如 `openspec validate v0-safety-contract --strict`）
- 环境变量：`DATABASE_URL`、`TZDB_VERSION`（缺失则 `/readyz` 503 `TZDB_UNAVAILABLE`，属预期行为）。

## 安全

- 不提交 secret、`.env`、用户数据；配置走 `.env.example` 占位。
- 不复制外部产物原文、token、DSN。

## 许可证

见 [LICENSE](LICENSE)。
