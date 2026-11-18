# Elysia API 与全后端模块化重构方案

## 决定与范围

**用 Elysia 替换 Hono，同时重构整个 `apps/api/src` 的功能边界、状态归属和依赖方向。**目标不是换路由语法，也不是统一文件名，而是让维护者能按业务找到代码，从端点读懂输入、用例和输出，明确事务在哪里提交、断连后谁继续执行。

本方案取代 [Hono 重构计划](hono-backend-migration-plan.md) 的目标框架及实施路线；旧计划仅作为历史设计依据。性能不作为改选 Elysia 的前提：选型依据是用户明确的维护体验偏好，以及路由、schema、类型推导和客户端调用的集成能力，不宣称 Elysia 在本项目业务性能上胜出。

- **Required**：真正使用 Elysia 实例作为功能控制器；覆盖全部 API 源码，而非仅 conversations 或 HTTP；迁移全部调用方、测试、脚本与依赖规则，删除 Hono 和过渡实现。
- **Proposed**：采用下述功能目录、进程执行边界和 Eden 类型接入方式。目录名不是有效业务合同，实施时以状态、事务及真实调用核对具体文件拆分。
- **不改变**：独立 Bun API、Next 页面与同源代理、PostgreSQL 事实源、`api|worker|all`、仓颉唯一 Agent 循环、现有 API/SSE/数据库格式、权限及调度口径。
- **不包含**：实施代码迁移、UI 重写、ORM/微服务替换、邮件产品化、真实用户或供应商调用。方案完成不代表这些操作已获本轮执行授权。

已知 **SSE POST 幂等回放撤权竞态**单独保留：按用户要求本轮不修、不掩盖；允许隔离复现和回归测试。不得把它误写成 Elysia 迁移已解决，也不得因为已有缺陷而免测其他 SSE 路径。

## 设计依据与证据边界

本次直接核对的设计输入为 `D:/Projects/agents/Along-agent-hono-plan-20261117`；基线 commit 为 `02706890eed84f9155d3589b279220e8194555db`，输入包含未提交和未跟踪源码，**commit 不足以标识实际迁移起点**。实施第一步必须冻结完整源码清单、补丁及哈希；不从旧 main 重新实现并丢失工作树中已有功能。

观察到的具体问题与可复用成果：

| 实际输入                                                                                                                                                                                   | 判断与处理                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `http/native-routing.ts` 的 `NativeRouteContext` 同时包含 `IncomingMessage`、`ServerResponse`、Fetch Request、body、时间和整个 `AppDeps`；`createNativeRegistrar` 再包装路由与原始路径匹配 | 真实 Hono 已承接请求，但功能控制器仍依赖混合上下文；Elysia 不能再套一层相同 registrar。保留原始路径合同，删除整个旧上下文和 Hono 注册机制。 |
| `model-providers/http/native-routes.ts` 已把路由与具体配置用例放在一起，但手动 `safeParse`，响应经 `unknown` 包装；probe 取消直接监听 Node response                                        | 保留业务内聚成果，迁移为 Elysia schema、明确返回类型和请求取消信号；不能仅把 `register` 改为 `.post`。                                      |
| `conversations` 已分 lifecycle/run/harness/history/compact/goals/documents；identity、models、workspaces 等也已有子目录                                                                    | 不推倒有效拆分，但子目录存在不证明所有权清楚；将进程运行、工具执行与会话事实分开，其他模块按下面映射逐项验收。                              |
| `platform/errors.ts` 的 `HttpError` 兼作业务拒绝及协议错误；ownership 还需区分可继续的业务回滚与执行权失效                                                                                 | 不能只删名字或统一 catch。业务拒绝与运行故障的分类语义先保留，按规则所有权迁移，再由 HTTP 映射。                                            |
| `.dependency-cruiser.cjs` 按 `src/modules` 发现所有者，另有嵌套入口和存储限制                                                                                                              | 新目录必须同步规则与负例；不能通过改路径逃过检查。导入检查不证明 SQL 表所有权或锁序正确。                                                   |
| Web 模型设置 gateway 使用共享 Zod DTO、手写路径及 Fetch；API 已输出声明文件                                                                                                                | 可复用 schema 和声明产物接入 Eden，无需新增一套 DTO、代码生成器或新的通用客户端包。                                                         |

[功能对照与历史验证记录](../verification/api-functional-migration-2026-11-17.md)包含真实 HTTP/TLS、PG、native、角色和不同轮次的套件结果，也明确记录首次失败、定向补测和未覆盖项。它是风险清单和复用依据，**不是本方案或未来 Elysia 最终版本的通过证明**。本轮只做源码与文档研究，没有执行运行时实验。

