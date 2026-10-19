# Agent 方案索引

| 状态                           | 范围                                                                                         | 不包含                                                                                                      | 阶段标签                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Proposed（随 design 真源收敛） | Along 助理 Agent 职责、工具网关、简报卡片生成、提议→承诺、分诊澄清、对话运行时与预算、评测集 | 鉴权方案、目标市场、Web 框架选型、推送通道选型、LLM 供应商、计费、仓颉是否实装（均 Deferred，不在本目录定） | v0 MVP 全链路完整；P1 起五缝接口化，Cangjie 仅第二实现 |

本目录是 Agent 侧方案层（非真源）。真源为 `docs/design/`（尤其 design/04 Agent 运行时、design/09 时间确定性层）；本目录跟随真源，不另立契约。凡与 design 不一致处以 design 为准。

引用代号：B00–B06 为蓝图 00–06（B06=v0 闭环明细为本次主要输入）；AF=开源 agent 框架参考。

## 文档列表

| 文档                                                      | 作用                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [01 助理 Agent 总览](01-assistant-agent-overview.md)      | 助理职责/非职责、对话→提议→确认主链、不变量                                    |
| [02 工具网关与 v0 工具](02-tool-gateway-and-v0-tools.md)  | ToolDefinition、白名单、v0 五工具 schema、风险分级与审计                       |
| [03 简报与卡片生成](03-brief-and-card-generation.md)      | 每日系统调度触发、上下文组装、Brief/Card 输出 schema、校验降级、预算           |
| [04 提议到承诺流程](04-proposal-to-commitment-flow.md)    | 分诊、澄清问法、time-core 错误到话术映射、确认绑定                             |
| [05 对话运行时与预算](05-chat-runtime-flow-and-budget.md) | conversation/run/attempt/trace 边界、状态机、AgentRunRequest、双预算、中断恢复 |
| [06 评测集](06-eval-fixtures.md)                          | 50 条时间表达集、200 卡片集版本化、指标口径                                    |

## 当前结论

- [Required] LLM 只提议，不决定。LLM 产出自然语言提议与结构化参数草案；`fire_at_utc` 唯一由服务端 time-core 纯函数 `normalize(wall_time, timezone_id, fold_choice, ruleset)` 计算（B06 §4；design/09）。LLM 不算时间、不直接定触发瞬间。
- [Required] 时间校验与排期走确定性层。展示层不换算时间，只读冻结字段固定格式呈现；"明天"=服务端首次接收时刻+已确认时区并冻结（B06 §3.5）。归一失败只走澄清，不猜测、不重写、不报成功。
- [Required] 工具走白名单网关。Agent 可见工具=运行时按 allowlist 注入的子集；网关做白名单校验+zod 参数校验+风险分级+审计；`extra=forbid`，越权调用拒绝并审计。v0 仅 5 工具（见 02），副作用工具只产 approval，不直接建 task/cancel task。
- [Required] 确认门是唯一承诺入口。确认前不创建正式 task、不排期（B06 总闸 1）。Approval 消费+建 Task 同事务是唯一跨模块事务；`presentation_hash` 对不上即停（PRESENTATION_MISMATCH）。
- [Required] 只追加事件账。`task_events` 只追加，DB 禁 UPDATE/DELETE；取消后触发数=0 为一级指标；超 15min 标 missed 不补发。
- [Proposed] CangjieMagic 只作 AgentRuntime 第二实现（`CangjieAgentRuntime` 远程 HTTP/SSE），v0–P3 不用；需排期回调 `propose_task`，永不直连业务库、不做时间归一（见 05）。
- [Deferred] 鉴权方案（自建 vs OIDC）、LLM 供应商、推送通道、计费、目标市场、Web 框架均不在本目录定，字段不预设。

## 维护约定

- 文档主体中文；代码标识、schema 字段、工具 ID、事件名、错误码保留英文。
- 每篇头固定"状态/范围/不包含/阶段标签"；节内标 Observed/Required/Proposed/Deferred。
- 细到字段名/状态机/错误码，不写实现代码；不复制外部产物原文/token/DSN。
- 不猜 Deferred 字段；新增长期边界时判断是否同步到 `docs/design/`。
- 引用蓝图用 B00–B06/AF 代号。
