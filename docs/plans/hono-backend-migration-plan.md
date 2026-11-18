# Hono API 与后端职责重构计划

> 路线替代：目标框架与实施路线以 [Elysia API 与全后端模块化重构方案](elysia-api-modular-refactor-plan.md)为准。本文保留为 Hono 路线的设计依据，不作为 Elysia 实施入口；有效业务合同仍按 OpenSpec、design/API/schema 裁决。

> 状态：Proposed，供评审；不是实施授权。
> 范围：`apps/api` 的 HTTP 入口、助理执行和业务能力边界；保持外部行为、部署角色和数据合同。
> 不包含：实施、生产访问、真实供应商调用、UI 重写、存储格式或权限变更。
> 阶段：实施方案；源码审查基线 `02706890eed84f9155d3589b279220e8194555db`，实施前复核目标分支。

## 结论

以 **Hono API + 责任明确的单体后端**为目标：独立 `apps/api` 继续运行在 Bun，Next.js 继续提供页面、同源代理和服务端读取；`api|worker|all`、PostgreSQL 和仓颉唯一 Agent 循环保留。Hono 只处理 HTTP，不接管业务事务或 Agent，但本计划**不只换 HTTP**：还要重组接纳、执行权威、工具调用、领域用例和数据库事实的所有权。

不把现有 `modules` 仅改名为 `features`，也不把原大文件原样挪进 `assistant` 就算完成。必须能从接口追踪到完整用例、状态所有者、同一事务和外部效果；旧分发与旧调用路径最终退出。目录是表达责任的手段，不要求生成空层、通用基类或逐文件机械对称。

### 取舍

- 只把手写路由换成 Hono：改动较小，但 Run 权威、工具接受和跨领域事实仍耦合，无法满足本任务；不选。
- 在独立 Bun 单体内同时重划用例与事实、再切换 Hono：保持角色和持久合同，能逐批验收；代价是需要同事务迁移及过渡期路由分派；推荐。
- 把后端迁入 Next 或拆成服务：改变长运行 driver、锁和部署生命周期，新增分布式事务与运维边界；没有本任务所需证据，不选。

目录结构是 Proposed，不作为规范真源；锁序、错误和外部行为仍以现有 OpenSpec、design/API/schema 合同及其有效实现为准。现有方案不足以证明生产部署或适配器兼容。

合同入口：[运行时行为](../../openspec/specs/agent-runtime/spec.md)、[工具网关](../../openspec/specs/tool-gateway/spec.md)、[对话](../../openspec/specs/conversations/spec.md)、[工作区](../../openspec/specs/workspaces/spec.md)；设计与字段见 [API 与流](../design/10-api-and-stream-design.md)、[目标内委托](../design/20-goal-scoped-delegation.md)、[R3](../design/23-r3-short-term-memory-and-compact.md) 和 [对话 API](../api/conversations/conversations_routes.md)。各阶段以这些合同而非目录名决定完成。

## 事实：问题不止在 HTTP

- `modules/conversations/lifecycle/service.ts` 的 `startConversationRun()` 把 owner 资格、幂等、消息、冻结上下文、Run、模型版本、策略和 attempt 组织成完整接纳事务；同文件又含确定性执行和事件处理。`repository.ts` 同时维护会话和 Run 事实。终结时 assistant message、checkpoint、attempt 和 Run 在同一事务提交（`run-state.ts`）。它们不是可以随目录分别提交的独立 CRUD。
- `conversations/harness/harness-authority.ts` 包含 Run 查询/取消/恢复、release 检查、native session、模型帧、工具/批准资格、预算和收尾。一个 attempt 的 session 有相互关联的状态，不能拆成各自维护状态的多个 manager。
- `tools/gateway.ts` 将不同工具映射到任务、偏好、工作区、批准等能力；`tools/invocations.ts` 则持有调用身份、冻结信息、资格、首次接受和审计。前者可以按具体能力拆开；后者的事务和三类执行语义不能被通用 `execute(handler)` 或自动重试取代。
- 代码中 Run 权威引用 tools，工具调用又引用 Run 资格；文档批准还要与工具证据及 Run 终结联动。这是需要重新划分责任的源码级双向关系，不代表此次执行了循环依赖检查。`.dependency-cruiser.cjs` 有全仓循环规则及按 `modules` 目录发现的跨模块存储规则，但不分析 SQL；目录迁移时须扩展规则，不能据此声称表所有权已经正确。
- 模型配置、版本绑定、SDK 单步通信、出站和计量分别处于 `model-providers` 与 `conversations` 的多个文件；不能把它们全部理解成设置页面 CRUD。工作区登记、grant、路径和身份验证也不是普通文件工具。
- 主线新增 owner-scoped memory、用户安全点暂停及手动/自动 compact；Run 接纳还冻结 R3 消息清单、摘要覆盖和当前输入。空闲 compact 可接纳无用户消息的控制 Run，不能套用普通对话入口的假设（`r3-context.ts`、`idle-compact.ts`）。
- 仓颉侧已经按 `apps/harness/src/protocol/`、`session/`、`transport/` 分开；TypeScript 的模型通信已在 `modules/model-providers/harness-model.ts` 和 `model-stream.ts`。应复用已有划分，不重新设计或倒退到旧文件路径。
- memory 的来源验证由 conversations 提供，语义召回还复用 `conversations/routing/encoder.ts`；模型 transport 工厂及 SDK 序列化/计量分布在 `harness-config.ts`、`harness-context.ts` 和 `model-providers`。这些跨职责依赖必须明确归位，不能只移动配置服务。
- `http/app.ts` 手写路径与写路由白名单、认证、CSRF、连接资格和 body，模块路由又重复匹配路径；业务代码还依赖 `http/errors.ts`。HTTP 入口与业务的方向需要纠正。

