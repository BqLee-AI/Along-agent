# 01. 技术栈与仓库结构设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：服务端/前端技术栈选型（已确认 vs 待定）、monorepo 布局、包依赖方向、复用优先级
- **不包含**：模块拆分判据（见 02）、API 路由表（见 10）、表字段（见 schema 组）、Spike 细节（见 11）、CI 死规矩实现（见 13）
- **阶段标签**：v0 MVP 全链路适用；P1 起五缝接口化后仍然有效

## 标记约定

- Observed：来自蓝图与开源参考的可确认事实（B00–B06 / AF）
- Required：v0 必须遵守的硬约束
- Proposed：建议做法
- Deferred：推迟决策，本文档不猜字段/不下结论

## 1. 选型总表：已确认 vs 待定

### 1.1 已确认（Required）

| 层级 | 选型 | 来源 | 说明 |
| --- | --- | --- | --- |
| 服务端语言 | TypeScript（Node 20 LTS+） | Required（合同） | TS 模块化单体，一个镜像 `api\|worker\|all` 三角色；time-core 为服务端纯函数子集 |
| 唯一事实源 | PostgreSQL 16+ | Required；AF 三硬约束之一（Observed, AF§5） | Redis 仅加速且延后（v0 不引入）；业务状态一律以 PG 约束为准 |
| Web 前端 | Next.js（App Router），RSC 开、Turbopack 开（默认配置） | Required（P0 冻结） | Web 先行，后用 Electron 套同一份 Next.js；v0 只做 Web 单端；偏离默认配置时另开 docs PR 说明 |
| 认证 | Better Auth 自建 credential | Required（已定） | D7 空环境冒烟不依赖外部 IdP；v0 单租户；v0 端点只暴露 `GET /me` |
| 实时对话 | SSE（`text/event-stream`） | Required | WS + `ws-ticket` P2 起；Web Push 仅兜底 |
| 校验 | zod（前后端同源） | Required | `packages/contracts`、`packages/stream-protocol` 版本化 zod；卡片/事件名开工对照 `thread-stream.schema.json`（AF§7） |
| 部署形态 | 单镜像 + compose 冒烟（起步） | Required；AF 自托管（Observed, AF§2/§5） | 一个镜像三种角色 `api\|worker\|all`（对标 AF `all/control/worker`）；做大后迁 K8s（Deferred 细节） |
| 包管理/构建 | pnpm + Turbo | Proposed | pnpm monorepo，单锁文件 |
| 可观测 | OpenTelemetry + 结构化日志 + `request_id` 全链路 | Required | v0 先 OTel+日志；PostHog/Sentry 为 Deferred |

### 1.2 待定（Deferred，一律不猜）

| 待定项 | 候选 | 决策点 | 本文档态度 |
| --- | --- | --- | --- |
| 目标市场/合规 | 数据驻留、隐私条款 | Deferred | 不设字段 |
| 是否练仓颉 | CangjieMagic 是否进入生产路径 | P1 并行 Spike S1–S3，P2 末结案 | v0–P3 不用（见 11） |
| 推送通道 | Web Push 供应商、邮件/短信 | Deferred | v0 只站内通知 + 活动页 |
| LLM 供应商/计费 | provider、模型路由、额度 | Deferred | 预算字段只定语义（见 09），不绑定供应商 |
| 向量库/RAG | pgvector vs 独立向量库 | P2+ | v0 不做 RAG |

## 2. Monorepo 布局（Required）

