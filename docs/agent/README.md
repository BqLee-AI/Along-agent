# Agent 方案索引

| 状态               | 范围                                               | 不包含                               | 阶段标签                                                  |
| ------------------ | -------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| 随 design 真源收敛 | 助理职责、工具网关、提议确认、运行上下文/预算/评测 | 未实现的 R1、模型/工具选型和通用恢复 | v0 TS 确定性 turn；R1 仓颉唯一 Harness + TS 长期能力/存储 |

本目录是 Agent 侧方案层（非真源）。真源为 `docs/design/`：04 五缝、05 时间、09 Harness/恢复、11 仓颉/TS 分工；不另立状态机、远程路由或恢复保证。

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
- [Required] 时间校验与排期走确定性层。展示层不换算时间，只读冻结字段固定格式呈现；"明天"=服务端首次接收时刻+已确认时区并冻结（B06 §3.5）。缺信息/模糊表达仍澄清；已判定时间错误按安全spec typed `thread.failed`，不猜测、不重写、不以completed冒充成功。规则门、结构化候选与Web选择见design/05 §5/§9及本组04话术合同；合同不等于部署验收。
- [Required] 工具走白名单网关。Agent 可见工具=运行时按 allowlist 注入的子集；网关做白名单校验+zod 参数校验+风险分级+审计；`extra=forbid`，越权调用拒绝并审计。v0 仅 5 工具（见 02），副作用工具只产 approval，不直接建 task/cancel task。
- [Required] 确认门是唯一承诺入口。确认前不创建正式 task、不排期；批准消费与创建任务或公共取消用例同事务，冻结 hash/seen 不通过即停（design/02/06）。
- [Required] 只追加事件账。`task_events` 只追加，DB 禁 UPDATE/DELETE；取消后触发数=0 为一级指标；超 15min 标 missed 不补发。
- [Required] 仓颉唯一 Harness 负责模型/工具循环、当前上下文、计划、预算、等待/恢复/停止；TS 长期保留工具/memory/grep/MCP/PC/browser/办公、业务/worker/API/Web 与 Run 存储。R1 未实现，不保留 TS 第二 Agent，不全迁后端（design/09/11）。
- [Deferred] 鉴权方案（自建 vs OIDC）、LLM 供应商、推送通道、计费、目标市场、Web 框架均不在本目录定，字段不预设。

## 维护约定

- 文档主体中文；代码标识、schema 字段、工具 ID、事件名、错误码保留英文。
- 每篇头固定"状态/范围/不包含/阶段标签"；节内标 Observed/Required/Proposed/Deferred。
- 细到字段名/状态机/错误码，不写实现代码；不复制外部产物原文/token/DSN。
- 不猜 Deferred 字段；新增长期边界时判断是否同步到 `docs/design/`。
- 引用蓝图用 B00–B06/AF 代号。