## 目标结构及所有权

下面是可审查的目标示意，文件名以职责为准；实际切分须随调用链确认，不以目录存在作为验收。

```text
apps/api/src/
  main.ts, bootstrap/                 # 进程装配、api/worker/维护命令资源及关闭
  http/                               # Hono app、路由、会话/CSRF、响应、SSE 传输
  assistant/
    application/                      # 接纳/恢复/取消、文档决议、组合查询
    records/                          # conversation/message、Run/attempt、checkpoint、锁和原子状态变更
    runtime/                          # driver、每个 attempt 的 session、仓颉进程及执行收尾
    tools/                            # 逻辑调用、接受/审计、工具分发及按能力划分的 handler
    routing/                          # 现有有界意图路由
  features/
    identity/                         # 账户、会话、邀请、用户偏好与资格
    approvals/                        # 任务及文档的冻结批准、决议与其事实
    tasks/                            # 任务/事件/outbox、取消、调度与回执状态
    models/                           # 配置、凭据版本、Run 绑定、probe、单步传输与受控出站
    memory/                           # owner-scoped 记忆、版本、来源资格和召回
    workspaces/                       # 登记、grant、访问资格、有限读取和发布
    brief/ notifications/ time/       # 按现有真实能力与所有权保留
  platform/                           # PG 连接/事务和无 HTTP 依赖的通用错误机制
  worker/                             # 调度与投递进程循环
```

- **HTTP** 解析路径、认证、CSRF、请求体和协议响应，调用完整用例；核心不得接收 Hono `Context`、`IncomingMessage` 或 Next 类型。原错误语义从 `http/errors.ts` 中分离，HTTP 只做 envelope 映射，不要求为此创建无业务价值的抽象层。
- **assistant/application** 拥有跨事实的完整接纳、恢复、取消和文档决议编排；可调用各所有者的公共事务用例，不直接写其他领域私有表。
- **assistant/records** 拥有会话与 Run 的持久事实、资格和原子提交；不反向读取 tools、approvals、models 或 runtime。会话与 Run 不强拆成各自提交的平行业务服务：消息、事件游标和 Run 接纳/终结存在一致性关系。
- **assistant/runtime** 的 driver 是进程级，native session 是 attempt 级，仓颉子进程是传输；每个 TS attempt session 的流、许可、计量和取消等关联状态只有一个所有者。native 自己的 Harness 管理内部会话状态；持久执行资格由服务端核对，合法 snapshot 本身不授予继续资格。运行证据/终结编排可抽出不另拥状态的操作，仍由仓颉决定模型和工具循环；确定性 business 路径不变。
- **assistant/tools** 的 invocation 协调拥有稳定调用标识、结果接受、审计与执行资格；gateway/handlers 将能力请求交给任务、偏好或工作区的公共用例。任务创建规则不归工具网关。
- **features** 拥有各自数据、状态转换和公共用例。tasks 继续拥有 `task_events`、调度 outbox 和回执；workspace 的授权规则留在 workspace，不能丢进通用文件基础设施。models 的配置与版本、单步 SDK 传输及真实序列化计量按明确子职责组织，统一遵守受控网络出口，不能让 models 反向依赖 conversation dependency bag。
- **features/memory** 拥有 owner-scoped 记忆及其版本、召回和停用；会话消息的可见性、来源资格和摘要来源校验仍由会话事实所有者提供。由装配层连接现有 `MemorySources.validate(client, ...)` 语义，保留同 client 和源数据锁，不能为消除依赖而绕过校验。
- 不把所有 context 塞成一个“上下文模块”：Run 冻结策略、R3 消息清单与摘要覆盖、记忆来源资格、工具接受观察、SDK 计量和仓颉上下文选择各有不同所有者。事件持久化、执行资格和 SSE 披露资格也是不同边界。

