# API 重构对照与验收记录

## 对照范围

基线为 `02706890eed84f9155d3589b279220e8194555db`（B）；冻结的重构前 Hono 工作树为 `D:/Temp/along-framework-experiment-20261117/snapshot`（S）；当前工作树为 C。S 本身已有集中式 Hono 注册和业务拆分，不能将 B→S 的变化归因于 S→C。以下源码路径均相对 `apps/api/src/`。此表是迁移核对清单，不是行为等价证明；动态验证单列。

| 功能 / 合同              | 基线及快照                                                               | 当前落点与重要边界                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 入口                | B `http/app.ts`；S `http/app.ts`、`http/native-routes.ts`                | `http/server.ts`、`http/app.ts`、`http/native-routes.ts` 和各功能 `native-routes.ts`；Hono 接收实际请求并返回 JSON/SSE Response，原生边界保留 peer、提前拒绝和 socket 背压。认证、CSRF、未知路径、长度及异常先后顺序需保留。 |
| 身份                     | B `modules/identity/routes.ts`；S 集中注册                               | `modules/identity/account/` 的 Hono 入口、`session/` 的 Better Auth 与 PG adapter；cookie、CSRF、安装锁、邀请和 credential 事务不归框架。                                                                                    |
| 任务和审批               | B `modules/tasks/`、`modules/approvals/`；S 路由集中注册                 | 两个功能各自的 `native-routes.ts`、任务 `cancellation/` 和审批 `reminder/`；确认事务包含冻结展示核对、任务及事件/outbox 和消费。                                                                                             |
| 文档审批                 | B `modules/approvals/document-*.ts`；S 含会话决策文件                    | `modules/approvals/document/` 与 `modules/conversations/documents/`；共享事务和 attempt→Run→approval 锁序不变。                                                                                                              |
| 简报                     | B `brief/`；S 集中注册                                                   | `brief/native-routes.ts`、`service.ts`、`repository.ts`；只读任务/审批投影，展示冻结字段，共用连接不等于同一事务快照。                                                                                                       |
| 对话/Run                 | B `conversations/routes.ts`、顶层 service/repository；S 集中注册         | `conversations/native-routes.ts`、`routes.ts`、`lifecycle/`、`run/`、`history/`。录入冻结、幂等、owner、attempt、checkpoint、服务端驱动、终态和历史分页为不同职责；原 `handleConversationRoute` 拆到具体操作及未知路由分支。 |
| SSE                      | B `conversations/routes.ts`；S 相同职责                                  | `conversations/routes.ts`、`run/stream-authorization.ts`、`http/native-routes.ts`；订阅已持久化事件、授权披露、游标、背压、断连和执行所有权不能混同。POST 幂等回放撤权已知缺陷不在此次修复。                                 |
| Harness / 路由 / compact | B `conversations/` 顶层相关文件；S 相关功能仍集中于同一目录              | `conversations/harness/`、`routing/`、`compact/`；`harness-session-load.ts` 事务内加载，`harness-session-routing.ts` 校验路由事实，`harness-session.ts` 协调跨异步共享状态；Run 锁、冻结授权、预算和实际模型结果必须一致。   |
| 工具与目标               | B `tools/gateway.ts` 包含较多工具逻辑；S 已拆 handler                    | `tools/catalog.ts`、`gateway.ts`、`invocations.ts`、各 `*-handlers.ts`，`conversations/goals/`；profile 授权不同，外部副作用的不确定结果不可假定可重试，来源再次授权。                                                       |
| 记忆                     | B/S `modules/memory/`                                                    | `modules/memory/native-routes.ts`、`recall/` 和 `modules/conversations/history/memory-sources.ts`；版本、来源、owner 和 receipt 验证属于持久化合同。                                                                         |
| 工作区                   | B `modules/workspaces/service.ts`；S 拆出 `files.ts`                     | `modules/workspaces/{http,registry,read,write,mcp}/`；Run 冻结 grant，磁盘发布与 PG 并非原子事务。                                                                                                                           |
| 模型 provider            | B `modules/model-providers/service.ts`；S 拆出 `run-binding.ts`          | `modules/model-providers/{http,configuration,outbound,runtime}/`；冻结版本、撤销锁、受控出站和凭据保护不能绕过。                                                                                                             |
| 时间                     | B/S/C `time/`                                                            | `time/context.ts` 和 `normalize.ts`；规则不可用须显式报告，唯一规范化权威为 `time-core.normalize`。                                                                                                                          |
| 调度与通知               | B/S/C `worker/loop.ts`、`tasks/scheduler/`、`notifications/`             | worker 阶段 cancel→schedule→claim→send→ack→missed，邮件独立串行；task→outbox 锁序，通知独立接收事务，不确定结果对账，不承诺撤回已发送通知。                                                                                  |
| 平台/数据库/CLI          | B 错误类型在 `http/errors.ts`、encoder 在 conversation routing；S 已迁移 | `platform/errors.ts`、`encoder.ts`、`vector.ts`；`db/pool.ts`、`transaction.ts`；`bin/import-model-provider.ts`、`seed-session.ts`。事务由 `withTransaction` 管理；`withClient` 不创建事务。                                 |
| 角色/发布工具            | B/S/C `main.ts`、`role.ts`、`release-*.ts`                               | api 提供 HTTP，worker 后台循环且不监听，all 同时运行；关闭等待 server、worker、Run driver 及连接池。发布工具检查和停止受控 Run，不得弱化跨进程生命周期。                                                                     |

