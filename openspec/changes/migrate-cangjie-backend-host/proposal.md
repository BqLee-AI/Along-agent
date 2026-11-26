Issue: #189

## Why

原生仓颉已经负责模型和工具循环。生产 HTTP/SSE 入口、Run 宿主编排和 Worker 调度仍由 TypeScript 负责。迁移将这三个运行职责收归仓颉，使已有执行核心和服务生命周期由同一语言维护。

## What Changes

- 仓颉直接接收 HTTP/SSE 请求，负责 Run 启动、暂停及恢复编排，并推进 Worker 各阶段。
- TypeScript 保留身份与授权、模型和外部传输、领域规则与 PostgreSQL 原子事务。Web 继续消费既有公开合同。
- 用聊天提醒的创建、取消与后台投递作为首条纵向验收，随后按业务入口完成切换。
- 保持公开错误、冻结展示、SSE、历史快照与回执语义。切换与回滚必须保留排空、唯一写入权限和恢复证据。

现行合同见 `docs/design/08-scheduler-and-delivery.md` §1–9、`docs/design/09-agent-runtime-and-checkpoint.md` §1–8、`docs/design/10-api-and-stream-design.md` §1–6、`docs/design/15-r1-local-lifecycle.md` 及 ADR 0009 §Decision。

## 非目标 / Deferred

Web 重写、公开 npm 发布、数据库换型、新业务能力、历史协议退役（#176）。

## Capabilities

- `agent-runtime`：增加仓颉生产宿主以及跨语言状态交接的可验收合同。