### 现有代码迁移映射

| 现有责任                                                                                                                                      | 目标及必须发生的变化                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `conversations/lifecycle/service.ts::startConversationRun`                                                                                    | `assistant/application/accept-run`，完整接纳事务保留，不拆成多次提交                                                                 |
| `service.ts::startIdleCompact`                                                                                                                | application 的独立控制用例；空闲时无普通消息，原子接纳控制 Run 或返回 `no_content`                                                   |
| 确定性执行、`history-service.ts`、`history-repository.ts`                                                                                     | business 执行归 runtime；分页历史与事件重放为只读查询，不触发继续或 compact                                                          |
| `conversations/run/repository.ts`、`r3-context.ts`、`compact-store.ts`、`compact-operations.ts`、`compact-continuation.ts`、`idle-compact.ts` | 按会话、Run、冻结清单、暂停、摘要及其来源、操作回执和后继等事实划分；编排与外部 I/O 不归 records                                     |
| `run-state.ts::appendEvent/commitTerminal`                                                                                                    | 上层先组合工具、批准等证据；会话锁、暂停失效及 message/checkpoint/attempt/Run 原子状态变更归 records                                 |
| `harness-authority.ts`                                                                                                                        | 取消、批准恢复、用户 pause/continue 和 runtime compact 的公共操作及编排归 application；单 attempt session 帧处理和共享状态留 runtime |
| `run-driver.ts` / `run-ownership.ts` / `tool-binding.ts`                                                                                      | 分别归进程执行、持锁与 fencing、Run 资格边界；保持同一 PG session 语义                                                               |
| `tools/gateway.ts` / `invocations.ts`                                                                                                         | 分发按提醒、偏好、工作区等拆 handler；调用身份与三类执行的协调仍只有一个所有者                                                       |
| `approvals/document-actions.ts` 与文档效果组合                                                                                                | 涉 Run 的完整决议编排上移 application；冻结授权及决议事实留 approvals                                                                |
| `approvals/confirm.ts`、`tasks/create.ts`、`tasks/cancel.ts`                                                                                  | 批准事务继续调用 tasks 公共的 `*WithinTransaction(client, ...)`；不改成事件后最终一致                                                |
| `model-providers/service.ts` 和 `harness-model.ts` 等                                                                                         | 分为配置/Run 绑定/probe、单步 SDK transport/计量/受控出站；同一规则不复制                                                            |
| `workspaces/service.ts`                                                                                                                       | 按登记、授权访问和文件操作归位，保留共同路径和身份验证，不建立多套检查器                                                             |
| `memory/service.ts`、`authorization.ts`、`semantic.ts`、`routes.ts`                                                                           | 记忆及其版本、候选召回和管理入口归 memory；会话来源资格由 records 公共入口提供，保留同事务验证                                       |
| `harness-config.ts::createUserModelTransport`、`harness-context.ts`                                                                           | 模型工厂、SDK 序列化和测量连同实际类型依赖一起整理；Run 和 probe 继续绑定选定版本并共用受控出站                                      |
| `target-continuation.ts`、`goal-result.ts`、`routing-checkpoints.ts`                                                                          | 保留委托授权、目标结果和路由证据；澄清续跑是同会话新 Run，不能当成 pause 后继或批准恢复                                              |
| `compact-runtime.ts`、`compact-model.ts`                                                                                                      | 冻结、模型调用、发布和记忆候选的组合归 application/runtime；摘要模型调用使用 models 的既有传输能力，不建第二个 Agent loop            |
| 各 `routes.ts`                                                                                                                                | Hono HTTP 路由；认证、请求适配与业务规则分清                                                                                         |

例如 `approvals/repository.ts::findOutboxTaskByKey` 的查询应由 tasks 的公共事务读取承接，而不是把原 SQL 换个文件名。`compact-store.ts` 中跨领域模型绑定资格、`run-state.ts` 中工具及批准证据也须在同一事务中通过公共资格/证据入口组合；不能仅改 import 或搬 SQL。现有 SQL 所有权、owner 条件与锁必须逐项对照，不能只依赖导入边界检查。