## HTTP 端点清单

S 集中式注册迁移到 C 各模块；下述是源码静态清单，响应与错误优先级需另行运行核对。`:id` 等是单一路径段，原始编码、重复 query、尾斜杠和未知方法也属于验收边界。

- GET `/healthz`、`/readyz`、`/api/v1/me`。
- `/api/v1/auth/`：GET `status`、`account`、`invitations`、`sessions`、`users`；POST `initialize`、`claim`、`sign-in`、`sign-out`、`contact/request`、`contact/verify`、`invitations`、`invitations/accept`、`password/forgot`、`password/reset`、`password/change`、`sessions/revoke`、`deletion-request`、`invitations/:id/resend`、`invitations/:id/revoke`、`sessions/:id/revoke`、`users/:id/disable`。
- GET `/api/v1/brief`、`/api/v1/workspaces`。
- `/api/v1/approvals`：GET 集合及 `/:id`；POST `/:id/actions/confirm`、`reject`、`revise`。`/api/v1/document-approvals/:id`：GET 详情；POST `/actions/confirm`、`reject`。
- `/api/v1/tasks`：GET 集合、`/:id`、`/:id/events`；POST `/:id/actions/cancel`。
- `/api/v1/memories`：GET 集合及 `/:id`；POST `/:id/actions/correct`、`stop-recall`。
- `/api/v1/conversations`：GET 集合、`/:id`、`/:id/messages`、`/:id/runs`、`/:id/runs/:run`、`/:id/runs/:run/events`、`/:id/runs/:run/compacts/:pause`；POST `/messages`、`/:id/actions/compact`、`/:id/runs/:run/actions/cancel|resume|pause|continue|compact`。
- `/api/v1/model-providers`：GET、POST 集合；POST `/:id/actions/update`、`delete`、`default-model`、`test-connection`、`test`，以及 `/:id/models`、`/:id/models/actions/context-window`、`remove`、`sync`。POST `/api/v1/model-selection/actions/set-default`。

## 静态对照的限制与待确认项

对三份源码按 TypeScript 顶层声明生成的候选索引，B 的 1,163 项中 11 项无同名候选（其中 6 项导出），S 的 1,237 项中 33 项无同名候选（其中 19 项导出）。B 的简报入口转入 `brief/native-routes.ts`；`handleConversationRoute`、`isKnownAccountRoute`、`handleAccountRoute`、`handleWorkspaceRoute` 分别转入具体会话操作、账户精确路由和工作区 GET/未知方法分支。S 中无同名导出的审批 8 项、简报 2 项、记忆 4 项、任务 4 项和工作区 1 项，分别转入对应模块 `native-routes.ts` 的真实响应控制器。原审批、记忆、任务的未知方法处理仍保留在各自 `routes.ts`。名称匹配可能有重名、重载或实现变化，不证明调用关系和行为等价；完整候选索引由 `D:/Temp/along-api-inventory.mjs` 对三份源码生成到 `D:/Temp/along-api-symbol-mapping-20261117.json`。

