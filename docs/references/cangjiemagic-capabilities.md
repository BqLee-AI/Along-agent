# CangjieMagic 能力边界（已知 vs 未验证）

> 状态：调研结论（2026-10-13），以公开仓库文档为准。范围：CangjieMagic 框架能力在我方架构中的位置。不包含：仓颉语法教程、模型供应商选型。阶段标签：v0–P3 不用（CangjieMagic 只作 AgentRuntime 第二实现，远程 HTTP/SSE）；Spike S1–S3 与 P1 并行、P2 末结案。

## 定位一句话

CangjieMagic 只作 AgentRuntime 第二实现（`CangjieAgentRuntime`，远程 HTTP/SSE）；v0–P3 不用；仓颉永不直连业务库、不做时间归一；需排期回调 `propose_task`（Deferred）。详见 design/11。

## 已知能力（Observed，来自公开仓库文档）

| 能力 | 事实 | 我方映射 |
| --- | --- | --- |
| 宏 DSL | `@agent`、`@prompt`、`@tool`、`@toolset` 声明智能体/提示词/工具；`@ai` 把大模型包装成类型化函数 | MVP 先 1 个 `assistant`；工具后期迁网关 |
| 执行器 | 内置 `naive`、`react`、`tool-loop`（可配最大迭代）；实验性 `@execution`（plan/think/action/repeat/answer） | v0 直接用 `react`/`tool-loop` + 双预算 |
| MCP | 既是客户端也是服务端；客户端支持三类接入（本地进程/远端两类）；本地能力可对外暴露为 MCP Server | 中期经 ToolGateway 聚合，仓颉侧只认网关 |
| HITL | 事件与交互机制，用于执行期观察/拦截/人工审批 | 映射到 `approval_required` 事件 |
| RAG | 外部知识源配置；embedding、向量库（内存/单机两种实现）、索引映射、语义检索原语 | P1 后接知识库服务 |
| 模型配置 | 统一 `<provider>:<model>`，覆盖多家，可注册自定义实现 | 先接 1 家，key 走环境变量 |
| 多 Agent | 线性协同 | 远期（规划者 → 执行者） |
| 示例 | `quick_start` 等可运行示例 | 阶段 0 跑通示例为验收 |

## 未验证项（Unverified，需 Spike）

- HTTP/SSE 瘦边界性能：100 并发首 token ≤ 150ms（S1）。
- 长跑稳定性：30min RSS 不涨；cancel 2s 内（S1）。
- kill -9 后 resume 副作用恰好一次（S2）。
- 卡片 zod 通过率、大规模 MCP 经网关、OTel 贯通、镜像构建 ≤ 10min（S3）。
- Windows 桌面行为、时区库完备性（纽约两天的规则在不在）—— 不在就报 `TZDB_UNAVAILABLE` 不开张。

## 死规矩

- [Required] 归一禁引 CangjieMagic（构建依赖图 CI 拦）。
- [Required] 仓颉服务不做用户鉴权、不直连 Postgres 业务表、不直接调外部 MCP Server。
- [Required] 仓颉侧保持薄，脏活放 TS。

## Spike 结案门（S1–S3）

- S1：契约全绿 + 100 并发首 token ≤ 150ms + 30min RSS 不涨 + cancel 2s 内。
- S2：kill -9 后 resume 副作用恰好一次。
- S3：200 卡片 zod 通过率达标 + MCP 经网关 + OTel 贯通 + 镜像 ≤ 10min。
- 与 P1 并行，P2 末结案；不达标则 CangjieAgentRuntime 继续 Deferred。