切分 `run-state.ts` 时不只移动 `commitTerminal`：`readRunApprovalDecision` 先根据可信 invocation 投影选择批准事实，归 application 的同 client 证据组合；`supportsFrozenTools` 归执行资格规则，`viewOf` 中模型可用性、workspace grant 和批准决议组合归只读应用查询；records 仅持有自身原子事实。`tool-binding.ts` 的 Run 资格入口归 records，工具调用者通过该入口而非反向依赖工具实现。`tools/accepted-result.ts`、`query.ts`、`context-source.ts`、`observation-page.ts` 随调用账和只读投影迁移；`memory-sources.ts` 与 `compact-sources.ts` 保持同 client 来源校验，记忆的召回回执复核及 `routing/encoder.ts` 的装配应与之同批解决。

`workspaces/replace.ts`、`create.ts` 与其 grant、目标身份检查和 MCP 路径一起迁移：保留工作区锁、临时文件、同步、重验、发布与实际回读；不把文件系统效果伪装成 PG 事务。`owner-history.ts` 家族及 `identity/account-service.ts` 的组合查询随公共只读用例迁移；`goal-control.ts`、`reminder-date.ts`、`stream-authorization.ts` 分别归目标执行、可信时间规则和 HTTP 披露资格，不能集中成通用 context。`role.ts`、`db/pool.ts`、`worker/loop.ts`、`identity/mail.ts`、`bin/` 维护入口及 release 检查按现有角色生命周期处理，不因迁移 HTTP 而启动额外 worker 或 scanner。

当前存在 conversations 与 tools、approvals、models、memory 的双向模块依赖，以及 tools 与 approvals 的双向引用；文件级无循环不等于模块职责图无环。新增规则应显式禁止核心反向导入 HTTP、records 导入 tools/runtime、feature 导入 assistant 编排及跨所有者私有存储，并用针对新旧目录的负例验证；SQL 写入与同 client 锁仍须人工按所有权审查。

## 依赖、跨模块事务与不可拆的不变量

依赖方向：`http → assistant/application 或 feature 公共用例`；application/runtime/tools 依赖 records 和需要的 feature 公共入口；feature 依赖自身实现、platform 和稳定 contracts，不反向依赖 assistant 编排；records 不依赖 tools、approvals、models 或 runtime。bootstrap 组装一次真实依赖；维护命令只装配所需资源，不启动 scanner/worker。更新静态边界规则及其变红夹具，不能让新目录逃过原规则。

跨模块公共入口应是有真实业务语义的函数，可以显式接受同一个 `PoolClient`；不需要泛型 UoW、全局 service locator 或事件总线。以下原子性是迁移合同：

1. **Run 接纳**：当前 owner 资格、幂等裁决、conversation/message、冻结授权与时间、Run、原模型绑定、context policy、attempt、routing policy 与幂等账同一事务。相同请求重放先于重新解析当前默认模型；server-owned 使用 ownership 所持**同一个 PG session/client**。提交后才启动执行，失败或重放释放预占资源。
2. **批准确认/取消**：批准锁、owner/状态/有效期、冻结展示校验、tasks 公共创建或取消、task/event/outbox 和 consumed 同一 client；失败全回滚。过期状态需按现有行为提交后返回过期错误；重复确认返回原任务。不能改为批准完成后异步创建任务。
3. **本地工具效果**：按现有锁序检查 Run 和 invocation，领域写入、接受结果及审计同一 client；对允许的明确失败保持原有 savepoint/回滚语义。外部只读则是短事务验资格、事务外 IO、短事务重验后首次接受。
4. **文档决议与当前等待点**：先确定并锁定当前 attempt/Run，再锁批准；拒绝命中当前 delegated 等待点时，决议、取消终态、相关结果和事件同一事务。早到拒绝按既有行为保存，不凭空推进。
5. **外部文件写**：数据库不可能与文件效果原子提交。一次许可/unknown 先提交，事务外受控发布，实际效果由独立事务接受；失去执行资格后仍可记录已发生效果，但不得据此继续执行或披露。未知结果不自动重派、重试或按当前文件猜成功。
6. **终结与锁序**：assistant message、terminal checkpoint、attempt 与 Run 终结及相关 pause 失效保持同事务。保留 attempt → Run → invocation → 相应领域锁的现有偏序及 task scope、conversation cursor 的约束；接纳和摘要发布与可见消息写入共享 conversation 锁，空闲 compact 幂等锁先于 conversation/admission 锁。不发明全局锁。记录/组合迟到事实的代码不能被无条件绑回失效的 ownership 事务。
7. **R3 冻结及控制 Run**：共同 conversation 锁下冻结确切摘要、覆盖消息 ID、未覆盖历史及独立当前输入；恢复使用 Run 冻结事实而不是当前摘要。空闲 compact 的控制输入没有用户消息，幂等回执与已接纳 Run 的模型绑定、attempt 和 pause 原子提交；空内容返回稳定 `no_content`。保持冻结前数据库侧数量/字节上界及旧 profile 原有引用合同，不先无界聚合或给旧 Run 补新工具。
8. **安全点和唯一后继**：登记 pending 不等于已暂停；在途模型和已许可工具按原合同收尾，校验 snapshot、累计预算及已接受事实后才持久化 pause、Run 和 attempt。用户暂停只允许显式 continue，批准等待使用既有 resume，runtime compact 使用自己的继续路径；三者不能合并。消费 pause、同 Run 新 attempt 和唯一后继回执同事务；并发只有一个赢家，同键重放不再次执行，预算和已接受动作不重置。
9. **compact 的分段事实**：短事务冻结来源，事务外摘要模型和后继容量校验，短事务按精确 ID、来源 hash 与前驱版本发布摘要/覆盖及回执；不删除原文。usage 独立记账，未知不是零；记忆候选是另一事务，失败不回滚已发布摘要。取消先提交不得迟到发布或继续，已发布事实保留。手动活动、自动和空闲 compact 的失败/后继规则各按现有合同，不新增自动重试或统一回退。
10. **记忆接受与来源复核**：记忆写入沿用 owner、来源和幂等规则；召回回执与工具观察接受同事务。记忆被更正、停用或过期后，使用已接受观察前仍须复核当前版本及来源资格；不把语义索引当成授权事实或删除该复核。

