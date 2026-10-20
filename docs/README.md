# Along-agent 文档中心

> 状态：草案（随 P0 决策冻结） / 范围：云端多租户 SaaS + Web 先行、后 Electron 套壳的全部文档索引 / 不包含：任何实现代码、外部产物原文、密钥与 DSN / 阶段：P0–P5

本文档体系对标 QuantAgent 文档细度：细到 API 路由表、表字段、状态机、错误码为止，不写实现代码。
`docs/design/` 为真源（design 为真源、prd 跟随），`docs/prd/` 为产品需求与验收口径。治理入口：[CONTRIBUTING](../CONTRIBUTING.md)（人类贡献唯一入口）、[ADR 决策记录](adr/README.md)（冻结决策可追溯）。

## 一、PRD（产品需求，5 篇）

| 序号 | 文档                                                           | 作用                                                             |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | [PRD 索引入口](prd/README.md)                                  | 依赖链：简报→卡片→对话→提议→确认→调度→通知→活动账；Required 列表 |
| 2    | [产品概览与范围](prd/01-overview-and-scope.md)                 | 定位、P0–P5 范围、非目标、差异化三点                             |
| 3    | [核心循环与页面](prd/02-core-loop-and-pages.md)                | v0 闭环、喝水与每日简报场景、五视图、活动页                      |
| 4    | [风险约束与阶段门](prd/03-risk-constraints-and-stage-gates.md) | Top3 风险、指标、准入准出、不承诺口径                            |
| 5    | [验收与待决事项](prd/04-acceptance-open-questions.md)          | v0 验收、Deferred 清单、重开门槛                                 |

## 二、总体设计（真源，13 篇）

| 序号 | 文档                                                                     | 作用                                                                |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 01   | [技术栈与仓库结构](design/01-tech-stack-and-repo-structure.md)           | TS 模块化单体、Bun workspaces、依赖优先构建、依赖方向、复用优先     |
| 02   | [模块化单体与拆分触发](design/02-modular-monolith-and-split-triggers.md) | 模块清单、所有权、拆分判据 a–d、B03 十服务裁决                      |
| 03   | [v0 垂直切片](design/03-v0-vertical-slice.md)                            | 简报→卡片→对话→确认→调度→触发→通知→活动页端到端                     |
| 04   | [五缝契约](design/04-five-seams-contract.md)                             | AgentRuntime/ToolGateway/Scheduler/Notifier/ConnectorVault 端口契约 |
| 05   | [time-core 时间层](design/05-time-core.md)                               | 服务端纯函数 normalize；LLM 不算时间，展示层不换算                  |
| 06   | [approvals 确认门](design/06-approvals-confirmation-gate.md)             | 副作用承诺持久对象、状态机、presentation_hash 幂等消费              |
| 07   | [task_events 事件账](design/07-task-events-ledger.md)                    | 只追加账本、取消优先、活动页读模型                                  |
| 08   | [调度与投递](design/08-scheduler-and-delivery.md)                        | worker 角色、PG lease+fencing、outbox、Notifier 投递                |
| 09   | [AgentRuntime 与 checkpoint](design/09-agent-runtime-and-checkpoint.md)  | TsAgentRuntime 主实现、run/attempt/checkpoint、预算权威             |
| 10   | [API 与流式通道](design/10-api-and-stream-design.md)                     | REST 真源、envelope、SSE 版本化、WS 延后                            |
| 11   | [CangjieMagic spike 与灰度](design/11-cangjie-runtime-spike.md)          | 第二实现验证 S1–S3、灰度与结案条件                                  |
| 12   | [a13n 六思想落点](design/12-a13n-principles-landing.md)                  | harness/checkpoint/自托管/revision/AG-UI 投影/readyz                |
| 13   | [P0 开工与 CI 死规矩](design/13-p0-bootstrap-and-ci-rules.md)            | Bun/Ox 统一入口、D1–D10 变红测试、五 job DAG、真实 DB 与 Docker 门  |

## 三、API（6 篇）

| 序号 | 文档                                                    | 作用                                                          |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------- |
| 1    | [API 索引与约定](api/README.md)                         | 12 业务端点 + 2 探针全表、envelope、幂等、错误码总表          |
| 2    | [auth 与 me](api/auth/auth_routes.md)                   | 鉴权 Deferred 二选一、GET /me、401/403                        |
| 3    | [brief 简报与卡片](api/brief/brief_routes.md)           | GET /brief、card schema_version                               |
| 4    | [对话与 SSE](api/conversations/conversations_routes.md) | POST messages SSE、GET 恢复、approval_required 带 approval_id |
| 5    | [确认门](api/approvals/approvals_routes.md)             | 列表/详情/confirm\|reject、presentation_hash、重复确认 200    |
| 6    | [任务与事件](api/tasks/tasks_routes.md)                 | 列表/详情/cancel 幂等/events 只读按 recorded_at               |

## 四、Schema（5 篇）

