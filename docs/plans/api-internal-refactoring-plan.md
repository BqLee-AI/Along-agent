# API 内部结构重构计划

> 状态：拟议  
> 范围：Along-agent 的产品链路、运维入口与仓颉执行边界  
> 行为基线：现行 OpenSpec、HTTP/SSE、PostgreSQL 数据和仓颉协议  
> 阶段：按链路持续减量与迁移评审

从真实入口定位用户结果、状态写入方、事务和测试。账户样板先验证了这套方法，接下来以普通对话、暂停和 compact 为主轴，沿提醒、文档、记忆和外部连接核对业务规则的归属。长期目标是让仓颉独占助理执行，收缩 TypeScript 中仍属于执行策略的逻辑。

按[实施顺序](#实施顺序)推进九个批次。[目标目录](#重构后的-api-目录)给出各业务模块、进程入口及公共基础设施的职责，并标明需要换归属的文件。

每批先找出可删除的重复规则、间接调用和多余查询，再决定在哪里重写。评审以整条业务链为单位，计入新文件和组装代码。仅移动实现的变更不作为重构成果。

[既有 Elysia 方案](elysia-api-modular-refactor-plan.md)提供顶层边界。`bootstrap` 装配进程，`http` 承接请求和连接，`features` 拥有业务事实，`agent` 编排跨功能执行，`worker` 调用调度和投递阶段。本计划沿用这些边界和现有公开合同。参考 [DSH 的能力索引](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)与 [Agent Loop 源码地图](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md#understand-the-implementation)。在 Along 内使用职责入口、链路索引和现有 dependency-cruiser 规则落地。

## 账户样板：密码操作

[`invited-service.ts`](../../apps/api/src/features/identity/account/invited-service.ts) 直接实现找回、重置和登录后改密，复用同一套事务、锁和挑战操作。HTTP controller 负责路径、认证输入和 Cookie。账户初始化、认领和登录走 `account-service.ts`。

| 用例             | 行为边界                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forgotPassword` | 沿用限流和邮件可用性检查。在事务内按现有顺序校验 keyring、加锁、确认当前联系邮箱与账户资格，再吊销旧挑战、递增代次并登记新挑战与邮件。找不到合资格账户时保留相同的对外应答。 |
| `resetPassword`  | 保留令牌限流位置、地址与用户锁序、目的和代次校验。密码更新、令牌消费和会话撤销在同一事务提交。                                                                               |
| `changePassword` | 保留登录态、当前密码校验和用户锁。凭据更新与撤销同事务，提交后再处理 Cookie。                                                                                                |

当前密码验证与令牌重置共用凭据资格检查，重置与登录后改密共用凭据写入。找回和重置各在用户锁之后用一次查询取得当下的账户资格与邮箱状态。找回仍先通过地址找到用户再加锁，锁后查询负责确认地址仍属于该用户。

样板在真实 PostgreSQL 和 HTTP 边界对照[账户核心测试](../../apps/api/test/integration/identity-invited-core.test.ts)、[账户双入口测试](../../apps/api/test/integration/identity-invited-dual.test.ts)和[账户 HTTP 测试](../../apps/api/test/integration/identity-invited-http.test.ts)。查验重置与旧密码并发登录、会话写入失败整体回滚、提交应答丢失时的 Cookie，以及邮箱换绑后旧令牌失效。后续可独立评审邀请和邮箱验证，再评审会话撤销与管理员动作。按用户业务动作形成目录和入口，复用样板验证过的粒度。

## 账户样板：邀请与邮箱验证

先重写邀请的创建与重发，再理顺邮箱验证。以消除重复业务规则和缩短用例的调用链为交付目标。模块边界由这些规则决定。账户服务继续提供现有用例入口。

### 2.1 邀请发放共用一条写入路径

`createInvitation` 和 `resendInvitation` 共用 `requireAvailableInvitationAddress` 做过期清理和地址占用检查。重发时排除当前邀请。写入邀请后，`issueInvitation` 从落库行取得邀请 ID、地址摘要和代次，在同一事务中发放挑战、登记邮件并保存幂等响应。创建和重发分别决定重放时机、代次及返回格式。接受邀请原子写入用户、凭据、准入与已验证邮箱，同时消费挑战并写入邀请终态。

### 2.2 邮箱验证显式表达跨状态写入

`verifyContact` 在验证挑战前锁住同地址的待处理邀请。数据库的部分唯一索引保证同地址最多只有一条待处理邀请，因此验证成功并写入邮箱后，可以直接按已锁住的邀请 ID 撤销。主动撤销和邮箱验证共用 `revokeInvitationRow`，同步撤销挑战与抑制待发邮件。两条路径各自持有事务。邮箱验证依次取得地址锁、用户锁、邀请锁与挑战锁，然后写邮箱、撤销邀请、消费挑战并撤销恢复令牌。

[账户核心测试](../../apps/api/test/integration/identity-invited-core.test.ts)覆盖邀请重放、密钥轮换、代次、并发与回滚，以及同地址邮箱绑定竞争、邮箱验证撤销邀请并抑制待发邮件、旧恢复令牌失效。[账户双入口测试](../../apps/api/test/integration/identity-invited-dual.test.ts)和[账户 HTTP 测试](../../apps/api/test/integration/identity-invited-http.test.ts)覆盖路由、资格和错误。

评审按整个账户链路比较改前改后的生产代码，涵盖新增文件和依赖声明。每个切换点都要能指明删除的重复规则、查询或转发。若消除重复需要改变锁序、事务范围或公开错误，重新划定该规则的边界。

## 账户样板：会话撤销与账户停用

批量撤销与凭据失效共用 `revokeUserSessions`。撤销其他会话时保留当前会话。单个会话撤销根据更新行数判断目标是否属于当前账户。账户服务通过一处安装管理员资格查询完成角色判断。管理员停用和本人申请删除共用账户状态写入与凭据失效操作，分别执行各自的授权、密码校验和状态判断。

[账户核心测试](../../apps/api/test/integration/identity-invited-core.test.ts)覆盖撤销范围、Cookie、安装管理员保护、账户状态转换，以及密码重置时会话写入失败的整体回滚。[账户双入口测试](../../apps/api/test/integration/identity-invited-dual.test.ts)覆盖进程内和真实 HTTP 路径上的会话和账户行为。

## 主链拆分与验收

消息接纳在常规幂等命中和唯一键冲突回读时共用请求哈希校验，直接用既有 Run ID 读取事件。发布检查与审批恢复共用冻结工作区授权校验，各自在原事务及错误分支内调用。提醒、时区和记忆证据沿用一份已完成调用查询，各自保留领域校验。外部效果的已应用和未应用回执共享调用 ID、参数摘要和证据引用的校验。

文档批准执行在预约中解析一次批准 ID，并将该 ID 同时用于冻结上下文和关联批准。替换预约对原文只做一次 UTF-8 编码，复用字节检查版本和长度。工具拒绝共用登记逻辑，由调用方明确指定仅审计或将拒绝保存为预约结果。外部写入的协调器直接返回已有回执或不确定结果，只有继续执行或核对证据的分支携带调用绑定。

提醒确认与拒绝共用行锁、所有者和过期检查。发现待处理记录过期时先提交过期状态，再返回错误。创建与取消保留各自的原子事务行为，确认响应统一投影已消费的审批与任务。调度、撤销和回执复查共用到期 outbox 扫描，各阶段使用自己的资格条件。

模型配置的两个默认设置入口共用可选模型校验和默认选择写入。记忆保存和订正从同一查询读取实际写入的版本，普通读取继续检查有效期并锁定记录。HTTP 测试使用正式的 socket handler 工厂，应用源码只有一个创建该 handler 的入口。

普通对话通过仓颉运行。提醒快捷入口仍发送 `business`，由 TypeScript 生成审批或返回任务列表。任务列表分支只调用 `list_tasks`。简报工具在仓颉链路仍有独立入口。

仓颉的 v7 暂停与 v8 快照共用观察状态的组装。v8 只组装一次，并记录历史插入位置。与状态版本对应的读写由原生线协议及真实 HTTP 暂停、恢复和会话压缩测试覆盖。

TypeScript 组装工具禁用的摘要请求，解释模型结果并校验候选记忆的来源，在 PostgreSQL 中发布摘要。仓颉决定何时到达安全点，保留尚未消费的模型结果，并用新摘要恢复执行。

运行中 compact 的常规重放和插入冲突回读共用一份查询及匹配规则。首次查不到继续执行资格检查，插入冲突后查不到仍返回同一状态冲突。该提交点仍由原 Run 事务保护。

模型配置更新与命令行导入共用地址校验。凭据替换要求和导入字段检查分别保留原位置。取消命令插入冲突后只读取一次已有 outbox ID。这三处共删减 30 行生产 TypeScript。

## 实施顺序

从普通对话接纳到真实结果走通一轮，再改变其余 Run 分支。工具效果边界稳定后，依次整理提醒和资料这两条写入链。每批结束即切换调用方和依赖规则，并删除被替代的实现。文件名和目录只有在所在链路随批次切换时一起调整。

| 批次 | 链路和改动                                                                                                                                                                   | 前置依赖与完成条件                                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **普通对话、查询历史与 SSE。** 将消息接纳、Run 状态查询、仓颉执行和终态写入归到明确入口。请求内执行的断连回调由入口提供，服务端执行使用 driver。                             | 首批。相同幂等键重放不启动新执行，历史查询零执行，订阅断连不取消服务端 Run，请求内断连保留取消行为，终态失败原子回滚。[Run 所有权](../../apps/api/test/integration/run-ownership.test.ts) · [SSE](../../apps/api/test/integration/conversations-sse.test.ts) · [仓颉执行](../../apps/api/test/integration/server-owned-native.test.ts)                |
| 2    | **取消、暂停、继续、批准恢复与 compact。** 收拢暂停登记、后继 attempt 和 checkpoint 的共用写入。将空闲、手动和自动压缩定位到同一能力，每个入口继续持有自己的资格和幂等判断。 | 接在第 1 批之后。取消优先，恢复沿用预算和已接受工具，保留 v6/v7/v8 及历史快照，压缩期间的待处理模型响应不重复消费。[暂停 HTTP](../../apps/api/test/integration/pause-http.test.ts) · [compact HTTP](../../apps/api/test/integration/r3-compact-http.test.ts)                                                                                          |
| 3    | **工具预约、效果与接受回执。** 以相同调用身份串联本地事务、外部只读及非事务写入。清理重复证据查询和能力接线。                                                                | 第 2 批稳定暂停与执行权后切换。审批与本地结果原子提交，撤权阻断披露，未知效果只查证，同一调用不重复写。[本地调用](../../apps/api/test/integration/tool-invocations.test.ts) · [外部只读](../../apps/api/test/integration/tool-invocations-readonly.test.ts) · [非事务](../../apps/api/test/integration/tool-invocations-nontransactional.test.ts)     |
| 4    | **提醒创建、批准、交付、撤销与简报。** 在任务模块统一事件追加，把提醒工具和快捷入口接到对应任务及批准用例，简报读取已有投影。                                                | 沿第 3 批的回执入口切换。验证直接和审批创建、确认冻结值、取消后零触发、真实撤销回执和活动回读。[直接提醒](../../apps/api/test/integration/direct-reminder.test.ts) · [取消](../../apps/api/test/integration/tasks-cancel.test.ts) · [调度](../../apps/api/test/integration/scheduler-recovery.test.ts)                                                |
| 5    | **受管资料、文档批准与飞书 Docx。** 从登记和连接一路验证到文件写入、新回读、目标核验和私密披露。在文件与飞书链分别归位授权和证据。                                           | 接第 3 批的效果许可和第 2 批的批准恢复。验证 MCP 实际字节、写入未知状态、撤权后不可披露。[受管资料](../../apps/api/test/integration/tool-invocations-workspace.test.ts) · [新建文件](../../apps/api/test/integration/workspace-create-invocations.test.ts) · [飞书私密历史](../../apps/api/test/integration/feishu-private-history.test.ts)           |
| 6    | **跨会话记忆、模型配置和办公摘要。** 收拢记忆 revision 写入，定位模型设置、Run 绑定、推理传输和独立纪要摘要，清理无生产调用的表单校验。                                      | 记忆接第 2 批的压缩来源和第 3 批的工具回执。配置导入与办公摘要可独立验收。验证订正与停止召回、生效的模型绑定、当前默认模型摘要。[记忆](../../apps/api/test/integration/memory-native-wiring.test.ts) · [模型配置](../../apps/api/test/integration/model-providers.test.ts) · [办公摘要](../../apps/api/test/integration/office-notes-summary.test.ts) |
| 7    | **建号登录、邀请管理、联系方式与密码恢复。** 以已整理的密码和邀请路径为基础，继续核对本机与 Web 共用的资格、凭据和会话失效。                                                 | 独立于 Run 重构。验证身份保留、令牌代次、并发锁序、邮件抑制和 HTTP Cookie。[账户事务](../../apps/api/test/integration/identity-invited-core.test.ts) · [HTTP 双入口](../../apps/api/test/integration/identity-invited-dual.test.ts)                                                                                                                   |
| 8    | **安装启停与升级、本机账户和工作区维护、模型导入。** 收拢 CLI 和启动装配的重复前置。HTTP 与 worker 的共享入口清理随各自链路验证，在本批复核进程配置和退出。                  | 使用前面已稳定的账户、登记、模型配置和 Run 停等入口。保留升级锁、版本门、备份与写者启停次序，验证三种角色和真实安装入口。[本地使用指南](../guides/local-lifecycle.md) · [启动装配](../../apps/api/src/bootstrap/application.ts)                                                                                                                       |
| 9    | **仓颉接管 compact 摘要执行。** 对照原生行为验证后切换摘要请求和解释，删除被替代的宿主逻辑。                                                                                 | 核心前置是第 2 批的恢复合同与第 6 批的来源、模型传输边界。验收见下文「按业务链路划分仓颉与 TypeScript」。                                                                                                                                                                                                                                             |

第 4、5 批共用工具回执边界，各自可回退。第 7 批和第 8 批的部分清理可以和对话主线独立交付。全链路都纳入结构计划，实际实施以每批的依赖和测试范围为界。

## 从用户结果追踪重复实现

| 产品链               | 源码发现和处理边界                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次建号、认领与登录 | Web 用账户契约解析输入，本地 CLI 负责交互选择，身份服务负责准入。`resolveAdmittedLocalCandidate` 与 `getAdmittedLocalOwner` 重复读取已准入且活跃的用户。合并时分别保留选择令牌和 UUID 的校验顺序。[账户服务](../../apps/api/src/features/identity/account/account-service.ts)                                                                                                                      |
| 邀请和成员管理       | 创建、重发和邮箱验证已共用地址占用、发放和撤销规则。保留地址锁、用户锁、邀请锁、挑战锁的次序。客户端展示与后台邮件投递职责独立。                                                                                                                                                                                                                                                                   |
| 联系方式、改密与找回 | 密码写入、凭据失效已归账户用例。复核原身份认领与本地准入的凭据资格有无可共用规则，两者分别保留身份判断、登录名写入和会话语义。                                                                                                                                                                                                                                                                     |
| 对话与历史           | `execution/attempt/execute.ts` 承接请求内和服务端的原生执行。`execute-turn.ts` 提供请求断连取消，`execution/driver/driver.ts` 持有服务端执行权。会话回看读取持久事件。                                                                                                                                                                                                                             |
| Run 控制与压缩       | `conversations` 统一写 compact 暂停、后继 attempt 和消费记录。暂停继续和批准恢复共享执行权交接与按 attempt 重放，资格及幂等键冲突规则各归入口。compact 在恢复 Run 前持久化后继快照。[空闲压缩](../../apps/api/src/agent/compact/start-idle-compact.ts) · [运行中压缩](../../apps/api/src/agent/compact/runtime-compact.ts)                                                                         |
| 提醒创建、交付和撤销 | 创建内联写 `task_events`，取消和调度复用 scheduler 内的 `appendTaskEvent`。账本应由 tasks 共同使用，创建继续在原事务写任务、事件和 outbox。取消插入冲突之后移除一次结果未使用的查询，保留原冲突回读条件。调度、取消和投递各自拥有命令资格与回执。[任务创建](../../apps/api/src/features/tasks/create.ts) · [取消存储](../../apps/api/src/features/tasks/cancellation/cancel-repository.ts)         |
| 今日简报             | 首页和工具读取同一服务，简报只投影任务和审批。Run 接纳、提醒修订和日范围计算各自格式化 UTC 秒值，可核对是否由 `time-core` 共用；冻结字段直接用于展示。[简报服务](../../apps/api/src/features/brief/service.ts) · [日范围](../../apps/api/src/features/brief/day-range.ts)                                                                                                                          |
| 受管资料             | 替换和创建都登记非事务调用，再用冻结计划、文件实际结果和调用绑定生成回执。检查公共回执字段和资源释放能否净减。替换对原版本做条件发布，创建要求文件不存在且携带文件身份。各自保留 `rename` 或 `link` 语义、查证和新回读。[工作区工具](../../apps/api/src/agent/tools/workspace/workspace-handlers.ts)                                                                                               |
| 跨会话记忆           | 首次保存和订正各写一次同形的 revision SQL。候选由记忆服务共用 revision 写入。保留保存的幂等键、订正前的原来源核验和并发版本检查，以及省略新有效期时继承旧有效期的规则。[记忆服务](../../apps/api/src/features/memory/service.ts)                                                                                                                                                                   |
| 模型接入与默认项     | Web 有一份仅被测试调用的 `http-gateway.validateDraft`，生产表单使用 `model-config.validateDraft`。删除测试专用实现并把行为断言对准实际表单。服务端更新与 CLI 导入已共用 URL 的协议和字段限制，各入口保留自己的业务前置及事务。[Web HTTP 调用](../../apps/web/src/features/model-settings/model/http-gateway.ts) · [配置服务](../../apps/api/src/features/model-providers/configuration/service.ts) |
| 飞书连接和 Docx      | 连接、工具读取、结果加密和私密输出分别由连接服务、工具网关及会话持久层处理。增量输出和两种终态都检查披露资格、追加事件并登记待披露记录。候选是让共用发布操作持有这三个步骤，各入口继续使用自己的事件类型与授权时点。[终态处理](../../apps/api/src/agent/execution/result/finish.ts) · [协议会话](../../apps/api/src/agent/execution/attempt/session.ts)                                            |
| 办公资料处理         | 浏览器负责 CSV 分析和下载，提醒回到原有提醒链。纪要摘要通过独立的一次模型调用读取文本，不推进 Run。单独评估其提示和模型请求；迁移优先处理参与同一 Run 恢复的 compact 摘要。[资料操作](../../apps/web/src/features/conversations/view/office-materials.tsx) · [纪要摘要](../../apps/api/src/features/model-providers/summarize-office-notes.ts)                                                     |

HTTP socket 与 Elysia 共用 `x-request-id` 单值校验。公开事件、原生快照与路由回执共用 checkpoint 插入和 attempt 内编号，SSE 继续使用数据库返回的全局游标。[HTTP 访问](../../apps/api/src/http/access.ts) · [Checkpoint 存储](../../apps/api/src/features/conversations/run/repository.ts)

本地安装、启停和升级由 `scripts/local/runtime.mjs` 主导。它们重复检查升级记录、卷归属、产物和数据库状态。分别核对允许启动 PostgreSQL、停止写者和使用备份的阶段之后，再合并相同前置检查。本地账户和工作区维护由 `scripts/local/account.mjs` 接收输入，它重复实现的 schema 版本门可复用 `assertInstallationSchema`，同时保留本机账户的最低迁移版本。模型导入由 `bin/import-model-provider.ts` 验证输入形状，再调用配置服务，入口的长度限制与服务内模型、名称和凭据校验各自保留。[安装执行](../../scripts/local/runtime.mjs) · [本机账户](../../scripts/local/account.mjs) · [模型导入](../../apps/api/src/bin/import-model-provider.ts)

## 其余 API 链路

- **提醒、批准、调度、通知、简报。** 将提醒工具按创建、查询、取消导航。scheduler repository 的操作按对应阶段追踪。以确认原子事务、取消后零触发、独立回执和简报只读投影验收。保留已有 Worker 阶段顺序。[取消测试](../../apps/api/test/integration/tasks-cancel.test.ts) · [调度恢复](../../apps/api/test/integration/scheduler-recovery.test.ts)
- **模型与办公摘要。** 模型配置归 `configuration`，出站规则归 `outbound`，SDK 模型请求归 `inference`。Run 绑定使用已冻结的模型，独立摘要读取当前默认项。[模型配置](../../apps/api/test/integration/model-providers.test.ts) · [办公摘要](../../apps/api/test/integration/office-notes-summary.test.ts)
- **本地文件、飞书、记忆与路由。** 本地文件沿用 `registry/read/write/mcp`。飞书按连接、文档读取绑定、私密披露导航。记忆区分用户管理、召回及 compact 来源。只读路由关联策略、会话执行和结果发布，测试能沿完整路径找到。[飞书私密历史](../../apps/api/test/integration/feishu-private-history.test.ts) · [记忆原生链路](../../apps/api/test/integration/memory-native-wiring.test.ts) · [路由权限](../../apps/api/test/integration/routing-authority.test.ts)
- **进程、基础 HTTP 与维护 CLI。** 入口索引覆盖 `api|worker|all`、探针、资源关闭、发布等待检查和停跑。时间规则沿用 `time-core`；连接、背压和响应交付归 HTTP 传输边界。按现有角色与 HTTP 入口验收实际启动和退出路径。[启动装配](../../apps/api/src/bootstrap/application.ts) · [角色测试](../../apps/api/test/role.test.ts)

## 评审与交付

1. 每批描述一个可观察行为和它的正常入口，标出事实所有者、锁与提交点、失败结果及测试。用入口索引记录关键文件与测试，语言围绕业务动作。
2. 为行为保持型拆分复用已有测试。覆盖不足时，仅补能发现实际回归的用例。风险集中在 SQL 锁序、执行权、事件顺序和未知副作用的批次，在真正的 PostgreSQL、HTTP 或原生边界验证。涉及仓颉交互时使用现有 Linux x64 合同入口。
3. 用一次业务走查评估每批的可读性。例如从 `POST /api/v1/auth/password/reset` 定位全部持久结果及故障测试，或从 Run 继续定位恢复所依据的快照。行数用于挑选审查对象。
4. 更新现有依赖规则以体现实际入口。逐批评审和合并，回退单位与用例批次一致。

## 重构后的 API 目录

`features` 继续按业务事实组织。`agent` 按 Run 用例、执行和工具效果组织。目录树覆盖 `apps/api/src` 的所有顶层入口和业务模块，展开需要定下归属的子目录及文件。细小模块继续平铺。

```text
apps/api/src/
├── main.ts                     # 进程入口与关闭信号
├── client-type.ts              # Web 的 Eden API 类型入口
├── bootstrap/                  # api、worker、all 与维护进程的资源装配
├── http/
│   ├── app.ts                  # Elysia 控制器装配
│   ├── server.ts               # Node HTTP 监听
│   ├── access.ts               # HTTP 身份、请求准入与 CSRF
│   ├── errors.ts               # HTTP 错误映射
│   ├── request/                # 请求路径、受限请求体
│   ├── transport/              # socket 桥接、响应写入、背压与收尾
│   ├── routing/                # 未匹配路由
│   └── health/                 # 存活与就绪探针
├── agent/
│   ├── run/                    # 消息接纳、取消、查询、用户继续、批准恢复
│   │   ├── approvals/          # 文档批准和拒绝后的 Run 收尾
│   │   ├── continuation/       # 目标澄清与前驱回执
│   │   └── maintenance/        # 发布维护停跑
│   ├── execution/
│   │   ├── attempt/            # 单 attempt 的快照恢复、仓颉帧、模型与工具
│   │   ├── driver/             # 跨请求执行生命周期和持锁资格
│   │   └── result/             # 目标证据、披露和终态组装
│   ├── compact/                # 压缩请求、后继执行、摘要与记忆发布协调
│   ├── harness/                # 子进程和帧编解码
│   ├── routing/                # 可选路由事实、评分、渲染及路由回执
│   └── tools/
│       ├── gateway.ts          # 工具调用入口
│       ├── definitions.ts      # 工具到执行类型和处理函数的登记
│       ├── invocations/       # 调用身份、预约、效果接受与回执读取
│       ├── evidence/          # Run 调用回执和目标证据
│       ├── observations/      # 已接受观察的分页回读
│       ├── memory/            # 记忆工具适配
│       ├── reminders/         # 提醒能力的工具参数与结果适配
│       ├── workspace/         # 受管资料工具适配
│       └── feishu/            # 飞书读取工具适配
├── features/
│   ├── conversations/
│   │   ├── history/            # 消息、事件回读和合法来源
│   │   ├── run/                # Run 与 attempt 状态、消息、checkpoint 和幂等记录
│   │   └── compact/            # 压缩操作、来源、摘要和后继持久事实
│   ├── identity/
│   │   ├── account/            # 建号、认领、成员、联系邮箱、密码用例
│   │   ├── session/            # Better Auth、会话认证和流访问
│   │   ├── security/           # 凭据失效、挑战密钥、限流
│   │   ├── delivery/           # 身份邮件与传输
│   │   └── profile/            # 本人偏好与显示
│   ├── approvals/
│   │   ├── reminder/           # 提醒冻结展示、审批与修改
│   │   └── document/           # 文档批准事实、规则和查询
│   ├── tasks/
│   │   ├── create.ts           # 创建任务，原子登记创建事件与排期命令
│   │   ├── task-event-ledger.ts # 任务事件追加规则
│   │   ├── read/               # 列表、详情、活动、简报和工具投影
│   │   ├── cancellation/       # 取消资格、请求与命令
│   │   └── scheduler/          # 调度、领取、发送、回执、撤销和过窗
│   ├── notifications/          # 站内通知投递、接收事实与回执读取
│   ├── brief/                  # 今日简报的任务、批准投影与日期范围
│   ├── workspaces/
│   │   ├── registry/           # 受管工作区登记、grant 与路径政策
│   │   ├── read/               # 受控文件读取、列表、搜索
│   │   ├── write/              # 条件替换、有限创建与真实字节发布
│   │   ├── mcp/                # 受管文件 MCP 入口
│   │   └── http/               # 工作区 HTTP 入口
│   ├── memory/
│   │   ├── records/            # 保存与订正的 revision 事实
│   │   └── recall/             # 召回、语义检索与出处回执
│   ├── model-providers/
│   │   ├── configuration/      # 提供商设置、凭据、默认模型与导入
│   │   ├── run-binding.ts      # 每个 Run 冻结的模型选择
│   │   ├── inference/          # SDK 协议转换、计量和流式模型传输
│   │   ├── outbound/           # 出站策略、连接测试与错误
│   │   └── http/               # 模型设置和独立纪要摘要入口
│   ├── office-connectors/feishu/
│   │   ├── connections/        # 连接登记和租户 token
│   │   ├── docx/               # 文档配置、冻结 grant 和读取
│   │   └── observations/       # 观察凭据加密与解封
│   └── time/                   # 可信时间输入与 time-core 调用
├── worker/                     # 提醒阶段、身份邮件的定时驱动和关闭
├── bin/                        # 数据维护、模型导入、发布检查与停等
├── db/                         # PostgreSQL 连接池与事务原语
└── platform/                   # 通用错误、编码服务与向量计算
```

`bootstrap` 装配 HTTP、worker 与执行 driver。`http/app.ts` 组装各功能控制器，控制器调用本功能用例或 `agent/run`、`agent/compact` 的公开入口。`agent/run` 和 `agent/compact` 调用 `agent/execution`，具体执行入口由调用方组合。请求断连通过调用方提供的回调进入持久取消，driver 通过注入的任务运行 compact 后继。`execution` 调用仓颉进程、工具网关和业务模块公开接口。工具网关负责预约与回执，业务模块负责自己的授权事实、写入和事务规则。跨功能调用沿用现有 `public.ts` 边界。同一会话事务可直接组合 `run/repository.ts` 的 Run 状态、`run/messages.ts` 的消息来源、`run/checkpoints.ts` 的 checkpoint 和事件回读、`run/idempotency.ts` 的请求账本。

### 原路径与实际去向

| 原路径                                                                                                | 实际位置和职责                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/operations/start.ts`                                                                           | `agent/run/admit-message.ts` 负责消息接纳，`agent/compact/start-idle-compact.ts` 负责空闲压缩。                                                                                                                                                                       |
| `agent/operations/run.ts`、`run-view.ts`、`release-stop.ts`                                           | `agent/run/run-actions.ts` 负责查询、取消、批准恢复和发布检查，和 `pause.ts` 共用 `resume-run.ts` 的执行权交接。投影与维护停跑归 `run-view.ts` 和 `maintenance/release-stop.ts`。                                                                                     |
| `agent/operations/execute.ts`、`pause.ts`、`public.ts`                                                | `agent/run/execute-turn.ts` 分派确定性提醒和请求内 Harness 执行。`agent/run/pause.ts` 负责暂停和继续。控制器和 CLI 使用 `agent/run/public.ts`。                                                                                                                       |
| `agent/operations/document-decision.ts`、`reject-document.ts`、`target-continuation.ts`               | 文档批准和拒绝归 `agent/run/approvals`，目标澄清的后继判定归 `agent/run/continuation`。审批事实和文档规则留在 `features/approvals/document`。                                                                                                                         |
| `agent/operations/compact.ts`、`compact-execution.ts`、`compact-model.ts`                             | `agent/compact/runtime-compact.ts` 处理运行中压缩和后继，`execute-compact.ts` 协调摘要、计量与记忆发布，`compact-model.ts` 组装摘要请求并校验模型结果。                                                                                                               |
| `agent/operations/finish-attempt.ts`、`finish.ts`、`goal-result.ts`、`run-approval-decision.ts`       | `execution/result` 的 `finish.ts`、`commit.ts`、`goal-result.ts`，以及 `execution/load-approval-decision.ts`，依次处理终态帧、终态组装、目标证据和冻结批准事实。持久化终态沿用 `features/conversations/run` 的事务入口。                                              |
| `agent/runtime/attempt-{load,session,model,tools,pause,routing,snapshot,state}.ts`                    | 归 `agent/execution/attempt`。`session.ts` 负责帧分派，其余文件名对应加载、模型、工具、安全点、路由、快照和内存状态。                                                                                                                                                 |
| `agent/runtime/run-driver.ts`、`run-ownership.ts`、`private-output.ts`、`frozen-tool-eligibility.ts`  | 分别归 `execution/driver/driver.ts`、`execution/driver/ownership.ts`、`execution/result/private-output.ts` 和 `execution/attempt/frozen-tool-eligibility.ts`，负责后台执行、执行权、私密输出资格和冻结工具资格。                                                      |
| `agent/runtime/context.ts`、`contracts.ts`、`config.ts`、`run-snapshot.ts`、`compact-continuation.ts` | 执行依赖与上下文加载归 `agent/execution`，帧组装随 `attempt/load.ts`，服务装配归 `bootstrap`。历史快照解码归 `features/conversations/run/snapshot-storage.ts`。compact 后继读取和 R3 快照来源校验归 `features/conversations/compact`，由压缩和 attempt 启动共同使用。 |
| `features/conversations/lifecycle/{service,reminder-date}.ts`                                         | 会话详情归 `history/conversation-detail.ts`，提醒日期澄清证据归 `run/reminder-date-continuation.ts`。                                                                                                                                                                 |
| `features/tasks/service.ts`、`scheduler/scheduler-repository.ts`                                      | 任务读取归 `tasks/read/queries.ts`，调度共用的事件追加归 `task-event-ledger.ts`，各阶段的资格和状态写入留在 `scheduler`。                                                                                                                                             |
| `features/identity/account/invited-service.ts`、`features/memory/service.ts`                          | 账户按邀请、联系邮箱和密码动作导航，继续复用身份事务能力。记忆在保存与订正处复用 revision 写入，管理与召回按本次真实操作命名。                                                                                                                                        |
| `features/model-providers/runtime/`、`outbound/summarize-office-notes.ts`                             | Run 冻结绑定移到模型功能根目录，SDK 传输归 `inference`，纪要摘要使用独立用例 `summarize-office-notes.ts`。                                                                                                                                                            |

同一目录内以动作或事实命名文件，例如 `admit-message.ts`、`revoke-session.ts`、`task-event-ledger.ts`。`controller.ts` 和 `public.ts` 是固定入口约定。对于 `service.ts`、`model.ts`、`context.ts` 一类名称，结合所在目录检查能否直接定位到一个用例或一种事实。文件拆分、合并和改名一起纳入所属批次，验收时从实际入口查到状态写入、失败处理及对应测试。以现有 dependency-cruiser 规则检查实际跨层依赖。

## 按业务链路划分仓颉与 TypeScript

仓颉决定当前 Run 接下来做什么。TypeScript 核准这一步能否按真实身份和当前资格执行，调用模型或领域能力，并记录已发生的事实。一次工具调用中，仓颉选择动作和消费回执，TypeScript 绑定调用、执行效果和持久化回执。这个边界沿用 [ADR 0009](../adr/0009-cangjie-harness-ts-capabilities.md) 和 [执行合同](../../openspec/specs/agent-runtime/spec.md)。

### 从入口走到用户结果

**普通对话、首步路由与 SSE。** 消息入口由 TS 接纳消息、冻结模型和能力范围，并根据 Run 生命周期启动仓颉。CJ 决定直接读取还是进入模型循环，组织上下文、模型和工具的顺序，消费已接受的增量。TS 持有模型凭据、传输和计量，执行工具并向 SSE 追加可披露的事件。CJ 已有首步选路，TS 的 `routing.choose` 在直达工具前独立核验冻结策略和缓存证据。直达核验留在 TS，这批保留两侧一致性测试。SSE 断连和事件补读仍由入站生命周期和已有事件裁决。[消息接纳](../../apps/api/src/agent/run/admit-message.ts) · [原生选路](../../apps/harness/src/session/routing.cj) · [宿主核准](../../apps/api/src/agent/execution/attempt/session.ts) · [路由授权验收](../../apps/api/test/integration/routing-authority.test.ts)

**长对话、停下、继续和压缩。** CJ 使用真实上下文计量、冻结阈值、剩余预算和未覆盖消息决定是否提议自动压缩。TS 在暂停探测中核准提议，处理已登记暂停优先和同覆盖去重，并保留加密快照、原子发布和后继 attempt 激活。CJ 保存待消费模型响应，组装摘要请求、解释结果并预演恢复。空闲压缩由 TS 创建控制 Run，复用原生摘要执行。[原生决定](../../apps/harness/src/session/context.cj) · [宿主核准](../../apps/api/src/agent/execution/attempt/pause.ts) · [HTTP 验收](../../apps/api/test/integration/r3-compact-http.test.ts)

**提醒创建、澄清、确认和撤销。** 自然语言工作流里，CJ 决定何时调用提醒工具、何时向用户澄清、收到结果后如何继续。TS 按来源消息、目标和时间锚受理澄清，使用 `time-core` 定时，由任务和批准用例决定能否写入。Web 快捷入口使用 `business`，由 TS 直接调用同一领域能力。新委托范围内能直接创建的仍直接创建，legacy 按冻结展示确认。此链优先在 TS 合并领域调用与证据读取。澄清的历史目标回绑、时区来源和范围收敛属于接纳资格，继续由 TS 核验。[澄清接纳](../../apps/api/src/agent/run/admit-message.ts) · [确认写入](../../apps/api/src/features/approvals/reminder/confirm.ts) · [提醒验收](../../apps/api/test/integration/direct-reminder.test.ts) · [澄清验收](../../apps/api/test/integration/target-continuation.test.ts)

**受管资料、文档批准和飞书。** CJ 组织读取、拟定写入、等待批准和写后复读，根据被接受的证据决定下一步。TS 校验冻结工作区、连接、版本和实际字节。确认授权只产生对冻结动作的许可，TS 为原 Run 续接 attempt，CJ 把决议带回上下文后选择写入或结束。调用账、未知效果查证、私密内容加解密和披露资格由 TS 持有。适合进一步迁入 CJ 的是批准恢复和手动继续共用的执行状态解释，需先定位 TS 对执行状态的实际重建，逐段切除。按当前代码保留已接受工具、批准和原始来源的绑定核验，包括 compact 后继读取时与已发布事实的比对。[继续入口](../../apps/api/src/features/conversations/controller.ts) · [恢复交接](../../apps/api/src/agent/run/resume-run.ts) · [原生恢复](../../apps/harness/src/session/restore.cj) · [文档批准验收](../../apps/api/test/integration/document-approvals.test.ts) · [飞书披露验收](../../apps/api/test/integration/feishu-private-history.test.ts)

**跨会话记忆。** CJ 决定何时召回以及哪些已接受的观察进入本轮上下文。TS 校验压缩候选对本批消息的来源引用和顺序，持有记忆版本、有效期、用户订正和原消息证据，在写入和读取时核验。后续从「保存或订正后再提问」验收 TS 读写减量及 CJ 的观察纳入行为。[记忆用例](../../apps/api/src/features/memory/service.ts) · [原生接线验收](../../apps/api/test/integration/memory-native-wiring.test.ts)

**调度、投递和后台撤销。** 用户创建或取消提醒后，worker 从 outbox 推进调度、发送和撤销。消费资格、并发认领、调度回执、发送对账及任务终态均由 TS 依据 PostgreSQL 事实判定。这条链没有模型执行步骤，简化集中在 TS 的查询、锁和状态写入。账户、安装维护、模型配置和办公纪要单次摘要同样由对应 TS 用例拥有。办公摘要在默认模型下独立调用传输，使用自己的业务输入和输出。[应用与 worker 装配](../../apps/api/src/bootstrap/application.ts) · [投递对账](../../apps/api/src/features/tasks/scheduler/delivery.ts) · [调度恢复验收](../../apps/api/test/integration/scheduler-recovery.test.ts) · [纪要摘要验收](../../apps/api/test/integration/office-notes-summary.test.ts)

### 迁移切片与验收

1. **普通对话进入自动压缩，再回到同一 Run。** CJ 从冻结策略和宿主计量决定是否提出 `pause_probe.auto_compact`。TS 在原事务中验证当前 attempt 与新鲜计量，核准执行权、取消、既有暂停和同覆盖去重。TS 的 `shouldAutoCompact` 与 `lastMeasurement` 已删除，宿主只保留核准所需的计量状态。原生 HTTP 覆盖阈值、规划窗口、预算和计量不匹配，以及压缩后继续同一 Run。宿主集成测试覆盖计量与安全点许可、暂停去重。[提议核准验收](../../apps/api/test/integration/auto-compact-probe.test.ts) · [压缩失败验收](../../apps/api/test/integration/auto-compact-failure.test.ts)
2. **手动继续、批准恢复和压缩续跑一起核对。** 用同一份原 Run 的输入和已接受回执比较启动与各恢复分支，定位 TS 实际生成的下一步执行状态。把能从快照和已验证回执重建的部分并入 CJ 恢复。TS 保留版本解码、旧等待点拒绝、来源和权限核验、后继 attempt 原子激活。预演已由 CJ 完成，后继快照的持久化重建涉及覆盖、预算和加密证据，需先区分数据库事实校验与执行上下文构造，再决定具体删除范围。验收覆盖 v6/v7/v8 及其历史快照、批准继续、拒绝、过期、撤权、取消和未知写入。[暂停 HTTP](../../apps/api/test/integration/pause-http.test.ts) · [执行权 HTTP](../../apps/api/test/integration/harness-authority-http.test.ts) · [后继快照核验](../../apps/api/src/features/conversations/compact/compact-continuation.ts)
3. **独立清理工具和领域链路。** 用同一条提醒和文档入口验收调用账，按本地事务、外部只读、非事务写入整理 TS 调用路径，删除各自重复的登记和证据转发。保持调用 ID、锁顺序、回执及 `unknown` 查证行为。用会话读取、直接提醒、确认创建、文档复读和撤权证明切换，后台投递继续通过实际回执门验收。首步直达资格将来若要共用判定，先为宿主独立核准提供等价的输入绑定、历史重放和反向授权证据。

暂停和批准挂起在各自锁定的 Run 事务内复用 checkpoint 核验所读取的调用账。v8 暂停复用共用核验对待处理模型结果和工具观察的检查，v7 暂停保留 version 3 特有的检查，并使用已经读取的恢复观察。压缩续跑与后继快照回读基于同一份操作回执计算累计用量。

TS 组装摘要请求时合并旧摘要覆盖范围与本批消息，检查重复、顺序和缺口，并从冻结预算扣出续跑预留量。覆盖范围、预算、输入大小的错误仍按原顺序返回。TS 校验模型结果的覆盖范围和候选记忆来源，并负责计量及数据库发布。

普通 v8 恢复从快照重建上下文。压缩发布后，启动帧只在原快照之外传递已发布的新摘要，仓颉复用压缩预演的重建逻辑保留未覆盖的消息。TS 在恢复事务内复用同一份接纳事实核验快照和收据。

三代启动帧共用工具目录筛选、传输大小检查和冻结工作区校验。每代仍使用各自的快照和恢复输入。

模型请求、工具预约和调用入口在各自原有的事务里共用未决工具效果和批准等待的校验。重复取数的首步直达预约只读一次调用账。

每个切片交付时从真实入口观察用户结果、SSE 与持久化事实。使用同次构建的 CJ 原生产物，模型响应可以受控注入。记录删掉的 TS 状态或规则，以及 CJ、TS、共享合同的净变动。历史帧继续按其原版本解释，新帧只承载执行所需的冻结事实和提议。

盘点基线按三个生产源码目录各自统计。API 为 251 个 TS 文件、37,156 行，Web 为 168 个 TS/TSX 文件、16,567 行，仓颉为 16 个 CJ 文件、2,021 行。计入空行和注释，排除末尾空行。每批记录净变动及删去的规则、查询、文件或跨层调用，并以真实执行入口验证仓颉承担的责任。

### 实施计数

当前切片保留 TypeScript 摘要组装和解释。自动压缩阈值判定、续跑预演和快照上下文重建属于本切片；摘要组装和解释迁至仓颉后另行统计。

中断结算在核对冻结的 Run 绑定后，一次查询读取已完成的时区设置、提醒创建、提醒取消和记忆保存回执。各类回执仍按原顺序核验，文档效果沿用同一次 Run 绑定检查。暂停继续和审批恢复共用锁内的幂等回执读取，审批恢复用同一条查询读取后继 attempt 的状态。外部写入的单次派发和未知结果核对继续由工具账本负责。

该切片净增 API TypeScript 10 行，仓颉和共享合同无行数变化。运行时减少中断结算的四次数据库往返，以及审批恢复重放的一次数据库往返。
