# Along-agent

云端多租户 personal agent：Web 先行，后期再做桌面常驻壳。

## 这是什么

v0 范围一段：用户说清一件事和一个时间 → 服务端算出唯一的触发瞬间 → 用户点头 → 到点私下响一次；任何一步没把握就停下来说明白，绝不报成功。

诚实口径：只报告系统记录到的步骤，不承诺到点一定响；取消后触发数 = 0 为一级指标。

许可证：Apache-2.0（见 [#6](https://github.com/BqLee-AI/Along-agent/issues/6)）。

## Spec 入口

- [文档中心](docs/README.md)：`docs/design/` 为真源，`docs/prd/` 跟随；[OpenSpec 行为契约](openspec/README.md)管 SHALL + Scenario。
- [本人目标内委托与授权](docs/design/20-goal-scoped-delegation.md)（#104/#105，Proposed）：正常步骤自主执行，只问实质缺口或新增影响；现行逐项批准/单登记/断流策略保留于 legacy，规范不启用新权限或更改安装。
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
- 开发启动：`bun run dev`（先构建依赖包；`apps/api` 3000 `ROLE=all`、`apps/web` 3100），不等同正式 native 本机安装。
- 构建：`bun run build:packages` 构建共享包；`bun run build` 先包后应用；`bun run build:api` 构建 API 及其依赖。
- 检查：`bun run verify`；类型与 lint 可分别运行 `bun run typecheck`、`bun run lint`；格式修复/阻塞检查为 `bun run format` / `bun run format:check`。
- 测试：`bun run test:unit`（非数据库与非 native 合同）、`bun run test:contracts`（Linux x64/WSL + Docker，当前生产 native 构建、自带隔离 PG、本地/签名 HTTP 消费者、原 healthz/契约包）、`bun run test:integration`（全部真实数据库文件）、`bun run test:scheduler`（D9 指定集）。契约入口不使用已有数据库或个人模型配置；其余数据库测试需 PostgreSQL 16 与明确测试环境，详见 [贡献指南](CONTRIBUTING.md)。
- 契约校验：`openspec validate <name> --strict`（如 `openspec validate v0-safety-contract --strict`）
- 环境变量：`DATABASE_URL`、`TZDB_VERSION`（缺失则 `/readyz` 503 `TZDB_UNAVAILABLE`，属预期行为）。
- 正式本机安装：按[本机生命周期指南](docs/local-lifecycle.md)在交互终端执行 `bun --no-env-file run local:init --new`（原部署用 `--adopt`），随后用 `local:start`、`local:stop` 和显式 `local:upgrade`。四入口共用 checkout 外私有配置；不依赖仓库 `.env`，不自动开户。合同与验收边界见[本地生命周期设计](docs/design/15-r1-local-lifecycle.md)。

## 受管项目资料与文档批准

- 用正式 Linux x64 镜像运行 API/native/MCP。部署者通过 `WORKSPACE_REGISTRY_FILE` 指定 JSON 登记文件；未配置、无效或相互重叠的工作区不开放，不影响无工作区的业务。
- 登记按登录用户隔离，只开放逐项列出的相对文件路径。`writable_paths` 必须是 `readable_paths` 的子集；文件必须为普通、非链接、严格 UTF-8 文本。模型、Web 和 MCP 不取得宿主绝对路径。
- Compose 的 `workspace_data` 卷挂载到 `/var/lib/along/workspaces`。先在卷中放置有权使用的资料和目标文件、设置受控目录权限，再通过进程环境传入登记文件位置；登记在 API 启动时加载，不提供 Web 新增目录或热更新接口。

登记文件示例；将 `owner_id` 换成实际登录用户 ID，目录及文件须已存在：

```json
[
  {
    "workspace_id": "project-brief",
    "label": "项目资料",
    "owner_id": "<owner-id>",
    "root": "/var/lib/along/workspaces/project-brief",
    "readable_paths": ["sources/decision.md", "brief.md"],
    "writable_paths": ["brief.md"]
  }
]
```

- 部署者配置 `HARNESS_MODEL_BASE_URL`、`HARNESS_MODEL` 和需要时的 `HARNESS_MODEL_API_KEY`；用户在 Web 选择工作区，不填写 provider/key。`HARNESS_MAX_ITERATIONS` 默认 `24`、`HARNESS_MAX_TOKENS` 默认 `64000`；两者须为正安全整数，在 Run 接受时冻结，批准后继续不重置累计使用量。
- 身份认证仍使用既有 `BETTER_AUTH_SECRET`，由部署者传入 API。模型 transport 显式关闭并行工具提议；provider 若仍返回多个调用则明确失败，不截取第一项继续执行。
- Web 中的完整预览冻结原始版本和确切新内容。确认只授权，不立即写文件；返回原会话点“继续”，由原 Run 执行唯一写调用，再以新读取核对结果。拒绝、版本冲突和结果未知不是保存成功；文件系统与 PostgreSQL 不构成原子事务，未知结果不自动重写。
- 发布时先停旧写者、应用迁移 `0016`，再成套发布 TS/native/Web；只执行 `harness/v2`。旧 task 快照仅作受限读取迁移，不给历史 Run 增加工作区。详情见 [R1 设计](docs/design/14-r1-document-task-loop.md)、[HTTP 合同](docs/api/README.md#8-r1-工作区与文档批准-required)。
- 目录边界依赖受管部署和协作写者；不把任意非协作外部写入者描述成受操作系统原子 CAS 保护。发布失败停写前滚，不降回不理解文档结果的旧写者。

## 安全

- 不提交 secret、`.env`、用户数据；配置走 `.env.example` 占位。
- 不复制外部产物原文、token、DSN。

## 许可证

见 [LICENSE](LICENSE)。