执行权迁移还须保留 `run-ownership.ts::transaction` 的每 Run 串行队列、同 session 事务和禁止事务内外部 I/O：业务拒绝回滚可继续，驱动/SQL 等非业务错误、BEGIN/COMMIT 不确定或失锁会使 ownership 失效。将 `HttpError` 拆出 HTTP 时必须同步迁移这一判别语义，不能让所有异常都继续或都失权。`run-driver.ts` 使用独立有界池（5 连接、4 执行槽，保留扫描容量）、1 秒探测和 5 分钟撤权；迁移时不隐式改变这些生命周期，验收包括 `run-ownership.test.ts` 和驱动恢复测试。

事件游标不是 application 自增：`infra/migrations/0015_cangjie_harness_authority.sql` 的 checkpoint 触发器持会话行锁分配游标，事件 kind 受数据库约束。保留触发器及 cursor 锁与现有事件语义，不为了切换 SSE 新增内部 kind。安全点的 `nextPermit`、模型帧和已接受观察依赖同一个 attempt session 的局部状态；application 负责入口编排，不把这些判断复制到另一独立状态机。自动 compact 可由 native 帧触发，不仅是 HTTP 操作。控制 Run 是 server-owned；手动 compact 失败保持暂停，自动及控制 compact 失败时按现有资格条件终结，取消或失权优先。

## 关键用例在目标架构中的路径

### 发送对话和工具执行

```text
浏览器 → Next 同源代理 → Hono 认证/CSRF/body
→ application 接纳（同一事务冻结消息、Run、模型与策略）
→ 提交后 driver/session 启动仓颉
→ 仓颉请求一次模型通信或选择工具
→ models 受控单步通信 / tools invocation 资格与接受
→ 如需创建提醒：tasks 公共事务用例写 task + event + outbox
→ 原执行权威核实真实结果，records 原子终结
→ SSE 从持久事件读取、按现有资格交接给订阅者
```

server-owned 断订阅不停止 Run；request-bound 断连按原合同取消。相同接纳键 POST 重放原持久事件前缀并结束，不新建 attempt 或自动跟随。任务创建不等于调度已确认或通知已送达。

### 用户暂停和 compact

用户暂停先登记 pending，仓颉在安全点交回快照，服务端核对事实并持久化暂停；用户显式 continue 后才产生同 Run 的新 attempt。活动 compact 同样等待安全点，由原 driver 持有 ownership，执行来源冻结、摘要模型调用、后继容量校验、摘要发布及记忆候选，再按其目的继续。空闲 compact 先接纳无用户消息的控制 Run，不伪造聊天消息。仓颉 `session/`、`protocol/`、`transport/` 的现有分层直接复用。

driver 对失去 owner 的执行做 fencing 和保守中断收尾；compact 已发布事实保留，未知 usage 按原合同记账，不自动重派模型或工具。普通用户 pause 不是自动继续的入口，不能把这一收尾称为任意 crash recovery。

### 批准及文档变更

legacy 提议提醒先在工具事务中创建冻结批准并接受工具结果；用户确认时，approvals 按上面的同一 client 合同调用 tasks。取消仅提交 `cancel_pending`，真实撤销回执到达后才进入 `cancelled`。

文档路径保留“真实读取 → 冻结批准材料 → 用户决议 → 显式恢复原 Run → 一次写许可 → 真实文件发布 → 实际回读验证”。`approved`、`applied`、`verified` 是不同事实；不把缓存或旧观察当作新回读。工作区 grant、文件身份、确切字节和冲突后继的原有规则不因目录重排改变。

