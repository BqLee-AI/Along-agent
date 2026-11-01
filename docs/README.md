# Along-agent 文档中心

> 状态：草案（随 P0 决策冻结） / 范围：云端多租户 SaaS + Web 先行、后 Electron 套壳的全部文档索引 / 不包含：任何实现代码、外部产物原文、密钥与 DSN / 阶段：P0–P5

本文档体系对标 QuantAgent 文档细度：细到 API 路由表、表字段、状态机、错误码为止，不写实现代码。
`docs/design/` 为真源（design 为真源、prd 跟随），`docs/prd/` 为产品需求与验收口径。治理入口：[CONTRIBUTING](../CONTRIBUTING.md)（人类贡献唯一入口）、[ADR 决策记录](adr/README.md)（冻结决策可追溯）。

## 一、PRD（产品需求，5 篇）

| 序号 | 文档                                                           | 作用                                                              |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | [PRD 索引入口](prd/README.md)                                  | 依赖链：简报→卡片→对话→提议→确认→调度→通知→活动账；Required 列表  |
| 2    | [产品概览与范围](prd/01-overview-and-scope.md)                 | 定位、P0–P5 范围、非目标、差异化三点                              |
| 3    | [核心循环与页面](prd/02-core-loop-and-pages.md)                | 个人助理首页、分组顶部导航、简洁登录、流式聊天与精确批准/只读恢复 |
| 4    | [风险约束与阶段门](prd/03-risk-constraints-and-stage-gates.md) | Top3 风险、指标、准入准出、不承诺口径                             |
| 5    | [验收与待决事项](prd/04-acceptance-open-questions.md)          | v0/R1/R2-A 验收、R2-B 默认关闭路由合同、Deferred 与重开门槛       |

## 二、总体设计（真源，19 篇）

| 序号 | 文档                                                                     | 作用                                                                                                                              |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 01   | [技术栈与仓库结构](design/01-tech-stack-and-repo-structure.md)           | TS/Bun 依赖方向；LumenUI/Base UI + Tailwind v4、原生玻璃材质与一致首屏、分层导航、Markdown 聊天及 RSC/client/controller/data 边界 |
| 02   | [模块化单体与拆分触发](design/02-modular-monolith-and-split-triggers.md) | 模块所有权、确认/工具结果的限定原子事务、拆分判据与D1边界                                                                         |
| 03   | [v0 垂直切片](design/03-v0-vertical-slice.md)                            | 简报→卡片→对话→按钮确认→调度→站内通知详情投影→活动账；真实取消回执与七步证据边界                                                  |
| 04   | [五缝契约](design/04-five-seams-contract.md)                             | 稳定工具调用、原子接受结果、只追加审计与非事务未知边界；其余能力端口                                                              |
| 05   | [time-core 时间层](design/05-time-core.md)                               | 纯函数 normalize、有限真实规则上下文、typed 时间失败、fold 候选与实际 readiness                                                   |
| 06   | [approvals 确认门](design/06-approvals-confirmation-gate.md)             | 版本化冻结回显、显式修改、按钮确认及工具批准/结果原子边界                                                                         |
| 07   | [task_events 事件账](design/07-task-events-ledger.md)                    | 只追加账本、取消优先、活动页读模型                                                                                                |
| 08   | [调度与投递](design/08-scheduler-and-delivery.md)                        | 未排期过窗终结与遗留恢复、一次性调用许可、独立本地接收、未知不重发及取消栅栏                                                      |
| 09   | [Harness 与 checkpoint](design/09-agent-runtime-and-checkpoint.md)       | 正式仓颉循环、TS 资格/事实、原子终态、有限批准恢复与只读补读                                                                      |
| 10   | [API 与流式通道](design/10-api-and-stream-design.md)                     | REST 真源、envelope、128KiB原始JSON字节边界与未消费流收尾、SSE版本化、WS延后                                                      |
| 11   | [仓颉 Harness 与 TS 能力层](design/11-cangjie-runtime-spike.md)          | 正式 native/固定工具链/纯模型 transport；接入、消费者门与完整 R1 分级验收                                                         |
| 12   | [a13n 六思想落点](design/12-a13n-principles-landing.md)                  | harness/checkpoint/自托管/revision/AG-UI 投影/readyz                                                                              |
| 13   | [P0 开工与 CI 死规矩](design/13-p0-bootstrap-and-ci-rules.md)            | Bun/Ox 统一入口、依赖优先构建与串行类型检查、static 后四路隔离并行、正式 native 双入口消费者及本次执行证据、五门全成功            |
| 14   | [R1 资料到简报任务闭环](design/14-r1-document-task-loop.md)              | 受管工作区、有限文件/MCP、精确文档批准、非事务写入与同 Run 回读；设计不替代运行证据                                               |
| 15   | [R1 本地生命周期与配置复用](design/15-r1-local-lifecycle.md)             | #67 初始化/启停/升级目标合同、原配置与目录身份保留、数据库分流及 #68 接口；不代表运行验收                                         |
| 16   | [R1 账户与正式登录](design/16-r1-account-access.md)                      | #68 唯一管理员、原身份转正、库适配、固定会话、401 只读恢复及本机登记收尾合同；独立实验与验收                                      |
| 17   | [R1 会话历史与只读恢复](design/17-r1-conversation-history.md)            | #69 服务端会话发现、原话/多 Run、稳定分页、批准真实结果及零执行恢复合同                                                           |
| 18   | [R2-A 单 Run 有界上下文](design/18-r2a-harness-context.md)               | #83 四种额度、可信计量与未知输入的后验超额边界、不可变策略、来源投影/分页回取及有界批准恢复；实现、受控消费者、真实模型分级取证   |
| 19   | [R2-B 有限只读意图路由](design/19-r2b-readonly-intent-routing.md)        | #88：BGE INT8、三类只读、v5仓颉首轮决议、默认关闭、来源/资产/落盘原子性与逐意图验证；含配置、服务及校准入口，不自动授权接管       |