## 功能职责核对

- 会话：`conversations/native-routes.ts` 只把具体路径分派到 `routes.ts` 的 HTTP 操作；Run 生命周期、历史、compact、目标和文档分别归对应子目录。Harness 初始状态/恢复快照与路由事实已拆出；共享流、暂停授权和终态协调仍归 session，避免复制可变状态。
- 账户和设置：identity 控制器处理 HTTP、Cookie 和身份入口，account/invited service 承接账户状态转换；邮件投递、限流、密钥和 session 存储独立。工作区的文件读写及受控替换留在 workspaces；provider 的出站策略、密钥、流和模型绑定留在 model-providers，不能由控制器绕过。
- 任务、记忆与简报：各自控制器只处理 HTTP 身份及输入输出，任务创建/取消、记忆授权/召回和简报投影保留在各自服务；时间规范化仍由 time 模块及 time-core 负责。跨功能读取使用既有工具查询或公开服务，而不是引入新的通用控制器。
- 工具：`tools/` 的 catalog、授权/调用记录与各功能 handler 承接模型工具入口；其调用不是 HTTP MVC 页面，不为目录形式拆成无业务的 controller。真实 native 消费者及工具结果需要运行证据，不能从静态分层推断。
- 文档批准：`approvals/native-routes.ts` 是 HTTP 控制器；`document-service.ts`、`document-rules.ts`、`document-actions.ts` 和 `document-query.ts` 分别承接业务、冻结规则、事务内决议和查询。决议仍由调用方先锁 attempt/Run 再锁批准；不为追求目录对称移动事务。
- 通知：不设独立公开 HTTP 写入口；`notifications/service.ts` 负责接收及只读投影，`repository.ts` 负责存取，任务详情经公开查询获取通知。接收使用独立连接池，不能合并进 task/outbox 事务。
- worker：`worker/loop.ts` 只编排串行阶段、邮件 tick、定时器及停止，调度和发送实现归 `tasks/scheduler/`，通知接收归 notifications。它不是 HTTP 控制器，不需要人为增加 MVC 层。
- 平台及数据库：`platform/` 的错误、编码和向量能力供各功能使用；`db/transaction.ts` 区分借用连接与真实事务。保持公共基础能力，不把业务事务集中搬进平台。
- HTTP：真实 `Request` 进入 Hono，功能控制器产生有限 JSON 或 SSE `Response`；原生 socket 仅承接受信 peer、未读上传收尾、流式背压和断连。未知路由与错误优先级仍由入口和模块回退分支处理。

## 适配实验（合成、本机）

Bun 运行真实 Hono + `Bun.serve`：对未结束 chunked 上传，认证拒绝返回完整 401、CSRF 拒绝返回完整 403、累计超过 131072 字节返回完整 413，响应均 `Connection: close`；TLS 连接返回 200，服务端 `requestIP` 显示本机 peer。SSE 响应客户端暂停读取时两次观察均为 8 次 pull，断连后流的 cancel 执行。另以 Bun 的 Node HTTP 兼容层、真实 Request/Response、`Readable.toWeb/fromWeb` 实验，未结束上传提前收到完整 401，真实 body 可读；慢读时 pull 保持 9，断连后 cancel 执行。

简单直接 pipe 的连续上传探针出现 `ECONNRESET`，不能据此认为安全合同兼容。改用现有传输边界的思路：未读上传时暂停请求、以 `Content-Length` 定界有限错误响应、延迟 250ms 结束并关闭连接；本机 HTTP/TLS、慢速和连续上传下，合成认证 401、CSRF 403 和累计超限 413 共 12 种组合均收到完整错误，连续模式最大采样 `readableLength` 为 16384 字节，客户端发送不超过 770048 字节。测试使用临时自签证书。