## Hono、Next 和传输适配

浏览器继续走 `apps/web/src/app/api/[...path]/route.ts` 同源代理；Next Server Components 还通过 `apps/web/src/shared/http/server.ts` 直接访问 API 并转发 cookie。两个通道都要保留。Next 代理保留服务器侧本机 capability 注入，浏览器不能自行伪造。

[Hono 官方支持 Next App Router](https://hono.dev/docs/getting-started/nextjs)，但本系统还有长期 Run driver、PG session 锁、仓颉进程、worker 和退出收尾，本次不把它们迁入 Next 请求生命周期或 Vercel Functions。优先验证 Bun 上 Hono + [`@hono/node-server`](https://hono.dev/docs/getting-started/nodejs)，以获取真实 incoming/outgoing 与 socket；这是候选，**不是已证实兼容**。在隔离环境验证固定版本的真实连接地址/TLS、提前拒绝未读上传、取消、SSE 和 `Server.close()`，失败则重新选择适配方式；不信任浏览器提供的 forwarded 头代替 socket。

受保护业务 POST 保持现有认证 → 已知写路径 → CSRF → 模型配置连接资格 → 有限 body 的语义；账户保留精确路由、Origin、匿名/签名 session 和受控 legacy claim，不开放 Better Auth 通用 handler。原状态码、envelope、多个 cookie、request ID、路径/方法及错误优先级按合同核对；HEAD、重复 query、路径解码等框架差异必须验证。

具体保留：`http/app.ts` 先规范化 request ID，非 GET/POST 关闭未读请求；账户分支在数据库检查前判定精确路由，随后按其独立 Origin、签名/匿名 session、CSRF 和 query 检查，不能套业务写闸门。业务写的模型连接资格仅对相应 POST：真实 TLS、真实连接两端均 loopback、或服务端注入且恒时比较的本机 capability 三选一，GET 不新增该检查。`Content-Length` 只作提前拒绝提示，chunked 也累计原始字节；认证/CSRF、未知路径和超限拒绝时，必须完整发送有限错误响应并及时关闭未结束上传，不主动无界读取或等待客户端 end。允许运行时已缓冲数据及触发超限的最后一个 chunk 造成有限越界，不要求绝对零读取或零 drain。非业务异常仍按现有边界映射 `503 NOT_READY`，429 保留 `Retry-After`；流已发头后不再输出 JSON。保留 Next 代理的头白名单、多条 Set-Cookie、上游失败 502 和双向取消，RSC 读取仍只转发所需 cookie。

适配器实验须检查未读请求自动清理及其读取范围、响应和关闭时机，不能假设默认安全；是否完全关闭 drain 不是验收目标。须对生产 handler 通过真实明文及 TLS socket 分别验证慢速与持续上传，覆盖认证/CSRF、未知路径和超限拒绝，确认完整有限错误及及时关闭，不以应用内部请求或历史结果替代。也须检查 Hono 的 HEAD 自动匹配、TransformStream 有界背压、正常关闭与 abort 区分、原生 incoming/outgoing 及 5 秒进程关闭上限。按仓库 Bun 1.4.2 和实际使用版本记录结果；本条是验收要求，不表示这些场景已经通过。

SSE 开流前返回现有 JSON 错误；开流后的异常按原协议结束连接，不能假定每种异常都会补发 `thread.failed`，也不依赖 Hono 普通 `onError`（见[官方 streaming 文档](https://hono.dev/docs/helpers/streaming)）。事务内只在授权后有界交接事件，等待慢客户端在事务外；停用先提交时不交接后续事件。server-owned 的持久事件订阅逐事件复验原 session，request-bound 断连取消，POST 幂等重放仅返回有限前缀且不自动跟随；不能悄悄统一三者的授权语义。暂停后重连或 GET 不得自动 continue。保留 `data` 帧、版本和 `after_seq`。

## 分阶段实施与退出条件

以下是建议顺序；每阶段可单独审查，不构成自动实施授权。

1. **冻结事实并验证适配器**：盘点 HTTP 合同、安全顺序、表/锁/状态所有者和调用方，包括 pause/continue、活动与空闲 compact、回执、事件及分页历史；核对现有 native 协议、snapshot 与冻结 profile 的兼容矩阵。以真实 socket 验证 body 边界、TLS/peer、SSE 有界交接、取消和退出。适配器不满足连接安全或流语义时停止框架切换。
2. **先拆持久权威与编排，保留现有 HTTP**：接纳、批准恢复、用户及 runtime 继续、终结证据组合与 records 原子提交分清；文档决议编排上移；消除 models 对 conversation 类型的反向依赖。验证普通和空闲接纳、冻结视图、同 client 与锁序、暂停唯一后继、原预算及终结事务；迁移所有调用方，不留只转发的旧 shim。
3. **整理工具、工作区、模型及记忆边界**：gateway 按能力分担，invocation 接受账及三类执行保持唯一所有者；workspace 授权与发布、模型版本/计量/受控出站和记忆来源资格各归其主。验证首次接受、撤权迟到读、外部效果记账，以及 compact 来源/CAS、取消、候选独立失败、usage 与后继容量；不改变失败策略。
4. **切换 Hono 路由和 SSE**：先低风险读取，再账户/业务写/模型，最后对话及 SSE。过渡期外层按明确路径分派，不能先消费 body 再交给旧 Node handler；同一路径只有一个所有者、不做失败回退。每批一起迁移路由、安全策略与调用方。
5. **完成切换**：移除旧路由/分派，更新依赖检查及负例、release/维护入口、运行与设计文档、索引和测试；在隔离环境验证 `api|worker|all`、进程关闭、已有数据兼容和完整用户路径。最终没有旧生产实现和过渡适配。

### 实施批次、依赖与回退

阶段之间的依赖是 **适配器实验 → 事实和编排切分 → 能力归位 → HTTP 分批切换 → 删除过渡分派**；前两项的源码重构可在旧 HTTP 下独立交付，不能因 Hono spike 成功就跳过状态边界重构。每批完整迁移调用方、测试和依赖规则，维持可构建可运行版本；涉及同一事务的文件作为同一批次，禁止先合并半套原子提交。

| 批次 | 文件和交付单位                                                                                                                                                                                                                                                                                                   | 通过条件 / 失败时处理                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | 记录 `http/app.ts`、`http/server.ts`、各 `routes.ts` 的方法/路径/错误先后及 Next 两入口；盘点 `service.ts`、`harness-authority.ts`、`run-state.ts`、`compact-*.ts` 的事实、锁和事务；在临时隔离环境测试 Hono 适配器，不接个人资源                                                                                | 连接元数据、未读 body、cookie、断连、背压、关闭均与合同一致才固定依赖版本进入批次 4；失败仅放弃候选适配器，旧服务不变                            |
| 1    | `http/errors.ts` 的协议无关错误归 platform，入口单独映射；`repository.ts`、`run-state.ts` 的会话/Run 写事实归 records；`service.ts` 的接纳和 `harness-authority.ts` 的恢复、取消、终结组合归 application，保留 attempt session 单一状态                                                                          | 原 HTTP 路径下普通/空闲接纳、失败回滚、幂等竞争、pause 后继与终态集成测试通过；失败整体回退该批代码，不能只回退一侧调用方                        |
| 2    | `run-driver.ts`、`run-ownership.ts`、`tool-binding.ts` 和仓颉传输归 runtime/records；`compact-store.ts`、`compact-operations.ts`、`compact-continuation.ts`、`r3-context.ts` 按持久事实与组合拆分；`compact-runtime.ts`、`compact-model.ts` 保留事务外 I/O                                                       | 同 PG session、锁序和 fencing 不变；活动/空闲/自动 compact、来源锁/CAS、取消与保守收尾可区分；失败回退完整批次，不重放未知外部效果               |
| 3    | `tools/gateway.ts`、`invocations.ts` 分开调用账与具体 handler；`approvals/document-actions.ts` 涉 Run 的决议组合上移，`approvals/confirm.ts` 与 `tasks/create.ts`、`cancel.ts` 的同 client 调用保留；整理 `workspaces/service.ts`、`model-providers/*`、`memory/*` 和 conversations 的来源/encoder、模型工厂依赖 | 三类工具执行、文档批准/写入/真实回读、记忆来源复核、模型版本绑定及受控出站均有行为证据；失败按能力批次整体回退，已经发布的文件和已接受事实不撤销 |
| 4a   | 在 `http/` 装配 Hono；先迁 health/read，再迁 account、其余写路由及 models；外层按明确路径选唯一 handler，原请求体交给选中的 handler                                                                                                                                                                              | 每次比较旧合同的安全顺序、状态码、cookie、请求上限、真实 peer；失败恢复该路径旧 handler，不把已消费 body 交给旧 handler                          |
| 4b   | 最后迁 conversations 的接纳、历史、pause、continue、compact 和 SSE；Web 代理及服务端读取保持合同                                                                                                                                                                                                                 | 三类 SSE 生命周期、撤权竞争、流前错误/流后断连、重连和客户端断开均通过；失败恢复整组对话路由，禁止混合一条流的新旧实现                           |
| 5    | 移除旧路由及过渡分派；更新 `.dependency-cruiser.cjs`、负例、运行入口、设计/API 文档与索引；验证 `api`、`worker`、`all` 和维护命令                                                                                                                                                                                | 真实隔离链路及仓库适用门禁通过；未通过停止收口，回退到最后一个完整批次，不将历史结果当本次证据                                                   |

**回滚操作边界**：每批以完整发布单元回退到其前一个通过验收的版本；先停止向待回滚版本接入新请求，按现有进程关闭及 Run ownership 规则处理在途运行，再启动旧版并确认角色、只读历史和新接纳。保持相同 schema、版本化 snapshot/事件及既有 API 合同是允许代码回退的前提；若上线期间写入旧代码无法读取的状态，停止回退并先设计前向修复，不修改既有迁移或凭空回填。数据库事务回滚不撤销已发布文件、模型调用、投递等外部效果；查持久许可/回执和 unknown 状态，不能自动重派。具体部署编排依环境决定，本方案没有证明零停机或混合版本安全。

**证据边界**：Hono/Bun 的 socket 元数据、提前拒绝、HEAD、重复 query、路径解码、多个 `Set-Cookie`、流背压与断连，均须以对应真实连接行为验证；进程内请求和隔离受控模型不证明生产网络或实际供应商。实施时如发现现有合同与源码冲突，以仓库冲突矩阵裁决，行为变更先另走 OpenSpec，不在迁移中悄悄改口径。

相对最新主线 schema，本次职责重排不新增数据库迁移或改写历史冻结事实；已有 R3 迁移及其约束仍须按现有升级流程应用，不能跳过。如发现必须改变公共合同、存储格式、旧 Run 行为或引入新生产拓扑，应停止该部分并重新设计。回滚代码不能撤销已经发生的外部效果。真实用户配置、凭据和工作区不参与实验。

## 验收与证据

- **状态与事务**：复用 `apps/api/test/integration/approvals-confirm.test.ts`、`task-creation.test.ts`、`tasks-cancel.test.ts`、`model-selection-admission.test.ts`、`harness-authority.test.ts`，覆盖幂等、冻结模型、并发、失败回滚、同一 client 与事件/回执。修改后的测试仍验证消费方行为，不能只测目录或函数调用。
- **工具与文档**：复用 `tool-invocations*.test.ts`、`server-owned-permit-race.test.ts`、`server-owned-driver-effect-race.test.ts`、`document-approvals.test.ts`、`delegated-document-rejection.test.ts`，证明本地原子性、外部读重验、unknown 不重派、迟到事实、冻结批准和回读。
- **暂停、compact 与记忆**：复用 `pause-http.test.ts`、`r3-context.test.ts`、`idle-compact-admission.test.ts`、`compact-store.test.ts`、`compact-operations.test.ts`、`compact-runtime.test.ts`、`auto-compact-failure.test.ts`、`compact-driver-recovery.test.ts`、`r3-compact-http.test.ts` 和记忆集成测试，覆盖暂停与继续竞争、精确冻结、来源/CAS、取消、候选失败、unknown usage 与保守收尾；native 合同覆盖既有 pause 和 R3 context 测试。文件存在不代表测试已通过。
- **HTTP 和流**：进程内 Hono app 与真实监听都验证相应行为；现有 `test/contracts.test.ts` 只双跑 `/healthz`，不能宣称它已覆盖全部 API。复用 `test/http-body.test.ts` 及真实连接测试，验证未登录/CSRF/未知路径提前拒绝、131072/131073 字节边界、chunked、有限响应和合法连接复用；验证事件顺序、背压、重连、取消与撤权不泄露。
- **实际路径**：隔离 PostgreSQL、仓颉、API、Next 浏览器走真实路径，覆盖不同执行生命周期、审批和历史；worker-only 不启动 HTTP 或 Run driver；显式继续、遗留执行保守收尾与资源退出可观察。受控模型不是实际供应商验收，未配置数据库而 skip 不算通过。
- **结构**：核心无 Hono/Node HTTP 依赖；records 不依赖 tools/runtime；业务不通过私有存储改写别人的事实；新边界检查和负例可变红；从 API 能追踪到用例、状态所有者和事务。大文件不会只靠改名被视作完成。
- **项目门禁**：按仓库 scripts 运行相关 unit、integration、contracts、scheduler、typecheck、lint、依赖边界与 format；原生合同按要求在 Linux x64 Docker 执行。实际验证版本、跳过项和外部限制如实记录。

本计划不修改产品权限、不关闭 #112、不代替真实邮件、生产 HTTPS 或真实模型供应商验收；不包含 UI 重写、ORM 替换、拆微服务或新增持久化基础设施。