合同优先级沿用仓库规则：行为以 OpenSpec 为准，字段与路由以 design/API/schema 为准，历史记录只解释证据。关键入口为 [安全合同](../../openspec/specs/v0-safety-contract/spec.md)、[对话](../../openspec/specs/conversations/spec.md)、[运行时](../../openspec/specs/agent-runtime/spec.md)、[工具](../../openspec/specs/tool-gateway/spec.md)、[身份](../../openspec/specs/identity/spec.md)、[工作区](../../openspec/specs/workspaces/spec.md)与 [API/流式设计](../design/10-api-and-stream-design.md)。不为匹配框架默认行为修改这些合同。

## 目标组织：功能、执行与基础设施分开

```text
apps/api/src/
  main.ts                         # 读取启动参数，启动与停止一个进程
  bootstrap/                      # 构造依赖、角色、release 检查和资源关闭
  http/
    app.ts                        # 组合功能 Elysia 实例，导出精确 App 类型
    access.ts                     # HTTP session/CSRF/请求准入策略
    body.ts                       # 有限 JSON 读取与解析
    errors.ts                     # envelope、request ID、错误响应映射
    health/                       # 探针 controller/model
    transport/                    # socket/可信连接元数据、上传收尾、Response 背压
  features/
    identity/                     # account/session/security/delivery/profile
    conversations/                # 会话、消息、Run 持久事实与历史；无 native 进程
    approvals/                    # reminder/document 冻结材料与决议事实
    tasks/                        # 创建、取消、事件、调度与回执
    model-providers/              # configuration/outbound/runtime
    workspaces/                   # registry/read/write/mcp
    memory/                       # 管理、来源与召回
    brief/                        # 简报只读组合
    notifications/                # 独立接收与投影
    time/                         # 可信时间上下文，调用 time-core
  agent/
    operations/                   # start/cancel/resume/pause/continue/compact/finish
    runtime/                      # 进程级 driver、ownership、attempt session
    harness/                      # native 进程通信、帧编解码与快照结构校验
    tools/                        # invocation 身份/许可/结果接受及分能力 handler
    routing/                      # 有界意图路由，使用 platform encoder
  db/                             # pool、借连接和事务原语
  platform/                       # 编码、向量及真正跨领域的基础能力
  worker/                         # 阶段轮询、定时器和停止；不复制领域逻辑
  bin/                            # 维护命令的参数和输出适配
```

`features` 表达业务能力，不是把 `modules` 原样改名。`agent` 不是新的万能模块：operations 只组织完整跨能力用例，runtime 持有执行状态，harness 只负责原生通信，tools 拥有调用许可和接受事实。禁止新增平行 executor/manager 各持一份 Run 状态。

### 功能内部的 Controller、Service、Model

有 HTTP 的功能使用 `controller.ts`、`service.ts`、`model.ts` 和需要的持久化实现；大功能按真实子能力放进子目录。控制器导出保留完整推导类型的 Elysia 实例或工厂。统一采用 `controller.ts`，不再保留 `native-routes.ts` 与 `routes.ts` 两种入口名称。

- **Controller**：直接声明方法、路径、输入与响应 schema，从经认证的请求中取明确参数，调用一个完整用例，处理 cookie/header/status。不得接 SQL、驱动循环或整个依赖包。
- **Service / 用例**：接受领域参数和所需依赖，不接受 Elysia Context、Node req/res、Next 类型；拥有业务判断、完整操作和事务。多个入口共享同一个用例，不重复权限或校验规则。
- **Model**：请求/响应 schema 及其推导类型；复用 `@along/contracts` 已有 schema，不另外造一套同名结构。数据库 row/持久映射归对应 repository，不把 Model 当作“全部业务对象”。
- **Repository / 存储操作**：拥有所属表和 SQL，接受显式 client，不能悄悄启动另一个事务。不是每条 SQL 都需要一个包装类。
- `controller.ts` 只在功能内聚时保持一个；账户、会话和邀请等大型能力可以有各自 controller/service/model，不把上百条路由堆入一个入口。
- worker、通知接收、时间纯规则、SDK transport、工具 invocation 等没有 HTTP 的能力不硬凑 MVC；不会为目录对称增加空 service 或 model。

### 全目录责任迁移表

