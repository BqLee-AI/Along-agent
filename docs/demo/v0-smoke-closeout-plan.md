# v0 七步 Smoke 收口计划

> 这是 [#26](https://github.com/BqLee-AI/Along-agent/issues/26) 已授权执行的规划依据，不是实施完成或验收记录。Observed、代码行号与缺口表是下述规划基线的静态快照，不能当作后续实现的实时状态；实施进展、验证与合并证据见对应 OpenSpec tasks 和 [独立 smoke 记录](v0-smoke-evidence-2026-10-21.md)。用户已确认 brief 完成，不重开 brief、不继续优化 CI。[INFERENCE] 表示待运行证明；Required 表示既有要求；Proposed 记录方案选择。

## 1. 结论、基线与范围

规划研究基线 HEAD：`e98f29f1fb001e164b0f35f61cf6c7241bfd6de7`，对应已合入的 CI PR25；不是后续实施/验收的实时版本。执行时另记实际 commit 和相关源码差异，保留用户改动；HEAD 不代表工作树无用户改动。

**推荐：先纠正手册并补足明确缺失的串链接口，再在一个受控环境完成七步证据；不重写已存在的 SSE、confirm、读模型和 worker。** 七步结果与完整 A1–A4 结论分开：代表性 smoke 成功不能自动证明 supersession、DST 全边界、真实崩溃恢复或所有故障分支通过。

外部 `v0进程.md` 的 S0→S0.5→S3a→S2→S1→S3b→S4→S5→S6 只作历史顺序参考，旧勾选、下一步和编号不是本仓状态。当前仓实际对应：

- [#5](https://github.com/BqLee-AI/Along-agent/pull/5)：`docs(governance): P0-2 pr templates spec (#4)`，已关闭；作者说明撤回该 spec PR，改直接实现模板。不是端到端收口任务。
- [#9](https://github.com/BqLee-AI/Along-agent/issues/9)：`[P0-4] gates 清单可执行化`，已完成。不是 SSE 任务。
- 源码中 `issue #9`、`issue #27` 等历史注释不能替代当前仓 issue 核对。七步 smoke 现由用户授权的 [#26](https://github.com/BqLee-AI/Along-agent/issues/26) 跟踪，OpenSpec change 为 `complete-v0-seven-step-smoke`；不沿用前轮“未建业务 issue / 仅规划”的授权状态，也不将计划视为完成证据。

Required 不变：Postgres 唯一事实源；按钮确认；confirm 单事务；冻结展示；事件只追加；回执门；取消提交后触发请求数为零；五门与 D1–D10 不改。禁止改已合并迁移、读取/改写 `.env*`、输出 secret/DSN、操作用户数据库或进程。外部参考文件不修改。

## 2. 七步与真实实现映射

下列测试仅表示**已存在对应断言**，本轮未执行，不能写成通过。

| 步骤           | 真实入口、模块和 Observed 实现                                                                                                                                                                                                             | 现有测试边界                                                                                                                                                                   | 尚缺的跨层证据/结论                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 简报         | Web `/` → `apiGet('/api/v1/brief')`；`apps/api/src/modules/brief/{routes,service,repository}.ts#getBrief`，读 tasks/approvals，无 brief 写表                                                                                               | `apps/api/test/integration/brief.test.ts:91–234`：日期、投影、空态、时区差异、HTTP 鉴权                                                                                        | 只在串链中观察同一 owner 的投影与本次基线差量，不重做 brief 功能验收。固定 `pending_count=1` 不是通用前置                                                                                                                |
| 2 只读卡片     | `/` 卡片 → `/approvals/{id}` 或 `/tasks/{id}`；`apps/web/src/lib/presentation.ts#describeCard`；brief 卡片 `schema_version=1`（数字），SSE `card.proposed.schema_version="v1"`（字符串），不是同一种卡片版本字段                           | `apps/web/test/presentation.test.ts`：改 UTC 不改变展示；approval 只读；未知卡片降级                                                                                           | 浏览器点击前后相关任务数不变、冻结时间不变；空数据库需先通过真实对话准备一张 pending 卡片                                                                                                                                |
| 3 对话 SSE     | `/conversations` 的 `Chat.tsx#send` → `/api/v1/conversations/messages`，body 为 `raw_text/confirmed_timezone/idempotency_key`、已有会话才带 `conversation_id`；经 Next 代理 → conversations/tools → time-core → `createTaskApproval` → PG  | `conversations-sse.test.ts:73–124,153–237,302–368,499–544,699–`：approval/no task、澄清、重放、断连、帧 schema；路由测试使用模拟 req/res，不是浏览器穿过 Next                  | 浏览器真实流 `thread.started → message.delta → card.proposed → approval_required → thread.completed`；PG 有 pending approval、messages/checkpoints/tool_calls；本次 approval 不关联任何 task/outbox                      |
| 4 按钮 confirm | `/approvals/{id}` 的 `ApprovalActions.tsx` → `POST /api/v1/approvals/{id}/actions/confirm`；`confirm.ts#confirmApproval`、`repository.ts#insertConsumedTask/insertOutboxSchedule`：任务、created、schedule outbox、consumed 同事务         | `approvals-confirm.test.ts:32–221`：单建、重复、并发、hash/seen 错、过期、已 superseded；`identity-session.test.ts:125–149`：真实 session 的 CSRF                              | 浏览器所见全文/hash 与请求一致；首次与重复请求同 task；SQL 同一 approval 只有一 task、一 created、一 schedule 命令。实际 envelope 的 `data` 为 `approval_id/status:"consumed"/task_id/duplicate`，不是 `{state:"saved"}` |
| 5 到点/通知    | `main.ts` 的 all/worker → `worker/loop.ts`：cancel→schedule→claim→send→ack→missed；`schedule.ts#scheduleOne` 持久 `sched:<taskId>`；`send.ts#sendOne` → `notifications/service.ts#deliverInApp` 写通知与 fired；默认回执 `inapp:<sendKey>` | `scheduler-schedule.test.ts:104–154`：登记/claim/send、通知一行、事件链、重复 send；`scheduler-fault.test.ts:191–215`：超窗 missed；测试改 DB 时间，不等同真实钟串链           | 近未来真实钟到点、通知恰好一行、fired 回执及 Web 可见面。Observed：不存在通知列表 API 或通知页面，默认本地 provider 不代表送达设备/用户                                                                                  |
| 6 活动账       | `/tasks/{id}` 读取 task+events；`/activity` 汇总 tasks/events；`tasks/service.ts#getTaskDetail/getTaskEvents` 只读投影                                                                                                                     | `tasks-read.test.ts:38–80`：列表、冻结字段、事件顺序、owner；展示单测不覆盖真实页面                                                                                            | 页面与同次 API/SQL 对齐。现实现可由 saved 直接到 scheduled，不应要求抓到 pending_schedule 中间态；事件应为 created→scheduled→fired，不能合成 saved 事件                                                                  |
| 7 另建任务取消 | `/tasks/{id}` 的 `CancelAction.tsx` → `POST /api/v1/tasks/{id}/actions/cancel` → `cancel.ts#requestCancel`；提交 cancel_pending/cancel_requested/cancel outbox，旧排队命令作废；worker `runCancelPhase` 等回执                             | `tasks-cancel.test.ts:42–84`：无回执停 pending，测试调用 `recordCancelReceipt` 后 cancelled；`scheduler-fault.test.ts:94–157`：零 fired/通知、余单检查、直接调用 breach writer | **Observed 缺实现**：`recordCancelReceipt` 的调用者只有测试，生产路径只检查内存 Set，没有产生回执，正常 worker 不能自行收口 cancelled。另缺取消后真实调用计数，零 fired 不能替代它                                       |

链路身份边界：`http/auth.ts#createActorResolver` 校验签名 cookie、查询 sessions/users；GET `/api/v1/me` 下发 CSRF 与 confirmed_timezone。Web 服务端组件转发 cookie；浏览器写请求经同源 Next 代理保留 cookie/CSRF/幂等信息。Web 不直连 PG，不引用 API 源码。

## 3. 最小真实环境与已知缺口

### 3.1 Required 前置

1. **工具与启动。** Bun 1.4.2、Postgres 16；使用现成根 scripts：授权后安装 `bun install --frozen-lockfile`，正常本地入口 `bun run dev`，会先构建共享包并启动 API 3000、Web 3100。API 默认 `ROLE=all`，不得让继承的 `ROLE=api` 悄悄关闭 worker。拆进程时显式 api+worker 并共享同一受控 PG；七步最低环境优先 all。
2. **独占 PG 与迁移。** 使用新的、明确归本次 smoke 所有的数据库/Compose 项目和卷；先确认所有权，绝不清空用户库。按 `scripts/db/apply.sh` 在新库一次顺序应用当前 0001–0011；它是 psql 脚本，不是可对既有库安全反复执行的迁移 runner。Windows 需现成 POSIX shell 与 psql。没有根 `db:migrate` script，不虚构命令，不改旧 SQL。
3. **身份。** 现成入口 `bun run --filter @along/api seed:session`，见 `src/bin/seed-session.ts`。执行者通过受控环境注入 DATABASE_URL 与同一 BETTER_AUTH_SECRET；seed 默认 Asia/Shanghai，生成真实签名 session。CLI 会输出 cookie/CSRF：只在私密终端临时使用，不录屏、不贴日志或提交。浏览器在 Web 的同一主机设置该 session cookie（Path=/），由 `/api/v1/me` 取 CSRF；不新增登录页面或测试认证 API，不用 ALLOW_DEV_AUTH 代替此验收。
4. **Next 代理。** `API_BASE` 默认 `http://127.0.0.1:3000`；浏览器只请求 Web 同源 `/api/v1/*`。页面的 GET 可能由 RSC 在服务器执行，不要求它一定出现在浏览器 Network 中；另从同源 API 取脱敏响应与页面对照。探针 `/healthz`、`/readyz` 直接访问 API，不能拼成 `/api/v1/readyz`。
5. **时间。** 记录服务端钟、PG `now()`、owner 时区、环境 TZDB_VERSION 及 SSE/快照实际 ruleset/tzdb。Observed：工具归一使用 `FIXTURE_V1`，实际 `tzdb_version=fixture-v1`，仅三时区及有限 NY 转换；设置环境版本不等于加载完整 IANA 库。Shanghai 正向 smoke 使用这套真实规则，必须标明范围，不能把任意版本字符串当完整 tzdb 证明。
6. **有界真实等待。** 每次建任务前，按可信当前时刻选择约 3–5 分钟后的整分钟绝对时间，例如输入 `YYYY-MM-DD HH:mm 提醒我喝水（北京时间）`，实际填写包含年份的当前近未来值；时区同时由 `/me` 的已确认值约束。既有 parser 接受 24h 冒号格式，不要求为 `09:20` 再补时段。不要把所有省略年份的相对表达都判作缺陷：`明天 9:20` 在已有时区/锚点下能解析，但不适合本次有界等待。避免秒精度输入：当前展示快照截到分钟。

Observed 环境限制：`infra/compose/compose.yaml` 只包含 PG 与 ROLE=all API；Dockerfile 只构建 API，不包含 Web 服务，也没有自动迁移和 BETTER_AUTH_SECRET 传入。不能把现有 compose-smoke 宣称为登录后七步环境。推荐复用该 PG 编排、宿主 `bun run dev`；镜像 all 的 A 类部署验收需显式补齐受控 secret 注入、迁移与外部 Web，不碰 `.env` 或更改 D7。

Observed readiness 限制：`http/app.ts` 的 `/readyz` 仅检查 TZDB_VERSION 非空，没有查询数据库或实际规则内容。因此 readyz 200 只是一项前置信号，必须再以真实 `/me`、业务请求和只读 SQL 证明本次 PG/规则路径可用，不能据它单独宣称完整 A4/F3 通过。

### 3.2 Required 缺口与 Proposed 最小落点

| 缺口性质                         | Required 结果                                                                       | Proposed 最小方案与影响位置                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺实现：本地撤销回执无生产者     | 七步必须出现真实 cancel_pending→回执→cancelled；不伪造回执，不自动把 pending 当成功 | 由既有 `tasks/scheduler/cancel-phase.ts` 在实际完成本地排队撤销与 fencing 核对后产生并持久化本地回执，复用 outbox 的回执字段及 cancelled 事件；调整 registry/cancel 路径与相关测试，不依赖 API/worker 共享进程内 Set，不新建调度平台或改旧迁移                                                                                                                                                                                                                         |
| 缺实现/合同接口：通知 Web 不可见 | 应用内通知可从真实 Web 观察，通知持久化和 fired 账本仍分别取证                      | **先独立契约 PR**，再为既有 `GET /api/v1/tasks/{id}` 增加 owner-scoped 只读 `notifications` 数组，空态 `[]`，每项仅现有 `id/title/body/status/sent_at`（status 域为 pending、sent、failed，sent_at 可 null）。notifications 公共 service 拥有查询，tasks 按 ID 调用→DTO→Web 小面板；不存在/跨 owner 沿用详情错误，无读副作用、列表不加字段、不新增 `/notifications` 路由、不跨模块读表、不把 fired 文案冒充正文。只表示站内记录，不承诺设备送达/已读，不换算 body 时间 |
| 缺证据：取消后触发请求计数       | 统计调用接口那一下，不以任务终态、通知行数、outbox 行数替代                         | 在真实 `deliverInApp` 调用 provider 的边界取 taskId/调用时刻/次数；优先在受控单 worker 使用非暂停调试 logpoint，T_fire 的一次调用作正控制。若无法可靠捕获，才在同一边界增加最小不含内容的调用证据，并补定向测试；不建通用遥测框架、不新增测试 API                                                                                                                                                                                                                      |
| 仅修手册/串链                    | 手册可以按真实客户端直接操作                                                        | 修 `/api/v1` 前缀、raw_text 请求体、card.proposed、真实 confirm envelope、卡片 schema、通知入口、状态观察与取消余单过滤；记录 API 和浏览器来源，避免照抄旧示例                                                                                                                                                                                                                                                                                                         |

取消回执修复若只是落实已有合同，可按现有 spec 实现；若改变回执含义、状态机或公开错误，必须先契约评审。不能用在正式进程手动调用 `recordCancelReceipt`、SQL 改 cancelled 或启用假 provider 通过 smoke。

## 4. 推荐实施拆分与依赖

用户已授权 #26 的 P0–P3 顺序执行；**先独立 spec PR，经独立 review、五门绿及合并资格 CLEAN 后合并，再实现**。本轮文档/spec PR 只改契约、计划与手册，不夹带源码、迁移、CI 或依赖；实现/定向验证/真实验收留在该依赖满足之后。P4 仅列完整 v0 结案的额外验收边界，不自动扩大本次七步范围。角色是验收责任而非已分配人员；执行记录填写实际责任人。

| 顺序                | 交付及依赖                                                                                                                                            | 影响文件                                                                                                                                                                                | 验收负责人及成功/变红/缺证据                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 文档对齐         | 更新计划、Demo 索引及真实可执行手册，删除旧授权状态和错误请求/验收口径；不写已通过结果                                                                | `docs/demo/v0-smoke-closeout-plan.md`、`docs/demo/v0-slice-smoke.md`、`docs/README.md`                                                                                                  | 主线程/文档 reviewer；成功=入口与证据定义可逐项复核；变红=仍引用不存在 API/把计划写成通过；缺证据=未核对项明确保留                                                    |
| P1 合同先行         | 通知详情投影独立 design/api→PRD→OpenSpec change 的 spec PR，独立 review、五门绿、CLEAN 后合并；不得先实现。时间错误合同冲突另项裁决，不夹带降低要求   | `docs/design/03-v0-vertical-slice.md`、`docs/api/tasks/tasks_routes.md`、`docs/prd/04-acceptance-open-questions.md`、`docs/README.md`；`openspec/changes/complete-v0-seven-step-smoke/` | 合同 reviewer；成功=字段/owner/错误/通知口径及可观察场景获批准并合并；未合并=实现依赖未满足，不伪称 approved                                                          |
| P2 最小实现修复     | 依赖 P1 合并后落实取消回执链、通知投影和真实边界调用证据；不以本轮文档 PR 代替实现                                                                    | §3.2 所列现有源码；`tasks-cancel.test.ts`、`scheduler-fault.test.ts`、`scheduler-schedule.test.ts`、`tasks-read.test.ts` 及相关展示测试                                                 | API/worker 实现负责人，Web 负责人复核通知面；成功=生产入口可达、无回执仍 pending、持久幂等回执可恢复；变红=伪回执/跨 owner/重复通知/取消破零；无运行证据=只算实现完成 |
| P3 一次受控七步     | 依赖 P0/P2；按已校正的 [七步手册](v0-slice-smoke.md) 在同一环境真实浏览器执行 §5，不加框架                                                            | `docs/demo/v0-slice-smoke.md`；脱敏验收记录由主线程确定位置或置于获准 change/PR                                                                                                         | smoke 执行者，独立 reviewer 核 SQL/调用记录；成功=七步每条证据齐；变红=任一不变量破坏；缺证据=无流/无调用计数/通知不可见/未越过原到点窗口，不能收口                   |
| P4 完整 v0 结案边界 | 若另行授权完整 v0 结案，按 §6 分项补 A2/A3/A4；这些缺口不自动并入七步实施。区分已有测试、需新增实现与真实演练；只有实际涉及的 change 在验收后 archive | approvals create/repository、conversations service/tools、http app；相应测试及 `docs/demo/fault-injection-smoke.md`、相关真源                                                           | 功能 reviewer 与故障演练负责人；成功=逐条有证据且无合同冲突；七步绿但补充未完成=仅七步报告完成，完整 v0 未结案                                                        |

本计划关联 #26 和上述 change，但不是验收记录，不提前 archive。纯手册/索引修订不创造新公开行为；新增通知公开投影按独立 spec PR 批准并合并→实现与定向测试→真实验收→收口 archive。既有五门和 CLEAN 合并要求继续执行，不重新设计 CI。P4 未获本轮自动授权，七步成功也不自动勾选完整 v0。

## 5. 同一环境、同一 owner 的操作与证据

### 数据与顺序

使用合成用户 A，一套真实 session。所有查询按 owner 加本次 approval/task ID 过滤；记录初始任务 ID 集合，不断言整个 tasks 为空，列表有分页时不能只看首页计数。

若今日已有本次受控卡片，直接使用；若新环境为空，先在 `/conversations` 用真实近未来绝对时间生成一个**不确认**的准备 approval `P0`，记录为基线，再开始七步。这样步骤 1/2 有可点卡片，却不绕过确认门或直接插业务表。P0 仅用于只读展示，与下面两个正式任务分开。

| 步骤 | 操作与最低证据                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 打开 `/`，同源 GET `/api/v1/brief` 取脱敏响应；记录已确认时区的日期和 P0 卡片。重复读取只比较无写入时的业务投影，忽略 request_id，不固定 counts                                                                                                                                                                                                                                                                                                |
| 2    | 从简报点击 P0 卡片进入 `/approvals/{id}`；截图冻结回显，SQL 比较基线相关 tasks/outbox 无新增。approval 型 brief 卡片本身没有 task 的全部时间字段，不要求它凭空显示                                                                                                                                                                                                                                                                             |
| 3    | 新建正向会话，输入近未来整分钟绝对时间，生成 `P_fire`；浏览器 Network 保存脱敏 SSE 帧、request_id/cid/run_id/seq，必须看到 card.proposed 和唯一终结事件；SQL 核 pending 与该 approval 的 task 数为 0，不能用全库空证明                                                                                                                                                                                                                         |
| 4    | 在 `P_fire` 详情点击确认；记录完整所见内容与 hash 对照、响应 task_id=`T_fire`。对已提交请求作同源重复发送验证同 task/duplicate；浏览器按钮提交后会跳转且禁双击，不能假装 UI 自然完成双次确认。核 consumed_task_id、1 task、1 created、1 schedule 命令；worker 可能已更新其 status，不固定 pending                                                                                                                                              |
| 5    | 保持真实 all worker 运行，到原 `fire_at_utc` 观察 `sched:<T_fire>`、fired 的 `inapp:<sendKey>`、通知一行及**实施后**的 Web 详情 `notifications` 面板；同进程实际 provider 一次调用作正控制。默认本地回执只证明服务端记录/本地接收，不证明设备响铃/人已读。到点后再覆盖至少两个有效 30s tick，稳定计数仍为一次；超过 15 分钟只有 missed 不补发，正向 missed 算本轮 A1 失败，不能以“符合 missed 分支”代替 A1                                     |
| 6    | 刷新 `/tasks/T_fire` 与 `/activity`，和同一任务 API/SQL 对齐 created→scheduled→fired、回执与 recorded_at/state_version。当前活动页只取前 50 个任务和每任务 50 事件；保持受控数据小，超出时改看任务详情及分页 API，不误判丢账。GET 失败或页面空白记失败/缺证据，不能认“无事件”                                                                                                                                                                  |
| 7    | 在步骤 6 后通过对话/按钮创建 `P_cancel→T_cancel`，重新选约 3–5 分钟后的整分钟；先核 schedule receipt，再从任务页点击取消，取 cancel_pending/已提交证据，核实际本地撤销、fencing 与持久回执后 cancelled。worker 和调用观察连续运行跨过原 `fire_at_utc + 15min`，再覆盖至少两个有效 30s tick（终点不早于原到点+15min+60s）。取消提交后 provider 调用=0，另核通知=0、fired=0、无待处理非 cancel 命令、无 cancel_breach；不复用 T_fire、不手注回执 |

### SQL 与调用计数的边界

只读 SQL 快照至少包含以下字段；实际查询以明确 owner/本次 ID 为参数，记录中可使用关联一致的合成别名：

- approvals：id/state/consumed_task_id/presentation_hash/wall_time/timezone_id/tzdb_version。
- tasks：id/source_approval_id/state/state_version/schedule_receipt/fire_at_utc/wall_time/timezone_id。
- task_events：task_id/type/state_version/recorded_at_utc/evidence_ref，按时间及 ID 稳定排序。
- outbox：task_id、`command->>'kind'`、status、attempt_no、provider_receipt_id；不导出完整 command 或密钥。
- notifications：本次 task 的行数、idempotency_key/status/sent_at，必要的合成 title/body 与 Web 对照。
- security_events：本次 task 的 cancel_breach 数。

取消余单的正确断言是：`owner_id=<本次 owner> AND task_id=T_cancel AND command->>'kind' <> 'cancel' AND status IN ('pending','dispatched','acked_unknown')` 的行数为零。历史完成行不要求全部 superseded；cancel 命令在待回执时可以 pending，完成后可 dispatched。检查“所有 outbox 都 superseded”是错误验收。可直接使用 [七步手册 §4](v0-slice-smoke.md#4-只读-sql-与实际调用取证) 中的 owner/approval/task 参数化只读快照，按各检查点记录差量，不用 SQL 写入加速主链。

**触发请求数单独取证。** 当前本地 provider 无外网请求，计数对象是 `deliverInApp` 执行 `effective(notice)` 的调用，不是 runSendPhase 扫描数、SendSummary.fired 或唯一通知行数（事务回滚/幂等去重也不抹除调用事实）。优先受控单 worker 的非暂停 debug logpoint，仅记 taskId/调用时刻/序号，不展开通知内容。捕获必须早于 T_fire 到点，以其一次调用作正控制，再连续覆盖整个取消/到点窗口；进程重启、热重载、记录器断开或丢日志均使该段零证据失效。无法可靠捕获时，先落实同一边界最小无内容证据，不拿无日志当零。

`cancel_requested.recorded_at_utc` 是事务内写入时间，不等于 commit 时间。以取消 HTTP 成功返回和事务已可读确认提交，用响应后的调用可证明已提交后违规；请求开始至响应之间的调用若不能排序，依既有要求按违规待人复核，不能自动排除。取不到实际调用记录即“缺证据”，即使通知和 fired 都为零也不能写 D9 通过。

## 6. A1–A4 与 D 门验收矩阵

| 验收项                     | 最低代表性 smoke                                                          | 现有静态测试证据                                                                                                        | 仍需的补充及结案边界                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 喝水恰好一次            | T_fire 的真实 Web/SSE/confirm/PG/worker/通知 Web/活动闭环                 | 调度测试用直接 confirm/改时间/调用 phase，断言一通知、created/scheduled/fired；D2 展示测试                              | 当前通知可见面缺失，修复后方可完成用户可见闭环；短窗口内恰好一次不自动证明所有故障下恰好一次                                                                                                                                                                                                                                                      |
| A2 重复与改字段            | P_fire 重复 confirm 同 T_fire；本次相关数量不增加                         | confirm 测试覆盖并发与错误，但 superseded 用例预置该状态及 successor                                                    | **Observed：生产 createTaskApproval 只 INSERT，未找到置 superseded/连接替代关系的生产写入者。** 完整 A2 需明确“修改哪一条 pending”的真实入口再补 supersession，不能把同会话每个新提醒都自动替代上一条。建议显式引用旧 approval，经独立契约 PR 冻结传参/owner/pending/冲突规则，再落 create/repository、Web 与测试；七步重复确认只能覆盖 A2 的前半 |
| A3 kill/resume 与取消      | T_cancel 的提交后实际调用计数=0、真实回执终态；保留 lease/fencing 事实    | F1 实际是 claim/send/再次 send；lease-expiry 用 SQL 回拨；F2 检查 fired/通知/余单，测试手动注入回执和调用 breach writer | 不是实杀进程或 provider 次数证明。完整 A3 需在另一个获准的独占环境补拥有的 worker 崩溃/重启、发出未回只核对不重发、调用计数演练；不得杀用户进程。七步报告不假冒完整 A3                                                                                                                                                                            |
| A4 DST/未知时区/规则不可用 | 补充独立的新会话/API 用例，不等真实 DST 到来；检查无 approval/task/outbox | time-core golden/dst/反向钟；SSE 测试已有 nonexistent/ambiguous/fold 参数                                               | **Observed 契约冲突：** spec R1.2 要 thread.failed(422)，实现与 conversations API §4 返回澄清 delta+completed；以 spec 为验收基准，当前不能记合同通过。建议恢复该冻结错误语义并同步跟随文档/测试；若保留现实现，必须先独立 spec PR 批准。readyz 仅验环境字符串，完整 A4/F3 仍缺实际规则缺失阻断新归一证据                                         |
| D1/D2/D10                  | 记录实际 ruleset/version；检查冻结展示、按钮告知和已记录口径              | 依赖/反向钟、UTC 变异、lint/文案门已有入口                                                                              | 继续既有门，不修改含义，不用一次 UI 观察代替静态边界证据                                                                                                                                                                                                                                                                                          |
| D3/D4/D5/D6                | 本次 task/事件/幂等事实对照；正常链只读查询                               | `scripts/db/*` 约束/并发/append-only 断言及现有迁移                                                                     | 不在正常 smoke 上尝试改删账本或触碰冻结字段；D4 重约唯一不因本次未重约而被宣告新验收通过                                                                                                                                                                                                                                                          |
| D7/D8                      | 真实登录后 Web 串链补足既有探针覆盖，不替代它                             | 现成 Compose 两轮 readiness；`contracts.test.ts` 双跑具体覆盖 healthz，另有契约包测试                                   | D7 不是完整七步；D8 的 healthz 双跑不证明业务 SSE/confirm 经 Next 已验证。完整 A 类镜像 all+compose 验收需另附部署证据                                                                                                                                                                                                                            |
| D9                         | provider 实际调用证据 + SQL 辅证 + 无 breach                              | 现有 F2 如上；可写 breach 的函数有测试，不等于真实竞争已演练                                                            | 观察器缺失=缺证据；取消后调用>0 或顺序分不清=停收口、人复核，不以零 fired 放行                                                                                                                                                                                                                                                                    |

DST 补充样例可使用 fixture 内 `2027-03-14 02:30` 与 `2026-11-01 01:30` 的 New York 规则，无需等待这些日期。Web 默认用 `/me` 的 Shanghai，若走真实输入可用已实现别名“纽约时间”，不能以为原文出现裸 `America/New_York` 就会覆盖已确认值。API 已有 confirmed_timezone/fold_choice；Web 尚无专门 fold 选择控件，不能声称完整候选选择 UI 已实现。未知时区/缺规则案例应走独立受控输入或环境，不污染正向任务和用户配置。

未来变更验证优先复用 `bun run test:integration`、`bun run test:scheduler`、`bun run test:contracts`、`bun run test:unit` 的真实既有集合，按改动范围选择；无 DB 导致的 skip 不是通过。代码 PR 仍遵循五门合并要求，但本计划不重新研究或优化 CI，也不以重跑整套 CI 作为核心交付。

## 7. 证据格式、停止与 Deferred

每次执行记录：开始/结束时间及使用的时间基准、HEAD 和源码差异、Bun/PG/镜像版本、环境别名与所有权、ROLE、API/Web 来源、确认时区、环境与实际 ruleset/tzdb、步骤输入/关联 ID/请求 ID、预期、实际结果、截图/脱敏 SSE/SQL/调用记录、执行者/复核者、失败与未执行原因。环境只写别名，不写 DSN；不保存 cookie、CSRF、BETTER_AUTH_SECRET、授权头、真实身份或个人提醒内容；HAR 必须去敏后才留存。

**契约与实施边界：** #26 的独立契约 PR #27 经独立审查和精确 head 五门全绿、CLEAN 后合入，冻结通知详情读取合同。后续实现与真实 smoke、archive 在收口 PR 中验收；不能以契约合并、静态检查或测试注入状态代替七步生产链。精确提交与验证结果保存在对应 tasks 和运行记录，不在本规划的基线缺口表反复改写历史。

**真实 smoke 成功条件：** 七步在同一受控环境完成，真实通知观察面和取消持久回执可达，全部证据齐，正控制与 D9 调用零证据成立，观察跨过原到点+15min并再覆盖两 tick；报告明确 A1–A4 覆盖边界。若完整 A2/A3/A4 或合同裁决未完成，只能写“七步代表性 smoke 已完成；完整 v0 未结案”，不能写“v0 全验收通过”。

**立即变红/重规划：** 取消后调用破零或无法排序；哈希/所见内容系统性不符；未确认即创建 task；无回执却进 scheduled/cancelled；重复通知；规则不可用仍接受新排期；实施偏离已批准通知合同；环境无法确认独占。业务错误保留现场与脱敏证据，停止收口；证据缺失标“缺证据”并补齐，不把它包装成业务通过或擅自降标准。正常技术障碍（Windows 缺 shell/psql、端口/worker 冲突、session/CSRF、调试客户端不支持 logpoint）按手册定位，不以关闭鉴权或伪回执消除。

**Deferred：** LLM 供应商、外部推送/设备送达、计费/市场、多端/多用户、重复任务、性能/混沌全矩阵、通用 E2E/遥测框架、全 IANA 规则扩展。完整 A2/A3/A4 的上述缺口不是 Deferred，只是与七步代表性运行分开的未完成验收工作；外部通知、鉴权 UI 等不会被拿来替代现成 session/本地通知链。

## 8. 规划基线复核的关键依据

- `apps/api/src/modules/tasks/scheduler/registry.ts:24–31`、`cancel-phase.ts:65–95`：撤销终态依赖回执，`recordCancelReceipt` 在 apps/packages 的调用仅见两处集成测试，未见生产调用。无可用语言服务器，引用核对采用文本搜索并结合实际调用代码。
- `apps/web/src/app/tasks/[id]/page.tsx:14–78`、原 tasks API 详情：当前仅展示任务与事件账，尚无 notifications 数组/面板。#26 独立 spec PR 冻结新数组合同，批准合并不等于源码已实现；具体字段见 tasks API 文档与七步手册。
- `docs/design/07-task-events-ledger.md:45–47`：取消后零触发指标数的是调用接口的瞬间；零通知/零 fired 只能作为辅助证据。
- `openspec/specs/v0-safety-contract/spec.md:20–23`、`apps/api/src/modules/conversations/service.ts:447–469`、`docs/api/conversations/conversations_routes.md:60–64`：冻结 spec 要求时间错误走 thread.failed，实际澄清走 thread.completed；`apps/api/src/http/app.ts:70–85` 的 readiness 只判断版本值是否存在。这些是完整验收边界，不因 #26 七步授权或文档落地而被视为通过，不自动扩入 P4。