```text
Along-agent/
  apps/
    api/                    # TS 模块化单体入口：api|worker|all 三角色
      src/
        main.ts             # ROLE=api|worker|all 分发
        routes/             # REST 路由（真源见 10）
        sse/                # SSE 聚合与断线恢复
        worker/             # Scheduler claim/lease/fencing + Notifier 投递
    web/                    # Next.js App Router（Web 先行；后被 Electron 套同一份）
      app/
        (auth)/             # login/callback
        (main)/             # brief/chat/tasks/approvals
        (public)/           # landing/downloads/share
  packages/
    contracts/              # 跨模块契约：zod + JSON Schema + 契约测试（进程内/远程同一套）
    stream-protocol/        # SSE/AG-UI 投影版本化 zod（对照 thread-stream.schema.json）
    time-core/              # 纯函数 normalize（禁时钟、禁 agent-runtime 依赖）
    agent-runtime/          # TsAgentRuntime（见 09）
    tool-gateway/           # ToolGateway 白名单+zod+风险分级+审计（见 02）
    scheduler-core/         # schedule/claim/cancel 领域逻辑（worker 角色执行）
    notifier-core/          # send→回执+幂等
    connector-vault/        # secret 引用（v0 仅接口+Fake）
  spikes/
    cangjie-runtime/        # 第二实现隔离区（见 11），永不直连业务库
  infra/
    docker/                 # 单镜像 Dockerfile
    compose/                # compose 冒烟（见 13）
    migrations/             # PG 迁移（UNIQUE/append-only 约束落此）
  docs/
    design/                 # 本目录（真源）
    prd/                    # 跟随
```

### Electron 套壳预留（Proposed，v0 不做）

- 远期用 Electron 套同一份 Next.js；v0 只做 Web 单端。
- `apps/web` 构建产物可被 Electron `web-runtimes/` 直接 serve；IPC 命名预留 `along-<domain>:<action>`，v0 不实现任何 IPC。

## 3. 依赖方向（Required，CI 死规矩前身）

```text
apps/api ──depends──▶ packages/{contracts, stream-protocol, agent-runtime,
                        tool-gateway, scheduler-core, notifier-core,
                        connector-vault, time-core}
packages/agent-runtime ──depends──▶ packages/{contracts, time-core}
packages/scheduler-core ──depends──▶ packages/{contracts, time-core}
packages/{tool-gateway, notifier-core, connector-vault} ──depends──▶ packages/contracts
packages/time-core ──depends──▶ （零依赖：只用 IANA TZDB 只读数据 + 纯函数）
packages/contracts ──depends──▶ zod（仅此）
```

死规矩（在 13 落 CI）：

1. `time-core` 禁止导入 `agent-runtime`、禁止读取系统时钟、禁止访问 `process.env`/网络（纯函数）。
2. 展示层（`apps/web` + SSE 投影）禁止调用 `normalize` 之外的任何时间换算，禁止自行 `Date` 运算拼 `fire_at_utc`。
3. `spikes/cangjie-runtime` 禁止依赖 `apps/api` 与业务表（见 11）。
4. 所有跨模块引用只传 `id`（见 02），禁止跨 schema 直读表。

## 4. 复用优先（Proposed → Required）

| 优先级 | 内容 | 说明 |
| --- | --- | --- |
| P0 复用 | zod 契约、`code/data/msg/error` envelope、`request_id`+幂等键 | 全接口统一（见 10） |
| P0 复用 | `normalize(wall_time,timezone_id,fold_choice,ruleset)` 签名与四基准测例 | B06§4 开工版冻结 |
| P1 复用 | `packages/stream-protocol` 事件词汇 | AG-UI 待对照 `thread-stream.schema.json`（AF§7）；事件名开工前对照一次 |
| P1 复用 | a13n `agent/skill/prompt revision` 不可变思想 | 落 `agent_runs/run_attempts/run_checkpoints`（见 09） |
| 始终 | 不复制外部产物原文/token/DSN/PostHog key | 写作规范硬约束；任何硬编码第三方 secret 一律禁止入库 |

## 5. 端口与环境（Required，细节见 13）

- `apps/api`：`PORT=3000`（`ROLE=all` 本地一键起）；`apps/web`：`PORT=3100`，`NEXT_PUBLIC_API_BASE` 指向 api。
- PG：`DATABASE_URL`；`TZDB_VERSION` 显式声明（缺失则 `/readyz` 类型化失败，见 10/13）。
- 模型 key、向量库地址（如有）一律环境变量/Secret，不进代码（Observed, B03§6）。

## 引用

- B00 总览、B03 架构、B05 路线图、B06 v0-spec §4/§12；AF §2–§7。