活动列表为空与历史创建事实、批量请求部分完成及标题序号的证据边界见[design/09 §5](design/09-agent-runtime-and-checkpoint.md#5-toolgateway-交互required)。

R2-B 的完整目标及多轮自主查询边界见[design/19 §4、§6](design/19-r2b-readonly-intent-routing.md#4-白名单与规则)：有历史不等于依赖前文，“哪些”等完整问句仍须经过完整拒识和语义阈值判断；新增、外发、筛选和其他对象的请求不能被截取为白名单读取。

## 三、API（6 篇）

| 序号 | 文档                                                    | 作用                                                                             |
| ---- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1    | [API 索引与约定](api/README.md)                         | 28 业务端点合同 + 2 探针、认证匿名例外、workspace/文档批准、Web 消费边界与错误码 |
| 2    | [auth 与 me](api/auth/auth_routes.md)                   | Better Auth credential、GET /me、#68 窄账户 API、固定会话与来源/CSRF             |
| 3    | [brief 简报与卡片](api/brief/brief_routes.md)           | GET /brief、card schema_version                                                  |
| 4    | [对话与 SSE](api/conversations/conversations_routes.md) | execution 分派、Run 读/取消/有限批准恢复、SSE 与补读隔离                         |
| 5    | [确认门](api/approvals/approvals_routes.md)             | 列表/详情/confirm\|reject\|revise、持久修改重放、重新确认                        |
| 6    | [任务与事件](api/tasks/tasks_routes.md)                 | 列表/详情/cancel 幂等/events 只读按 recorded_at                                  |

## 四、Schema（5 篇）

| 序号 | 文档                                                 | 作用                                                                              |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | [Schema 索引](schema/README.md)                      | 落地顺序、enum text+check、append-only、owner_id、敏感约定                        |
| 2    | [身份与租户](schema/identity-schema.md)              | users、sessions、auth_accounts 与 #68 installation_admin 合同                     |
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

## 六、Demo、收口规划与验收记录（14 篇）

| 序号 | 文档                                                                             | 作用                                                                                          |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | [v0 全链路 smoke](demo/v0-slice-smoke.md)                                        | 7 步复现、断言取消后触发数=0                                                                  |
| 2    | [time-core 黄金用例](demo/time-core-golden-cases.md)                             | 4 基准+DST+50 表达，fixture 可被测试消费                                                      |
| 3    | [故障注入 smoke](demo/fault-injection-smoke.md)                                  | 真实强杀、取消竞争及规则故障；分别计数实际调用与持久结果                                      |
| 4    | [v0 七步 smoke 收口计划](demo/v0-smoke-closeout-plan.md)                         | 真实链路缺口、最小实施顺序、七步证据与完整 v0 验收边界                                        |
| 5    | [2026-10-21 七步真实验收记录](demo/v0-smoke-evidence-2026-10-21.md)              | 浏览器/通知/取消真实时窗、调用正控制与零调用、脱敏原始证据及未覆盖边界                        |
| 6    | [v0 完整收口计划](demo/v0-closeout-plan.md)                                      | A2 原子替代、A3 崩溃恢复与不确定窗口、A4 时间合同、镜像部署及完整验收门槛                     |
| 7    | [2026-10-21 A3 崩溃恢复验收](demo/v0-crash-recovery-evidence-2026-10-21.md)      | 六个真实强杀窗口、取消 COMMIT 后零调用、完整宽限与组合镜像适用边界                            |
| 8    | [2026-10-22 A1 失败与部署恢复](demo/v0-a1-recovery-evidence-2026-10-22.md)       | 原始字面任务失败、新任务独立登记与容器重启策略实测                                            |
| 9    | [2026-10-21 A4 时间错误与规则就绪](demo/v0-time-errors-evidence-2026-10-21.md)   | 真实资源故障、DB断开、未来DST错误及first-v2版本化修复与运行证据                               |
| 10   | [2026-10-21 A2 修改与重新确认](demo/v0-approval-revision-evidence-2026-10-21.md) | 真实原子替代、丢响应重放、明确新确认、原生双击及first-v2补充                                  |
| 11   | [2026-10-23 v0 完整验收记录](demo/v0-closeout-evidence-2026-10-23.md)            | 新字面 A1 自然到点、真实页面/活动链、A1–A4 证据映射与收口保证边界                             |
| 12   | [2026-10-27 账户与本机登记验收](account-access-verification-2026-10-27.md)       | #68 库实验、真实 Web/PG、本机维护、固定会话与原身份两次重启保留                               |
| 13   | [2026-10-28—30 Web 体验验证](web-task-experience-verification-2026-10-28.md)     | #70 生产页面矩阵、受控交互/分页/SSE、原安装及个人助理改版的分段证据                           |
| 14   | [2026-10-31 R2-B 候选实验记录](demo/r2b-embedding-evidence-2026-10-31.md)        | 七版本离线CPU实测摘要、冻结材料与模型哈希、已知错误及独立性限制；不冒充正式服务或自然流量验收 |

## 七、References（3 篇）

| 序号 | 文档                                                             | 作用                                        |
| ---- | ---------------------------------------------------------------- | ------------------------------------------- |
| 1    | [CangjieMagic 能力参考](references/cangjiemagic-capabilities.md) | 已知/未验证项→design/11                     |
| 2    | [旧蓝图对账](references/blueprint-reconciliation.md)             | B00–B06 逐篇 verdict、8 冲突裁决、06 不变量 |
| 3    | [术语表](references/glossary.md)                                 | 术语、R/C→Task/Approval 旧称映射            |

## 八、OpenSpec 行为契约与 ADR

- [OpenSpec 说明](../openspec/README.md)：`openspec/specs/` 为可验收行为契约真源（SHALL + Scenario），`docs/design/` 为设计真源；spec 只写行为并引用 design 章节，不复制字段/路由表。
- [会话与 Web 任务体验主规格](../openspec/specs/conversations/spec.md)约束入口、真实状态、显式动作、流式对话和一致首屏；[体验设计与实施归档](../openspec/changes/archive/2026-10-30-close-r1-web-task-experience/)保留方案、任务及分版本证据。
- [ADR 决策记录](adr/README.md)：0000 模板、0001–0005 种子 ADR、[0006 Bun + Ox 工具链](adr/0006-bun-ox-toolchain.md)（取代 0002）、[0007 CI 关键路径局部修订](adr/0007-ci-critical-path.md)（调整 0006 的编排/失败传播）及 [0008 static 内部调度](adr/0008-static-scheduling.md)（局部修订 0007 的内部并发边界）；Bun/Ox 选型和五门全成功不变，冻结决策正文保留，改口径另起新 ADR。
- [ADR0009](adr/0009-cangjie-harness-ts-capabilities.md) 确定仓颉唯一 Harness/TS 长期能力，并局部修订0003的 outbox/确认事务绝对范围；历史 ADR/验收保留其适用边界。同步公共用例/DTO、只读投影、确认创建/取消单事务和可靠异步 outbox 分列，D1 不证明 SQL 所有权。正式实现与分级验收见 design/09/11，[native 构建/运行说明](../apps/harness/README.md) 不等于真实 provider/完整 R1 验收。
- [R1 文档任务合同（#62）](design/14-r1-document-task-loop.md) 定义 Web 选择工作区、真实 TS MCP 检索、文档批准、写入与回读；行为真源为 [workspaces](../openspec/specs/workspaces/spec.md)、[agent-runtime](../openspec/specs/agent-runtime/spec.md) 和 [tool-gateway](../openspec/specs/tool-gateway/spec.md)。[归档记录](../openspec/changes/archive/2026-10-26-define-r1-document-task-loop/tasks.md) 分列正式消费者、真实模型与受管资料副本验收，不把 #45–#47 的底座证据或混合模型的成功矩阵扩大为单模型可靠性证明。
- [R1 本地生命周期合同（#67）](design/15-r1-local-lifecycle.md) 的行为真源为 [local-lifecycle](../openspec/specs/local-lifecycle/spec.md)；[归档记录](../openspec/changes/archive/2026-10-27-close-r1-local-lifecycle/tasks.md)与[验证记录](local-lifecycle-verification-2026-10-27.md)分列生命周期、受控合同和真实模型证据。[本机使用指南](local-lifecycle.md)覆盖四入口、私有配置、原部署接入及停写维护，不将隔离身份验收冒充正式登录能力。
- [R1 账户合同（#68）](design/16-r1-account-access.md) 的行为真源为 [identity](../openspec/specs/identity/spec.md)；[归档清单](../openspec/changes/archive/2026-10-27-close-r1-account-access/tasks.md)与[验证记录](account-access-verification-2026-10-27.md)分列库实验、行为覆盖、真实 Web/PG、本机登记和独立静态审阅。原身份保留、正式认证与本机收尾共同交付，不将账户验收扩大为 #66 全路径验收。
- [R1 会话历史（#69）](design/17-r1-conversation-history.md) 的行为真源为 [conversations](../openspec/specs/conversations/spec.md)，覆盖服务端发现、可见原文/回复、全部批准和结果、旧深链与只读重登；[使用说明](local-lifecycle.md#找回会话run-和真实结果)、[验证记录](conversation-history-verification-2026-10-28.md)和[归档清单](../openspec/changes/archive/2026-10-28-close-r1-conversation-history/tasks.md)分别记录使用、版本化运行证据与六项验收。`0018` 四个非唯一查询索引含旧原话回退查找，新增索引和单次事件聚合有独立补证；不改变执行/工作区/身份主规格，不替代 #66 全路径验收。
- [R1 个人助理](design/01-tech-stack-and-repo-structure.md#6-r1-web个人助理与职责边界) 与[页面 PRD](prd/02-core-loop-and-pages.md#r1-个人助理)记录分组顶部导航、对话首页、简洁登录、LumenUI/Base UI/Tailwind v4、React 职责、精确批准和原 Run 显式继续；[Web 使用说明](../apps/web/README.md)与[本机任务流程](local-lifecycle.md#开始任务与审阅文档)说明实际操作与原安装边界。[版本化验证记录](web-task-experience-verification-2026-10-28.md)区分各轮源码、生产页面、受控交互与原安装实际验收，不把旧 CI 或页面示例当作新增迁移已验证。
- [R2-A 上下文合同（#83）](design/18-r2a-harness-context.md) 的行为真源为 [agent-runtime](../openspec/specs/agent-runtime/spec.md)、[tool-gateway](../openspec/specs/tool-gateway/spec.md) 与 [workspaces](../openspec/specs/workspaces/spec.md)，实施/分级验收记录见 [归档清单](../openspec/changes/archive/2026-10-30-manage-harness-context/tasks.md)。[schema](schema/conversation-and-runs-schema.md#r2-a-上下文策略83)、[API](api/conversations/conversations_routes.md#7-r2-a-上下文容量83)、[PRD](prd/04-acceptance-open-questions.md#r2-a-单-run-上下文83) 跟随。保留 accepted facts、snapshot2 全引用与精确批准，原事实回取不是新读取；纯合同校验不算正式 native/真实模型验收。
- [R2-B 路由合同（#88）](design/19-r2b-readonly-intent-routing.md) 沿完整规则→BGE INT8→原模型的有限只读路径，保持仓颉唯一循环、原网关/取消/批准恢复，默认off并逐意图验证；行为增量见 [change](../openspec/changes/define-readonly-intent-routing/proposal.md) 与 [任务](../openspec/changes/define-readonly-intent-routing/tasks.md)，[PRD](prd/04-acceptance-open-questions.md#r2-b-有限只读路由88默认关闭) 跟随。[配置及实验入口](design/19-r2b-readonly-intent-routing.md#15-配置与受控实验)复用生产实现；默认off实施PR使用`Refs #88`，与自然shadow、受控接管和最终归档分阶段交付，暂停不等于通过，不自动重启观察、启用enforce或关闭issue。时间性验证与待决门槛见任务Verification；[历史离线证据](demo/r2b-embedding-evidence-2026-10-31.md)不能作为生产接管批准。
- [BGE INT8 第三方声明](../apps/embedding/third-party/bge-small-zh-v1.5/NOTICE.md)与同目录`LICENSE`、`provenance.json`覆盖模型使用依据及量化声明边界；编码镜像携带声明，不包含权重。模型声明与完整镜像/依赖分发清算分别交付，不互相替代，也不构成自动接管批准；完成状态见任务Verification。
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