| Hono 工作树输入                                                                | 目标与必须完成的责任变化                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`、`role.ts`、`release-*`                                              | main 保持薄入口；bootstrap 统一构造/关闭资源和角色边界。release 检查保留真实命令与运行资格，不在导入时启动服务。                                                                                                     |
| `http/app.ts`、`native-routes.ts`、`native-routing.ts`、`request/`、`routing/` | Elysia app 组合功能 controller；删除旧 registrar、NativeApp/Context、路由操作分派和重复写路径清单。准入与未匹配响应各有明确责任，不制造框架外第二路由器。                                                            |
| `http/server.ts`、`transport/`                                                 | 保留有真实合同价值的可信连接、上传收尾和背压机制；把 Node 类型限制在传输边界。最终监听方案见下一节。                                                                                                                 |
| `identity/{account,session,security,delivery,profile}`                         | 保留五种真实能力；从账户 HTTP 控制器分离输入/响应定义，Cookie 留 controller。邀请、恢复、限流、keyring 和邮件消费者不随框架改语义。                                                                                  |
| `conversations/{lifecycle,run,history}`                                        | 会话/消息/Run/attempt/checkpoint 的事实留 conversations；接纳与终结中的跨能力证据组合迁入 agent/operations。事实层不反向导入 tools、provider 实现或 driver。                                                         |
| `conversations/{harness,routing}`                                              | 迁入 agent/harness、agent/runtime、agent/routing；按进程/attempt/纯规则区分，不把整个大 session 文件原样搬走算完成。预算/上下文配置加载随消费者迁移，更新 main 装配；关联可变状态仍只有一个 attempt session 所有者。 |
| `conversations/{compact,goals,documents}`                                      | compact 来源/摘要/暂停及目标的持久事实归 conversations；模型调用、后继、文档决议与 Run 终结组合归 operations。目标授权规则不能降成通用 helper。                                                                      |
| `conversations/run-event-response.ts`                                          | 会话 HTTP 的 SSE 响应组件；只管事件订阅与披露，不成为运行驱动器。通用 socket 写入仍在 transport。                                                                                                                    |
| `tools/`                                                                       | agent/tools 拥有 invocation 稳定身份、许可、首次接受与审计；按提醒、偏好、记忆、工作区等分 handler，调用功能公开用例。gateway 不拥有任务创建/文件授权规则。                                                          |
| `approvals/{reminder,document}`                                                | 冻结材料、资格和决议归 approvals；提醒确认继续在同 client 调用 tasks。涉及当前 attempt 的文档决议编排归 operations，保持锁序。                                                                                       |
| `tasks/{cancellation,scheduler}` 及顶层文件                                    | 任务生命周期、取消、排期、投递对账各归子能力。用明确操作名区分完成排期、完成撤销和接收回执，不再让一个泛化的 receipt 操作掩盖语义；存储字段不因命名重构改变。                                                        |
| `model-providers/{http,configuration,outbound,runtime}`                        | HTTP 移入功能 controller/model，配置与凭据、版本绑定、SDK 单步流与计量、受控出站各自归位；不得依赖 ConversationDeps，也不重新引入 legacy 全局 fetch。                                                                |
| `workspaces/{http,registry,read,write,mcp}`                                    | HTTP 与功能入口统一命名；登记、路径/身份/grant、读取、发布分别内聚，共享一套规则。保留真实磁盘效果与真实回读，不增加万能文件 service。                                                                               |
| `memory/`、`recall/`                                                           | 管理、版本与召回留 memory；会话来源校验通过 conversations 的公开事务入口注入，保留同 client 和来源锁；语义编码复用 platform。                                                                                        |
| `brief/`、`notifications/`、`time/`                                            | 简报按公开读取组合，不新增表；通知保持独立接收事务；时间上下文与 normalize 适配分清，唯一计算权威仍为 time-core。小功能不强拆空目录。                                                                                |
| `db/`、`platform/`                                                             | 连接/事务原语与通用编码保留；游标、UUID 等辅助按实际消费者归位。业务错误按领域拥有，HTTP 映射集中；不改 ownership 对业务拒绝与失权的判别。                                                                           |
| `worker/`、`bin/`                                                              | worker 只编排领域阶段和邮件 tick；CLI 复用公开用例及最小装配，不从 HTTP 创建账户服务，不意外启动 HTTP、scanner 或 Run driver。                                                                                       |

模块内部可保留有意义的子目录；实现交付必须为整张表提供实际落点与变更依据，不能把“已检查，无需修改”当成大型混合目录的默认答案。确实内聚的小模块允许保持简单，需指出其规则和数据所有者。

工具类别、执行方式与 handler 的绑定归 agent/tools 的静态定义；`gateway.ts` 当前的 readOnly 数组与非事务工具判断不再各自维护一份类别，预约和分发读取同一份明确元数据，不扩展成动态插件系统、不改变已有工具的执行类别。`brief/tool-query.ts`、`tasks/tool-query.ts` 等投影仍由事实所有者实现，tools/query 仅组合，不集中搬入工具层直查私有表。

## 调用、状态和事务的唯一归属

### 依赖方向

- bootstrap 组合所有依赖；HTTP app 组合 controllers，不被业务模块反向导入。
- 功能 controller 调用本功能公开用例；对话/文档控制器可调用 agent/operations 的完整跨能力用例。**只有 controller 可以依赖 Elysia**；http 装配、错误适配和传输是明确例外。
- agent/operations 调用 features 的公开事务/查询入口和 runtime；runtime 负责进程执行，调用 features 公开资格与提交接口。features 不反向依赖 agent 具体实现。
- agent/tools 的 handler 调用功能能力；invocation 接受与调用资格通过窄的事务接口连接 conversations，不能为了打破循环把 SQL 复制到两边。
- features 之间仅通过有业务语义的公开入口调用；同一 owner 的内部文件可直接引用，不强迫所有内部调用穿过 barrel。
- 每个功能使用 `public.ts` 表达跨功能支持的操作，不 re-export 私有 repository。只有真实使用者需要的事务操作才公开；不建通用注册表、DI 容器或 BaseService/BaseRepository。

### 完整对话路径

```text
浏览器 → Next 同源代理 → Elysia 请求准入与功能 controller
→ agent/operations/start：接纳事务并冻结客户端选模意图、消息、Run/attempt 和策略
→ 提交后交给进程级 driver；attempt session 驱动仓颉
→ 仓颉选择单步模型通信或工具；SDK/受控出站或工具领域用例产生真实结果
→ operations 组合证据，conversations 与相关所有者在同 client 提交终结事实
→ controller 的 SSE 组件读取持久事件并按原合同披露；刷新仍只读历史
```

operations 是完整用例，不再持有另一份 session 状态。事务外模型/文件 I/O、事务内资格与结果接受仍分别进行。断开 SSE 不等于取消 server-owned Run；request-bound 执行按原合同中止。暂停、批准恢复、runtime compact 后继是三种入口，不合并成“自动继续”。

### 不能被目录拆分破坏的事务

1. **接纳与幂等**：owner、幂等意图裁决、消息、冻结授权/时间/模型、Run、attempt 及账本保持原子；命中旧键先重放原 Run，不重新解析当前默认。server-owned 保留同一个持锁 PG session。
2. **批准与任务**：批准锁、presentation hash、创建/取消 task、event、outbox 和 consumed 同 client；失败全回滚，重复回原目标。取消先提交 cancel_pending，真实回执前不写 cancelled。
3. **工具三类执行**：本地效果与接受审计同事务；外部读为短事务资格、事务外 I/O、短事务重验接受；外部写先持久许可/unknown，外部效果后单独接受，未知不自动重试。
4. **文档决议与终结**：保持 attempt→Run→invocation/批准等既有锁序；assistant message、checkpoint、attempt、Run 和 pause 失效按原合同原子提交。迟到事实可以记账，不因此恢复执行或披露资格。
5. **暂停与 compact**：暂停事实与唯一后继、预算和已接受动作不重置；摘要精确来源/CAS 发布与记忆候选分别提交，候选失败不回滚摘要；控制 Run 不伪造用户消息。
6. **记忆与调度**：来源验证沿用同 client 与锁；worker 保留取消优先、投递 unknown 对账和独立通知接收。只追加 task_events、唯一约束、回执终态门不变。

终结的分界要落到实际数据：`commitTerminalFacts` 对自身 checkpoint delta 的读取、排序、assistant message 聚合及写入继续归 conversations，并在原终结事务中完成一次；operations 只提供其他所有者的必要证据，不在事务外预聚合或重复读取同一文本。session 的同步帧处理通过明确调用进入 invocation 许可/接受，不能在二者之间增加新队列或第二个提交点。快照的结构编解码归 harness，持久事实加载与执行资格由 conversations 公共入口和 runtime 校验，不让进程通信层成为授权权威。

调用方可显式传 `PoolClient` 给公开的 `*WithinTransaction` 用例；不引入泛型 UoW 或事件总线替代同步原子操作。操作命名要说明是否拥有事务、是否启动执行、是否可能产生外部效果；不在整个项目机械增加后缀。

错误迁移与事务批次一起进行：领域拒绝采用不含 `httpStatus` 的明确错误类型及稳定 `errorCode/details`，HTTP 层统一映射原 numeric code/status/envelope。迁移全部 `HttpError` 使用者后删除旧类，不提供兼容 re-export。ownership 必须继续识别原来允许事务回滚后继续的业务拒绝；驱动/SQL 故障、提交不确定和失锁仍使执行权失效，不能简单把“所有新错误都可重试”作为替代。

## Elysia 真实接入，而不是形式上的实例

### 监听与传输选择

**首个切换版本选用已有 Node HTTP socket 边界 + Elysia `handle(Request)`；Bun 仍为运行时。**保留其已明确承担的连接元数据、上传收尾和 Response 背压，不同时重写网络栈。Elysia 接收实际方法、URL、headers 与真实 body，并负责全部正式路由、schema、controller 和响应；禁止 Elysia→Hono 转发、合成空请求匹配或异常时回退旧 handler。

这里保留的是传输，不是旧业务分发器。`IncomingMessage/ServerResponse` 不得继续进入功能 controller；传输层提供最小可信连接与 AbortSignal，不附带 pool、account service 或业务运行时。`handle` 方式在选定 Elysia/Bun 版本的真实 socket 兼容性必须先做纵切验证，**当前方案没有证明它已通过**。

Bun 原生监听与官方 `@elysia/node` 是可选后续简化，不作为完成模块化重构的前置目标，也不默认更换部署运行时。只有真实测试证明同等 peer/TLS、上传拒绝、流控、取消及关闭合同，才可用其替换旧 transport 并删除被替代代码；不同时永久维护两种生产监听模式。

源码的 `http/server.ts` 只创建明文 HTTP server；TLS 是传输合同及测试能力，不代表生产已有 TLS 监听。继续保留现有本机两端 loopback 或安装专属 proxy capability 的路径，不信任客户端 forwarded 头，不在此次迁移中暗增 TLS 配置与证书管理。

### 准入必须早于 body 消费

官方生命周期的 Parse 先于 Before Handle，因此**不能把原有鉴权放到 `beforeHandle` 后就使用默认 JSON parser**。实施采用以下责任顺序：

1. 最外层生成/继承合法 request ID，获取真实连接元数据；探针、账户精确入口和普通业务沿原错误优先级处理。
2. 普通业务写在 `onRequest` 中只完成原有前缀范围的 session 检查，未认证仍先返回 401；此处不读取 body，也不假设已经匹配到具体路由。前缀与账户例外来自功能 controller 的装配配置，不另维护精确 POST 路径表。
3. 匹配到的 POST 显式绑定 parser：先按所属功能完成 CSRF、模型连接资格和声明长度检查，再调用有限 JSON 读取；账户使用其精确路由的 Origin/签名 session/CSRF 策略。未匹配请求不进入 parser，由 Elysia NOT_FOUND 的兼容响应保留原 404 与功能级错误优先级。
4. 有限读取按原始字节累计，Content-Length 仅作提前提示，chunked 也遵守 `131072/131073` 字节边界；解析后才做输入 schema 校验与用例调用。
5. 默认 VALIDATION/PARSE/NOT_FOUND 等框架错误映射为既有状态码、error_code 和 envelope，不把现有 400 擅自变为默认 422；领域时间错误等仍按各自合同。
6. 未结束上传收到完整有限 401/403/404/413 后及时关闭；运行时已缓冲字节不是失败，不要求“绝不读取任何字节”。开流后不再输出 JSON。

这个安排利用“先认证、框架匹配、匹配后的 parser 才检查 CSRF 和读取”的顺序，不需要查询 Elysia 私有路由表或重建 `hasRegisteredPost`。功能 controller 直接在 `.post()` 中绑定共享 parser/准入策略，不经过自建 registrar；解析器只处理输入，不调用业务 handler。固定版本须先验证未知路由不会消费 body、空体动作也执行显式 parser、预选内置 parser 不绕过前置检查，以及原始路径和重复 query 的语义。任一项不成立时停止纵切切换并修订此适配设计，不允许悄悄恢复重复精确路径表。`onRequest` 的临时认证结果仅限当前请求，供后续显式取参使用，不共享可变 actor 或把框架 Context 传入 service。

插件采用显式依赖和明确 scope；身份 hook 不能依赖 `.use` 的偶然顺序，也不能全局导出后误伤匿名开户和探针。测试必须覆盖父/子功能及注册顺序，证明未登录不能漏过，匿名允许入口也不被误拦。

### SSE、cookie 与取消

- JSON controller 返回有 schema 的对象或带状态的明确结果，不把全部返回值擦成 `Response | unknown`，否则 Eden 得不到有效类型。
- SSE 是明确的流式 Response 例外：先保留现有字节格式、事件版本、`data` 帧及 after_seq，不为了采用 Elysia `sse()` 改协议。
- 订阅慢消费者的等待在事务外；背压不能长期持有授权事务或 PG 连接。断连清理监听和订阅，实际执行是否取消由原生命周期决定。
- probe 使用请求取消信号，不再在功能内监听 Node response；不把浏览器断开隐式解释为重试许可。
- 分别验证 GET 订阅、POST request-bound 执行和 POST 幂等前缀回放的背压。源码中只有订阅路径显式等待 `sink.ready()`，其余两条没有同样等待；**[INFERENCE]** 慢消费者下可能持续积压队列，现有订阅测试不能排除此风险。先在冻结基线和迁移版用相同受控慢读场景确认，不能把推断当已复现缺陷，也不把其他路径测过背压写成它们已通过；若确认，单独记录并明确处理范围，不静默夹带修复或豁免验收。
- 保留多条 Set-Cookie、Cookie 签名、Cache-Control、Retry-After、请求 ID，以及原始路径/编码、重复 query、HEAD、未知方法和尾斜杠差异；不采用框架默认值代替合同。

## Schema、Eden 与 Next 的类型贯通

官网确认：Elysia 支持 Standard Schema/Zod；Eden 使用 TypeScript 推导而非客户端代码生成；OpenAPI 文档需插件，Standard Schema 的 JSON Schema 转换需配置。它们不能代替运行时鉴权、数据校验或数据库映射。

本方案把 **JSON API 到现有 Web gateway 的 Eden 接入**包含在交付内，而不只是预留类型能力：

1. Controller 的 model 复用 `@along/contracts` 中现有 schema；业务校验仍在真实用例边界。局部 HTTP schema 归功能 model，不把所有结构集中进新的全局 schema 文件。
2. `http/app.ts` 提供无启动副作用的 app 工厂，并导出 `App = ReturnType<typeof createApp>`。禁止将工厂返回类型宽化为基础 `Elysia` 或靠 `any`/双重断言保住编译。
3. `@along/api` 提供仅类型的 `client-type` 导出，指向已有 TypeScript declaration 产物；Web 只 `import type`，客户端不导入 main/bootstrap 或 server 实例。不新增通用客户端 workspace，也不让 contracts 反向依赖 API。
4. 构建顺序显式调整为共享包→API 声明→Web，更新根 build/typecheck、CI 范围依赖和 Web workspace 类型依赖；不能依赖本机残留 dist 或应用 filter 的偶然顺序。native 构建仍沿用独立既有脚本。
5. Browser 继续访问 Next 同源代理，不直连 API；Eden 通过现有网关复用 session/CSRF、credentials、错误适配和取消。RSC 仍从服务器地址读取，只转发所需 cookie；不能把本机 capability 发给浏览器。
6. 按功能迁移全部 JSON API gateway/RSC 调用，不改组件、交互和布局；避免同功能永久维护 Eden 与手写 path 两套客户端。SSE 继续使用现有版本化 stream-protocol 消费者，不要求 Eden 替代持久事件协议。
7. 对动态路径、输入、成功与错误 envelope 提供类型证据；401/403/409/503 等 hook 错误也纳入声明，不能只推导成功对象。保留现有运行时响应 schema 校验，直到已证明相应信任边界不再需要；不以类型推导为由自动删除。

Elysia、Eden 与所需适配依赖在第一纵切中选择并固定正式版本，验证与 Bun 1.4.2、TypeScript 5.9.3、Zod 3.25.76 和 NodeNext 声明构建兼容，再写入单一 lockfile；官网示例不证明本仓库组合已兼容。不为了采用 TypeBox 附带升级整个 schema 栈。

OpenAPI 自动文档不是本轮产品交付，不新增公开文档端点；后续需要时可复用 route schema 配置插件。Eden 类型中可以看到路由结构，不得包含凭据、真实数据或服务实例。

## 实施批次与退出条件

每批由一个集成负责人拥有共享装配和事务边界；独立能力可分工，但不得把整个任务原样层层转包。实施与验证责任在开始时指定，已对应最终代码的有效证据不重复执行。

| 批次                      | 完整交付单位                                                                                                                                               | 退出条件                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0：冻结与对照             | 保存 Hono 工作树完整脱敏快照；按真实注册及有效合同列方法/路径、匿名/写入策略、schema、调用方、表与状态所有者和测试；固定运行环境及已有失败                 | 包括未跟踪源码、维护 CLI 和 worker；每个旧能力有目标负责人。没有把不同历史轮次测试拼成最终全绿。                                                                                |
| 1：一个可运行 Elysia 纵切 | 固定版本；无 Hono 的 Elysia app；探针、真实账户资格、模型配置读取/写入及相应 Web gateway；真实 Node socket、pre-parse 准入、错误 envelope、类型导出与 Eden | 隔离 PG 的 Browser→Next→Elysia→用例→PG→页面通过；类型错误在编译期拒绝；明文/TLS 未结束上传拒绝完整；无后端运行时混入浏览器。实验请求不能是 mock 业务结果。                      |
| 2：全业务功能边界         | identity、approvals、tasks、models、workspaces、memory、brief、notifications、time 连同 controller/model、公开用例、存储、HTTP 调用方迁移                  | 整张责任表逐项落实；批准/任务、来源/记忆、凭据绑定/出站、文件 unknown 等事务与外部效果保全。小模块的保留理由具体，不机械制造层。                                                |
| 3：会话事实与 Agent 执行  | conversations 持久事实与历史；agent operations/runtime/harness/tools/routing；一并迁移相关文档批准、模型与记忆接缝                                         | 一个 attempt 一份共享状态、进程级 driver、同 session ownership；接纳/终结、工具接受、pause/continue/compact 和 server-owned 断连有真实 native/PG 证据。无相互依赖的新控制中心。 |
| 4：完整 Elysia 与类型切换 | 全部 controller、JSON gateway 和 RSC 调用；SSE；bootstrap/worker/bin/release；部署与构建/CI 依赖                                                           | 同一路径唯一实现。删除 Hono 依赖、registrar、NativeRouteContext、旧路由名/别名及过渡 dispatcher；不影响历史 profile、checkpoint、事件及显式旧模型导入。                         |
| 5：最终保全与收口         | 完整用户路径、所有适用门禁、结构负例、运行指南与架构/API/PRD/索引同步，形成最终版本验证记录                                                                | 全目录与调用方无漏项；失败/跳过/已知缺陷如实分类；不是拿批次 1 的绿灯代替整合结果。                                                                                             |

批次 1 的旁路验证可在隔离副本运行 Elysia；生产切换以完整可回退版本为单位。若评审需要分批合并，临时路径选择只能在最外层选择一个框架，不能把失败请求送到另一个框架重试；同一路径不存在两个 owner，也不二次消费 body。过渡安排必须在批次 4 全部删除，不能成为架构常态。

### 回退与变更边界

本方案不需要数据库迁移，不改历史格式。每个发布单元回退到上一个完整可读同一数据的版本；停止新请求后按现有 shutdown/ownership 收尾，再启动旧版本。文件、模型调用和已发送通知等外部效果不能随代码回退撤销，unknown 不重派。

若实施发现必须修改 API、schema、授权、旧 Run 资格或生产拓扑，先分离为明确的合同变更，不在“重构”里悄悄完成。源工作树只读保留为设计基线，实施应从其完整冻结状态创建独立工作树，不覆盖原有未提交改动。临时资源用 D 盘隔离位置，验证后只清理本任务资源；不写 `.env*`，不读取真实凭据。

维护命令位置调整与消费者同批迁移：`src/release-{inspection,stop,waiting-detail}.ts` 的命令入口归 `bin/`，实际查询/操作归相应公开用例；`scripts/local/runtime.mjs` 调用的 `apps/api/dist/*.js` 路径也必须更新，不留旧入口 shim。`release-waiting-detail.ts` 内联跨会话/身份/批准查询应由只读组合用例承接，不能原样搬进平台或 CLI 后继续绕过所有者。

## 验收：功能完整与认知成本同时证明

### 可观察行为矩阵

| 行为                 | 证据与入口                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全端点和协议保全     | 将现有功能对照记录的端点扩展为双入口合同：Elysia 进程内与真实 HTTP；覆盖精确路径、未知方法、错误优先级、JSON envelope、header、多个 cookie 和合法连接复用。已有 contracts 的健康双跑不等于全端点覆盖。                                  |
| 提前拒绝及连接可信度 | 复用 `app.test.ts`、`http-body.test.ts` 的真实 HTTP/TLS 慢速/持续上传，覆盖 401/403/404/413、128KiB、chunked、虚假转发头和本机 capability；观察有限响应、关闭和资源回收，不以客户端发送量冒充服务端读取量。                             |
| 原子性和状态         | 隔离 PG，复用 approvals-confirm、task-creation、tasks-cancel、model-selection-admission、ownership、document-approvals、tool-invocations 系列；覆盖重复/并发/失败回滚、冻结和撤权迟到效果，不只断言函数接线。                           |
| 执行和流             | 真实源码构建 native 与受控模型，覆盖工具往返、server-owned 断订阅继续、request-bound 取消、历史只读、游标和版本、慢读背压与 PG 连接释放、pause/continue、活动/自动/空闲 compact。单独记录 POST 回放撤权已知失败，其他路径不得因此跳过。 |
| Web 与类型           | 各类 JSON gateway 的正向和预期编译失败案例证明路由/输入/响应/错误推导；实际浏览器验证登录、配置默认/切模、审批、暂停/继续和历史；测试 session/CSRF、RSC cookie、上游 502、多 cookie、双向取消，开发和生产入口均验证。                   |
| worker/CLI/部署      | 实际 `api                                                                                                                                                                                                                               | worker | all` 启停与 SIGTERM；worker-only 无 HTTP/driver；维护导入、账户维护与 release 检查可实际加载并执行隔离用例；沿用用户安装流程而非只构造测试 app。 |
| 旧事实兼容           | 从隔离旧库升级到现行 schema，再切换代码；既有 Run/profile/checkpoint/事件、旧等待只读资格及显式模型导入合同不变。不编辑历史迁移、不自动消费 pending。                                                                                   |

真实路径主线为：**浏览器登录→模型配置与默认/切换→消息接纳→SDK 受控出站→仓颉→真实受控工具→PG/文件效果→SSE→刷新补读**；加上批准创建/取消与暂停/compact 分支。模型使用本地受控服务，工作区用隔离真实文件，不能把模拟模型称为真实供应商验收。

新增测试仅补已有覆盖不足的消费者行为和不确定边界，不写源码字符串或“存在某个类”的测试。明确行为变更按项目测试先行观察实际 Red；适配未知能力先最小真实实验。最终按仓库已有 `bun run typecheck`、`lint`、`depcruise`、`test:unit`、`test:contracts`、`test:integration`、`test:scheduler`、`format:check` 和 `verify` 的实际编排执行一次适用检查，复用其中有效覆盖，避免重复跑相同命令；原生合同沿用规定 Linux 路径。每条证据记录最终快照/版本、环境、执行方式、实际结果与未覆盖。

已有 SSE 缺陷要保留独立失败证据；如果进入阻塞套件，套件仍记失败，不 skip、不改断言、不把其余通过说成全绿。迁移新增失败必须处理；已有缺陷的修复或合并放行另作明确决定，不能由实施者自行豁免仓库门槛。

### 结构与可读性验收

不是统计增删行数或目录数量，而是从实际改动任务检查：

1. 改一个模型设置端点，能在该功能内看到 schema、完整用例与输出；不用追中央操作枚举或三层转发。
2. 改一次提醒确认，能准确指出谁拥有事务、同 client 写了哪些事实及何时 consumed；不需要理解 Agent session 才能安全修改。
3. 改一次 Run 暂停，能分别定位 HTTP 接纳、pending/paused 事实、attempt session 安全点和唯一后继；没有同名 manager 持有重复状态。
4. 追踪一个工作区写工具，能区分执行许可、磁盘发布、接受记账与回读；方法名不把已发生与已验证混成 success。
5. 从 `main` 能看清 api/worker/all 启动哪些资源；从 controller 不会意外启动后台服务。
6. 静态依赖规则及负例验证：核心不依赖 Elysia/HTTP、features 不反向依赖 agent、调用方不能跨功能直读私有 repository、Web 只允许指定 API 类型入口。人工对照 SQL、同 client 和锁序，补足工具看不到的边界。

交付目录映射应覆盖全部 `api/src` 源文件；每个文件标注所属能力、公开/内部性质与保留/迁移/删除依据，不创建长期重复维护的人工导出符号清单。认知成本评估用上述真实修改路径与必要概念说明，不虚构“新人几小时上手”的计时结论。

## 官方依据与取舍

- [最佳实践](https://elysiajs.com/essential/best-practice)：按功能组织 controller/service/model；Elysia 实例即控制器，不把整个 Context 传给 service；不强制 class 或固定目录。
- [校验](https://elysiajs.com/essential/validation)：schema 推导与运行时校验，支持 Standard Schema/Zod；这不是 ORM 或自动生成业务模型。
- [生命周期](https://elysiajs.com/essential/life-cycle)与[插件作用域](https://elysiajs.com/essential/plugin)：Parse、hook 顺序及 local/scoped/global 必须实证，不能照搬 Hono 中间件次序。
- [Eden](https://elysiajs.com/eden/overview)与[Treaty](https://elysiajs.com/eden/treaty/overview)：由服务端类型得到客户端路由映射，无需代码生成；仍需真实网络和权限合同。
- [Node 适配器](https://elysiajs.com/integrations/node)：官方提供 `@elysia/node`，不证明现有 Bun/Node socket 安全合同可直接替换。
- [OpenAPI 插件](https://elysiajs.com/plugins/openapi)：文档生成是可选插件能力，本轮不额外开放端点。

不选“只把 Hono 改成 Elysia”：无法解决全局混合 Context、跨能力循环和状态归属。也不选“同步换 ORM/数据库/监听栈或迁入 Next”：增加与可读性无关的失败面。选择保留有效业务实现、事务与传输合同，重划真实职责并采用 Elysia/Eden 的完整类型路径；承担一次明确的控制器、构建和调用方迁移成本，不保留双轨兼容包袱。
