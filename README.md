# Along-agent

Along-agent 是一个以仓颉为执行核心的自托管 Web 个人助理。你可以在对话里安排提醒、查询今天的安排，或让助理整理你明确开放的项目资料。回到原会话或活动页可以核对实际结果。

例如，在对话里发「10 分钟后提醒我检查构建结果」。指令明确且在授权范围内时，助理可以创建提醒；如果时间有歧义，它会先澄清。**已创建、已排期、已触发和已生成站内通知是不同的状态**，助理不会把一句回复当成投递回执。

## 快速开始

### 环境要求

- 仓库访问权限、Git、Bun **1.4.2**。
- 正式本机安装：Windows、Docker Desktop 的 **Linux x64** 引擎、Docker Compose **2.24.4+**。首次安装需要联网下载依赖、镜像和构建工具。

### 首次安装与体验

在 PowerShell 中克隆仓库并安装依赖：

```powershell
git clone https://github.com/BqLee-AI/Along-agent.git
cd Along-agent
bun install --frozen-lockfile
```

只有确认没有需要保留的原安装时，才在交互终端运行：

```powershell
bun --no-env-file run local:init --new
bun --no-env-file run local:start
```

1. 打开启动命令输出的 Web 地址（默认端口 `3100`），按「首次建号」创建管理员。使用输出的地址，不要自行互换 `localhost` 与 `127.0.0.1`。
2. 登录后，在「设置 → 模型服务」添加接入并保存，设置默认模型，或在发送时显式选模。能够登录不代表模型已经可用。
3. 打开「对话」，发送上面的十分钟提醒示例。去「提醒」看任务，在活动页核对已记录的状态。试用普通对话或提醒不需要先登记资料；要处理文件，再按[本机使用指南](docs/guides/local-lifecycle.md)登记受管工作区。

**已有安装不要用 `--new`。** 按[本机使用指南](docs/guides/local-lifecycle.md)接入原部署，保留原身份、配置与数据。日常仍用 `bun --no-env-file run local:start` 启动，用 `bun --no-env-file run local:stop` 停止；升级时用同一份私有配置执行 `bun --no-env-file run local:upgrade`。

## 配置与环境变量

正式本机安装从仓库外的私有 JSON 读取配置，默认是 `%LOCALAPPDATA%\Along-agent\local.json`，不依赖仓库 `.env`。若用 `--config` 指定路径，初始化、启停、账户维护和升级都要使用同一个文件。模型接入由登录用户在 Web 中设置；资料范围由本机维护登记。不要提交私有配置、真实凭据、备份或用户资料。

直接运行开发进程时，按需在进程环境中设置以下变量；正式本机安装不需要照着这份清单手填。

- `DATABASE_URL`：API 的 PostgreSQL 16 连接串，开发时请指向专用开发库。
- `TZDB_VERSION`：必须匹配[随仓库提供的时间资源](apps/api/resources/time/fixture-v1.json)中的 `tzdb_version`（`fixture-v1`）。缺失、版本不匹配或资源不可用时，`/readyz` 返回 `503 TZDB_UNAVAILABLE`。
- `BETTER_AUTH_SECRET`、`APP_ORIGIN`：登录使用的认证密钥和 Web 来源。用开发专用密钥，来源要与浏览器访问地址一致。
- `API_BASE`：Web 服务端连接 API 的地址，默认 `http://127.0.0.1:3000`。浏览器通过 Web 同源代理访问 API。
- `MODEL_PROVIDER_ENCRYPTION_KEY`、`WORKSPACE_REGISTRY_FILE`：分别用于加密模型凭据和加载受管资料登记。正式本机安装由私有配置管理。

## 核心功能与边界

- **对话与历史**：流式对话，支持在同一会话追问、查看原消息和各次运行的结果。刷新或重登只读取记录，不会重新发送、批准或继续。
- **今日与提醒**：查看今日简报，用自然语言创建一次性提醒，在提醒与活动页追踪状态、取消任务。时间由服务端归一，通知走站内，不承诺必达，也不是系统推送。
- **受管项目资料**：在本人已登记范围内检索、修改或创建获准的文件，不访问任意宿主路径。需要校样批准时，批准只授予权限，不保存文件；回原会话明确继续后，再核对实际写入和回读结果。
- **本人偏好与记忆**：保存或清除默认时区，查看、更正或停止使用本人的记忆。能查看旧会话，不代表所有历史都会提供给模型。
- **可选连接**：部署者启用并授权后，飞书机器人可读取单篇获准的 Docx，不支持搜索、修改或发送消息。[对话附件与私有产物](docs/design/24-native-office-delivery.md)另行受控，不是默认安装功能。

