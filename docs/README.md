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
| 5    | [验收与待决事项](prd/04-acceptance-open-questions.md)          | v0/R1 验收、Deferred 清单、重开门槛                              |

## 二、总体设计（真源，14 篇）

| 序号 | 文档                                                                     | 作用                                                                                                                   |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 01   | [技术栈与仓库结构](design/01-tech-stack-and-repo-structure.md)           | TS 模块化单体、Bun workspaces、依赖优先构建、依赖方向、复用优先                                                        |
| 02   | [模块化单体与拆分触发](design/02-modular-monolith-and-split-triggers.md) | 模块所有权、确认/工具结果的限定原子事务、拆分判据与D1边界                                                              |
| 03   | [v0 垂直切片](design/03-v0-vertical-slice.md)                            | 简报→卡片→对话→按钮确认→调度→站内通知详情投影→活动账；真实取消回执与七步证据边界                                       |
| 04   | [五缝契约](design/04-five-seams-contract.md)                             | 稳定工具调用、原子接受结果、只追加审计与非事务未知边界；其余能力端口                                                   |
| 05   | [time-core 时间层](design/05-time-core.md)                               | 纯函数 normalize、有限真实规则上下文、typed 时间失败、fold 候选与实际 readiness                                        |
| 06   | [approvals 确认门](design/06-approvals-confirmation-gate.md)             | 版本化冻结回显、显式修改、按钮确认及工具批准/结果原子边界                                                              |
| 07   | [task_events 事件账](design/07-task-events-ledger.md)                    | 只追加账本、取消优先、活动页读模型                                                                                     |
| 08   | [调度与投递](design/08-scheduler-and-delivery.md)                        | 未排期过窗终结与遗留恢复、一次性调用许可、独立本地接收、未知不重发及取消栅栏                                           |
| 09   | [Harness 与 checkpoint](design/09-agent-runtime-and-checkpoint.md)       | 正式仓颉循环、TS 资格/事实、原子终态、有限批准恢复与只读补读                                                           |
| 10   | [API 与流式通道](design/10-api-and-stream-design.md)                     | REST 真源、envelope、128KiB原始JSON字节边界与未消费流收尾、SSE版本化、WS延后                                           |
| 11   | [仓颉 Harness 与 TS 能力层](design/11-cangjie-runtime-spike.md)          | 正式 native/固定工具链/纯模型 transport；接入、消费者门与完整 R1 分级验收                                              |
| 12   | [a13n 六思想落点](design/12-a13n-principles-landing.md)                  | harness/checkpoint/自托管/revision/AG-UI 投影/readyz                                                                   |
| 13   | [P0 开工与 CI 死规矩](design/13-p0-bootstrap-and-ci-rules.md)            | Bun/Ox 统一入口、依赖优先构建与串行类型检查、static 后四路隔离并行、正式 native 双入口消费者及本次执行证据、五门全成功 |
| 14   | [R1 资料到简报任务闭环](design/14-r1-document-task-loop.md)              | 受管工作区、有限文件/MCP、精确文档批准、非事务写入与同 Run 回读；设计不替代运行证据                                    |

## 三、API（6 篇）

| 序号 | 文档                                                    | 作用                                                       |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | [API 索引与约定](api/README.md)                         | 20 业务端点 + 2 探针、workspace/文档批准、envelope与错误码 |
| 2    | [auth 与 me](api/auth/auth_routes.md)                   | 鉴权 Deferred 二选一、GET /me、401/403                     |
| 3    | [brief 简报与卡片](api/brief/brief_routes.md)           | GET /brief、card schema_version                            |
| 4    | [对话与 SSE](api/conversations/conversations_routes.md) | execution 分派、Run 读/取消/有限批准恢复、SSE 与补读隔离   |
| 5    | [确认门](api/approvals/approvals_routes.md)             | 列表/详情/confirm\|reject\|revise、持久修改重放、重新确认  |
| 6    | [任务与事件](api/tasks/tasks_routes.md)                 | 列表/详情/cancel 幂等/events 只读按 recorded_at            |

## 四、Schema（5 篇）

| 序号 | 文档                                                 | 作用                                                                              |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | [Schema 索引](schema/README.md)                      | 落地顺序、enum text+check、append-only、owner_id、敏感约定                        |
| 2    | [身份与租户](schema/identity-schema.md)              | users、sessions（随鉴权 Deferred）                                                |
| 3    | [对话与运行](schema/conversation-and-runs-schema.md) | conversations/messages、agent_runs/run_attempts/run_checkpoints、revisions 不可变 |
| 4    | [承诺与账本](schema/commitments-schema.md)           | approvals/修改预约/tasks/task_events/outbox/notifications 全字段                  |
| 5    | [简报与卡片](schema/content-schema.md)               | briefs/cards 含 schema_version                                                    |

## 五、Agent（7 篇）

| 序号 | 文档                                                        | 作用                                                               |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | [Agent 索引](agent/README.md)                               | 职责结论、LLM 只提议、白名单、确认门唯一入口                       |
| 2    | [助理总览](agent/01-assistant-agent-overview.md)            | 职责/非职责、对话→提议→确认主链                                    |
| 3    | [工具网关与 v0 工具](agent/02-tool-gateway-and-v0-tools.md) | 五工具schema、持久身份/重放、批准原子结果、当前权限与unknown不重发 |
| 4    | [简报与卡片生成](agent/03-brief-and-card-generation.md)     | 每日调度触发、输出 schema、校验降级、预算                          |
| 5    | [提议到承诺流](agent/04-proposal-to-commitment-flow.md)     | 分诊、澄清问法、time-core 错误到话术映射                           |
| 6    | [对话运行与预算](agent/05-chat-runtime-flow-and-budget.md)  | Run/attempt/调用边界、native 累计预算、同 Run 批准恢复与取消       |
| 7    | [评测夹具](agent/06-eval-fixtures.md)                       | 50 条时间表达集、200 卡片集版本化、指标口径                        |

