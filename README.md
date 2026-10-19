# Along-agent

云端多租户 personal agent：Web 先行，后期再做桌面常驻壳。当前只有 `docs/`，无实现代码。

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
3. PR 标题 `<type>(<area>): <中文摘要> (#N)`，squash 合并；正文必填 `Refs #N` 或 `Closes #N`、`Spec: <路径> §章节`、验收证据、未触碰的 Deferred 声明、`OpenSpec change` 路径或无的原因。
4. 改 design 的 PR 同步 prd 和 docs/README 索引；一个 issue 可多 PR，只有收口 PR 写 `Closes #N`（收口含 `openspec archive`）。
5. D1-D10 是合并门槛，见 [CI 死规矩](docs/design/13-p0-bootstrap-and-ci-rules.md#3-ci-死规矩required每条必有变红测试)。

模板：[issue 模板](.github/ISSUE_TEMPLATE/)、[PR 模板](.github/PULL_REQUEST_TEMPLATE.md)。

## 仓库布局

见 [design/01 §2](docs/design/01-tech-stack-and-repo-structure.md#2-monorepo-布局required)，目录随 #2 建出。

## 本地运行

- 端口占位：`apps/api` 3000（`ROLE=all`）、`apps/web` 3100。
- 环境变量占位：`DATABASE_URL`、`TZDB_VERSION`（缺失则 `/readyz` 503 `TZDB_UNAVAILABLE`）。
- 运行命令待 #2 合并后补。

## 安全

- 不提交 secret、`.env`、用户数据；配置走 `.env.example` 占位。
- 不复制外部产物原文、token、DSN。

## 许可证

见 [LICENSE](LICENSE)。