| 序号 | 文档                                                 | 作用                                                                              |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | [Schema 索引](schema/README.md)                      | 落地顺序、enum text+check、append-only、owner_id、敏感约定                        |
| 2    | [身份与租户](schema/identity-schema.md)              | users、sessions（随鉴权 Deferred）                                                |
| 3    | [对话与运行](schema/conversation-and-runs-schema.md) | conversations/messages、agent_runs/run_attempts/run_checkpoints、revisions 不可变 |
| 4    | [承诺与账本](schema/commitments-schema.md)           | approvals/tasks/task_events/outbox/notifications 全字段                           |
| 5    | [简报与卡片](schema/content-schema.md)               | briefs/cards 含 schema_version                                                    |

## 五、Agent（7 篇）

| 序号 | 文档                                                        | 作用                                               |
| ---- | ----------------------------------------------------------- | -------------------------------------------------- |
| 1    | [Agent 索引](agent/README.md)                               | 职责结论、LLM 只提议、白名单、确认门唯一入口       |
| 2    | [助理总览](agent/01-assistant-agent-overview.md)            | 职责/非职责、对话→提议→确认主链                    |
| 3    | [工具网关与 v0 工具](agent/02-tool-gateway-and-v0-tools.md) | ToolDefinition、5 工具 schema、副作用只产 approval |
| 4    | [简报与卡片生成](agent/03-brief-and-card-generation.md)     | 每日调度触发、输出 schema、校验降级、预算          |
| 5    | [提议到承诺流](agent/04-proposal-to-commitment-flow.md)     | 分诊、澄清问法、time-core 错误到话术映射           |
| 6    | [对话运行与预算](agent/05-chat-runtime-flow-and-budget.md)  | conversation/run/attempt/trace、状态机、双预算     |
| 7    | [评测夹具](agent/06-eval-fixtures.md)                       | 50 条时间表达集、200 卡片集版本化、指标口径        |

## 六、Demo（3 篇）

| 序号 | 文档                                                 | 作用                                         |
| ---- | ---------------------------------------------------- | -------------------------------------------- |
| 1    | [v0 全链路 smoke](demo/v0-slice-smoke.md)            | 7 步复现、断言取消后触发数=0                 |
| 2    | [time-core 黄金用例](demo/time-core-golden-cases.md) | 4 基准+DST+50 表达，fixture 可被测试消费     |
| 3    | [故障注入 smoke](demo/fault-injection-smoke.md)      | kill worker/取消竞争/tzdb 缺失，断言恰好一次 |

## 七、References（3 篇）

| 序号 | 文档                                                             | 作用                                        |
| ---- | ---------------------------------------------------------------- | ------------------------------------------- |
| 1    | [CangjieMagic 能力参考](references/cangjiemagic-capabilities.md) | 已知/未验证项→design/11                     |
| 2    | [旧蓝图对账](references/blueprint-reconciliation.md)             | B00–B06 逐篇 verdict、8 冲突裁决、06 不变量 |
| 3    | [术语表](references/glossary.md)                                 | 术语、R/C→Task/Approval 旧称映射            |

## 八、OpenSpec 行为契约与 ADR

- [OpenSpec 说明](../openspec/README.md)：`openspec/specs/` 为可验收行为契约真源（SHALL + Scenario），`docs/design/` 为设计真源；spec 只写行为并引用 design 章节，不复制字段/路由表。
- [ADR 决策记录](adr/README.md)：0000 模板、0001–0005 种子 ADR 与 [0006 Bun + Ox 工具链](adr/0006-bun-ox-toolchain.md)（取代 0002）；冻结决策正文保留，改口径另起新 ADR。
- 冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准。

## 维护约定

- 冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准；先改真源 → 同步跟随（改 `docs/design/` 的 PR 同步 `docs/prd/`、本索引与 `openspec/` 行为契约）。
- 每篇头部固定四行：状态 / 范围 / 不包含 / 阶段标签；节内用 Observed / Required / Proposed / Deferred 标注断言级别。
- 未确认事项只出现在 `prd/04-acceptance-open-questions.md` 的 Deferred 清单，不写入 design 真源层。
- 不复制外部产物原文、token、DSN；引用蓝图一律用 B00–B06 / AF 代号。
- 不猜 Deferred 字段（鉴权方案、目标市场、是否练仓颉、Web 框架、推送、LLM 供应商、计费）：相关 schema/API 留占位，由 P0/P1 决策解冻。
- 仓库密钥、私有策略、真实 `.env`、用户数据一律不得提交。

## 断言四分标签约定

| 标签     | 含义                                                  | 可否作为开工依据               |
| -------- | ----------------------------------------------------- | ------------------------------ |
| Observed | 在外部可见证据 / 蓝图 / QuantAgent 样例中实际观察到的 | 可引用，不可当作服务端行为承诺 |
| Required | 本文档体系约定的硬约束，开工必须满足                  | 是                             |
| Proposed | 提议方案，待评审或待 Spike 验证                       | 否，需转 Required 后才可开工   |
| Deferred | 明确延后到某阶段的事项，正文不得假设其已决定          | 否，见 04 重开门槛             |

## 引用代号

| 代号    | 来源                                                |
| ------- | --------------------------------------------------- |
| B00–B06 | 自有蓝图 00-overview … 06-v0-spec（B06 为 v0 真源） |
| AF      | 开源 agent 框架参考                                 |