## 六、Demo、收口规划与验收记录（11 篇）

| 序号 | 文档                                                                             | 作用                                                                      |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | [v0 全链路 smoke](demo/v0-slice-smoke.md)                                        | 7 步复现、断言取消后触发数=0                                              |
| 2    | [time-core 黄金用例](demo/time-core-golden-cases.md)                             | 4 基准+DST+50 表达，fixture 可被测试消费                                  |
| 3    | [故障注入 smoke](demo/fault-injection-smoke.md)                                  | 真实强杀、取消竞争及规则故障；分别计数实际调用与持久结果                  |
| 4    | [v0 七步 smoke 收口计划](demo/v0-smoke-closeout-plan.md)                         | 真实链路缺口、最小实施顺序、七步证据与完整 v0 验收边界                    |
| 5    | [2026-10-21 七步真实验收记录](demo/v0-smoke-evidence-2026-10-21.md)              | 浏览器/通知/取消真实时窗、调用正控制与零调用、脱敏原始证据及未覆盖边界    |
| 6    | [v0 完整收口计划](demo/v0-closeout-plan.md)                                      | A2 原子替代、A3 崩溃恢复与不确定窗口、A4 时间合同、镜像部署及完整验收门槛 |
| 7    | [2026-10-21 A3 崩溃恢复验收](demo/v0-crash-recovery-evidence-2026-10-21.md)      | 六个真实强杀窗口、取消 COMMIT 后零调用、完整宽限与组合镜像适用边界        |
| 8    | [2026-10-22 A1 失败与部署恢复](demo/v0-a1-recovery-evidence-2026-10-22.md)       | 原始字面任务失败、新任务独立登记与容器重启策略实测                        |
| 9    | [2026-10-21 A4 时间错误与规则就绪](demo/v0-time-errors-evidence-2026-10-21.md)   | 真实资源故障、DB断开、未来DST错误及first-v2版本化修复与运行证据           |
| 10   | [2026-10-21 A2 修改与重新确认](demo/v0-approval-revision-evidence-2026-10-21.md) | 真实原子替代、丢响应重放、明确新确认、原生双击及first-v2补充              |
| 11   | [2026-10-23 v0 完整验收记录](demo/v0-closeout-evidence-2026-10-23.md)            | 新字面 A1 自然到点、真实页面/活动链、A1–A4 证据映射与收口保证边界         |

## 七、References（3 篇）

| 序号 | 文档                                                             | 作用                                        |
| ---- | ---------------------------------------------------------------- | ------------------------------------------- |
| 1    | [CangjieMagic 能力参考](references/cangjiemagic-capabilities.md) | 已知/未验证项→design/11                     |
| 2    | [旧蓝图对账](references/blueprint-reconciliation.md)             | B00–B06 逐篇 verdict、8 冲突裁决、06 不变量 |
| 3    | [术语表](references/glossary.md)                                 | 术语、R/C→Task/Approval 旧称映射            |

## 八、OpenSpec 行为契约与 ADR

- [OpenSpec 说明](../openspec/README.md)：`openspec/specs/` 为可验收行为契约真源（SHALL + Scenario），`docs/design/` 为设计真源；spec 只写行为并引用 design 章节，不复制字段/路由表。
- [ADR 决策记录](adr/README.md)：0000 模板、0001–0005 种子 ADR、[0006 Bun + Ox 工具链](adr/0006-bun-ox-toolchain.md)（取代 0002）、[0007 CI 关键路径局部修订](adr/0007-ci-critical-path.md)（调整 0006 的编排/失败传播）及 [0008 static 内部调度](adr/0008-static-scheduling.md)（局部修订 0007 的内部并发边界）；Bun/Ox 选型和五门全成功不变，冻结决策正文保留，改口径另起新 ADR。
- [ADR0009](adr/0009-cangjie-harness-ts-capabilities.md) 确定仓颉唯一 Harness/TS 长期能力，并局部修订0003的 outbox/确认事务绝对范围；历史 ADR/验收保留其适用边界。同步公共用例/DTO、只读投影、确认创建/取消单事务和可靠异步 outbox 分列，D1 不证明 SQL 所有权。正式实现与分级验收见 design/09/11，[native 构建/运行说明](../apps/harness/README.md) 不等于真实 provider/完整 R1 验收。
- [R1 文档任务合同（#62）](design/14-r1-document-task-loop.md) 定义 Web 选择工作区、真实 TS MCP 检索、文档批准、写入与回读；[行为增量](../openspec/changes/define-r1-document-task-loop/proposal.md) 与实现/真实模型验收分阶段，不把 #45–#47 的底座证据当作完整 R1。
- 冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准。

## 维护约定

- 冲突矩阵：行为/验收以 spec 为准，字段/路由以 design/api/schema 为准，why 以 ADR 为准；先改真源 → 同步跟随（改 `docs/design/` 的 PR 同步 `docs/prd/`、本索引与 `openspec/` 行为契约）。
- 每篇头部固定四行：状态 / 范围 / 不包含 / 阶段标签；节内用 Observed / Required / Proposed / Deferred 标注断言级别。
- 未确认事项只出现在 `prd/04-acceptance-open-questions.md` 的 Deferred 清单，不写入 design 真源层。
- 不复制外部产物原文、token、DSN；引用蓝图一律用 B00–B06 / AF 代号。
- 不猜目标市场、推送、LLM 供应商、计费等待决项；范围和依据见 design/01 与 PRD 04。仓颉唯一 Harness/TS 长期能力分工见 design/09；正式最小接入不替代真实 provider 与完整 R1 验收。
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