普通对话可在本人委托范围内执行明确动作，无需逐项点批准；信息不足或影响超出授权时才停下来询问。保留原审批流程的提醒、资料快捷入口仍按该流程操作。无论走哪条路径，**运行结束不等于任务已完成**：以任务记录、文件效果或其他实际回执为准；结果未知时先查原记录，不要盲目重做。

## 技术栈与项目结构

普通对话由 **仓颉原生 Harness** 执行。它组织模型上下文，处理模型提出的工具调用，控制执行预算，并在安全点暂停和恢复。**TypeScript / Bun** 提供 HTTP、SSE、模型传输、授权、工具效果和后台调度。**PostgreSQL 16** 保存任务、回执和运行状态。Web 工作台使用 **Next.js / React**。

```text
apps/
  web/              Web 工作台、会话与提醒页面
  api/              HTTP API、业务模块、调度和后台投递
  harness/          仓颉原生执行循环与恢复
  embedding/        可选的只读意图路由编码服务
packages/
  contracts/        API 与执行协议的共享定义
  stream-protocol/  SSE 事件协议
  time-core/        确定性的时间归一
  scheduler-core/   调度规则
  notifier-core/    通知与回执规则
infra/              PostgreSQL 迁移、Docker 与 Compose
scripts/            本机安装、构建和验证入口
openspec/           行为规范与变更
docs/               设计、使用指南与验收记录
```

## 开发指南

**日常使用走 `local:start`，改代码走 `dev`。** 开发启动不会初始化数据库，也不能用来证明正式仓颉、真实模型或资料链路可用。先确认 `psql` 可用，准备独立的 PostgreSQL 16 开发库，并在终端进程环境中设置 `DATABASE_URL` 和 `TZDB_VERSION`。确认 `DATABASE_URL` 指向空的开发库后，应用迁移并启动 Web 和 API：

```bash
bash scripts/db/apply.sh
bun run dev
```

默认 Web 在 `http://localhost:3100`，API 在 `http://127.0.0.1:3000`。`/healthz` 用于确认进程可响应，`/readyz` 用于检查服务依赖是否就绪；两者都不证明模型可用。分进程调试见 [Web 说明](apps/web/README.md)，正式原生构建见 [Harness 说明](apps/harness/README.md)。

- **构建**：`bun run build`；只构建 API 与依赖用 `bun run build:api`。
- **本地检查**：`bun run verify`；也可单独运行 `bun run typecheck`、`bun run lint`、`bun run format:check`。
- **单元测试**：`bun run test:unit`。
- **正式契约测试**：`bun run test:contracts`，需 Linux x64 / WSL 与 Docker，从源码构建正式 Harness 并使用隔离数据库。
- **数据库与调度测试**：`bun run test:integration` 或 `bun run test:scheduler`，使用明确指定的测试数据库。

修改业务前（包括 AI 辅助修改），先读 [OpenSpec 行为规范](openspec/README.md) 和对应的 [设计、API 与 Schema](docs/README.md)。提醒时间由 `time-core` 归一，Web 只展示服务端冻结结果；确认、取消和文件写入的成功状态必须来自真实回执，不能由界面或模型补造。跨模块通过公开用例或只读投影协作，不直接读取对方私有表。

## 贡献

从 [Issue](https://github.com/BqLee-AI/Along-agent/issues) 开始，写明对应规范章节；改变行为时先提交 OpenSpec-only PR，再提交实现。一个 PR 只做一件事，不直推 `main`。提交信息与 PR 标题统一用英文，格式 type(area): description（如 docs(governance): add repo AGENTS (#16)）；issue/PR 正文用中文并套用 .github/ 模板。

分支命名、验证要求和 PR 模板见 [贡献指南](CONTRIBUTING.md)；安全问题按 [安全报告流程](SECURITY.md) 处理。

## 许可证

项目采用 [Apache License 2.0](LICENSE)。第三方组件及随附分发物按各自的许可声明使用。