以上是独立合成探针，不是项目真实认证、TLS 合同或 SSE 的验证，也不证明所有缓冲、并发及竞态。最终适配必须重新运行现有真实 HTTP/TLS 测试及真实 SSE 定向验证。

## 验收记录

本次验证在隔离 PG16、合成身份和本机 socket 上进行；API 源码按测试时的工作树装入运行环境。无真实账户、工作区或外部模型提供方。以下记录是所列路径的证据，不是全功能等价证明：

- `app.test.ts` 与 `http-body.test.ts`：46 通过；覆盖生产 handler 的明文/TLS、慢速和持续未结束上传、401/403/404/413 完整响应、累计 128 KiB、断开清理、方法、原始路径和重复查询。持续上传最大采样缓冲 24576 字节；此值不是一般流控保证。
- 隔离 PG：简报、邀请身份和任务读取 22 通过；记忆管理 1 通过；审批 HTTP 与修订 6 通过，文档批准事务和冻结内容 14 通过；模型 provider HTTP 2 通过；会话历史 7 通过；Run GET/取消 2 通过。
- 账户、密码重置和会话的隔离 PG/HTTP 运行：37 通过，1 个账户建库 hook 在默认 5 秒超时；按 30 秒上限单独重跑该例通过。覆盖初始化、登录、Cookie、退出、CSRF、错误处理与重置，不代表全部身份路径。
- SSE：真实 HTTP 定向测试包括消息事件形状、游标和会话撤销；请求建立前的依赖失败不启动 Run。另对 2,500 条持久化合成事件暂停客户端读取：第 57 次 socket 写出现背压时连接池 1/1 空闲、等待 0；恢复后所有事件按数据库顺序和原 payload 到达。背压中断开后 handler 结束、写入停止且 drain/close 监听清理。仅验证一个本机慢消费者，不代表生产代理或高并发。
- 真实 native：Linux 容器使用当前 API 源码、隔离 PG 和受控本地模型；server-owned Run 的 GET 订阅断连后继续执行并从 GET 补读通过，active compact 后同 Run 继续通过。`api`/`all` 的 `/healthz` 返回 200，`worker` 不监听；三种角色 SIGTERM 均退出 0。
- 公开 contracts 与 stream-protocol、健康端点进程内/HTTP 双入口：94 通过。API typecheck 通过；本次修改文件定向 lint 与格式检查通过。另对审批目录检查时有 repository 原有 4 条无必要转义警告。
- `bun run test:unit`：1006 通过、101 跳过、1 失败；`scripts/test/local-lock.test.ts` 首次为随机端口 `EADDRINUSE/LOCK_UNAVAILABLE`。单独重跑该文件 4 通过；这不能改写整套单测首次失败的结果。一次并行 PG 集成运行中修订 21 通过，确认和取消两组的建库 hook 在默认 5 秒超时；按项目集成命令的 30 秒上限单独重跑这两组，22 通过。

上一轮将已知 POST 幂等回放撤权缺陷误认为不得在隔离环境触发，因此没有执行完整 contracts 和 integration；该限制并不存在。已知缺陷不在本次修复范围，隔离环境允许测试和复现。静态映射不证明所有路径无缺失，真实部署及外部 provider 不属于合成环境证据。

## 完整套件补充验收

- `bun run test:contracts`：在 WSL/Linux 使用仓库脚本构建当前生产镜像、隔离 PG 和真实 native；341 通过、1 跳过、0 失败，D8 必需消费者和 10 条 gate 声明检查通过。跳过的 SDK-native 用例要求独立命名的本地数据库和显式隔离开关；另在独立 PG 数据库及受控本地模拟模型下单独执行，1 通过、0 失败，覆盖实际 SDK 流、native 循环、授权工具和结果回传。完整 contracts 中包含文档批准 HTTP 和受管工作区本地/HTTP 消费者。
- `bun run test:integration`：Linux 容器、独立 PG16 和仅内部网络，按仓库命令构建并以 30 秒超时运行；731 通过、1 失败。失败为 `identity-invited-dual.test.ts` 的进程内响应夹具缺少 Node `getHeader`，重构后的未读请求收尾触发该缺口；真实 HTTP 对应场景通过。补齐夹具的 `getHeader`、`write` 和分段 `end` 后，该进程内场景定向复测 1 通过、1 过滤；首次整套结果保持失败。

## 业务子模块整理后的验证

- Linux 隔离容器的 API typecheck 通过；首次检查发现邮件投递拆分遗漏共享的 provider ID 校验常量，修正后通过。
- `bun run test:contracts` 按仓库脚本构建整理后的生产镜像和真实 native：341 通过、1 跳过、0 失败；D8 实际消费者及 gate 声明通过。跳过的 SDK/native 用例在单独命名的隔离 PG、受控本地模型下补跑，1 通过。
- 隔离 PG16、内部网络，构建 API 后以 30 秒超时运行 18 个受影响集成文件：135 通过、0 失败。覆盖账户本地/真实 HTTP、邮件本地模拟、provider 探测、提醒和文档批准、取消/worker、记忆、工具账与上下文投影、真实 MCP、native 和 SSE。未重新执行完整 integration 或整套 unit。
- `bun run depcruise`：1,223 模块、4,888 条依赖无违规。新增的嵌套路由依赖负例经真实 depcruise 验证为拒绝；本机账户测试 30 通过，检查范围选择测试 34 通过。选择测试首次在不含 git 的容器中失败，随后在 WSL 的隔离临时环境通过。
- 受影响目录 lint 首次发现工具账本拆分后残留未使用 import，删除后该文件定向 lint 通过；首次同时有 14 条其他警告。实际构建后单独加载本机账户、密钥解析和工作区登记的新源文件/产物入口通过，不能代替用户安装的端到端验收。
- 以上为合成账号、隔离数据库和本地模拟服务的证据，不证明真实 provider、用户安装或生产代理。已知 SSE POST 幂等回放撤权缺陷未修复。

## 公共 HTTP 层职责重构后的验证

- 没有增加端点或有意改变协议行为，复用既有合同测试，不把目录结构当作回归断言。最终 HTTP 版本在 Windows/Bun 1.4.4 上定向运行 `app.test.ts`、`http-body.test.ts`、`document-approval-http.test.ts`：47 通过、0 失败。真实 HTTP/TLS 覆盖慢速、持续的未完成上传，验证认证、CSRF、未知路径、声明超限和分块超限的有限错误与连接收尾；同时覆盖 UTF-8 字节上限、合法连接复用与探针。
- 单独以真实 HTTP socket 联通 `transport/response.ts`：在 `write()` 报告背压后恢复客户端读取，256 条合成 SSE 帧逐字节一致；背压期间断开客户端，Web 流执行取消，写入协程退出。这个探针不经过数据库、Run 或事件披露层。
- WSL/Linux Bun 1.3.14、无数据库配置，启动实际 `main.ts`：`api` 和 `all` 的 `/healthz` 返回 200，`worker` 不监听 HTTP；等待启动完成后发送 SIGTERM，三种角色均以 0 退出。未验证带数据库的 worker 调度。
- API typecheck、定向 Oxlint 和依赖规则通过。本节没有重跑 PostgreSQL/native 集成，不能替代上文不同版本的集成证据；已知 SSE POST 幂等回放撤权缺陷未改动。

## 历史兼容层清理验证

- 移除旧控制器分派后，上传、文档批准入口及 HTTP 基础合同定向运行 49 项通过；新增未命中用例另覆盖方法差异、认证优先级、原始路径与依赖不可用。后者与流式模型测试一并运行，57 项通过；两组有重叠，不相加。
- 合成本地配置测试 18 项通过，覆盖新装、接管的无凭据执行限额以及旧格式读取。冻结依赖 dry-run、API typecheck、定向 lint 与依赖检查通过。
- Docker Linux daemon 不可用，未重跑当前代码的 Docker 构建或 PostgreSQL/native 集成；不接触真实安装或供应商。旧 Run 及事件读取路径未退役。
