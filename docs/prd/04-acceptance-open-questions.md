# 04 验收标准与待决事项

> 范围：v0、R1、R2-A 验收与默认关闭的 R2-B 路由合同、Deferred 清单和重开门槛；不包含测试实现或原始运行证据。实现、受控实验、真实用户路径和自然流量的验收分别记录。

> 授权作用域：下列v0/R1逐项按钮和单工作区保留为现行/legacy验收；连接按冻结生命周期解释，早期新委托也可request-bound。新合同见“本人目标内委托”一节，规范不证明后台或其他未交付能力已实现。

## v0 验收（四条，全部按自家可测指标）

- [Required] A1 喝水恰好一次：输入"明天 9:20 提醒我喝水"（已确认时区）→ 回显冻结 → 确认 → 建单次 task → 登记回执 → 到点 15 分钟内应用内通知恰好一次；task_events 含 scheduled（含回执号）→ fired 全链；对外只说已记录步骤。
- [Required] A2 重复确认单任务：同一 approval 重复确认只回同 task。明确修改本人有效 pending create_task，按完整输入及首次持久 anchor 重新归一，原子保存旧 superseded、唯一新 pending 与幂等结果；修改及重放不建 task。旧确认 409 APPROVAL_SUPERSEDED，新详情重新回显再按钮确认。覆盖同键重放/异 body 与跨目标冲突、响应丢失/重启、改与 confirm/reject 竞争、锁后到期及失败回滚；真实 Web/HTTP/只读 SQL 关联证据见 design/06 §9，不把预置 superseded 当完整修改链。
- [Required] A3 崩溃恢复安全优先：确定尚未获调用许可的项可恢复正常一次；独立接收已提交的项 kill/resume 后只核对收尾，跨进程实际调用累计 1、receipt 1、通知 1、fired 1。许可后无接收事实的项不盲重发，允许待核对或超窗未完成，不承诺任意崩溃点都严格一次且完成；实际调用可为 0/1，但不得重复。取消已提交后实际调用仍为 0。真实故障阶段、绑定与迁移见 design/08 §7–§9；唯一通知行不替代调用证据。
  - 确认后从未排期、首次 worker 处理已超 15min 的 `saved/pending_schedule` 同样终结为 `missed`；遗留已失败排期命令不阻碍恢复。重复/并发处理只有一条 missed，无虚构 scheduled/sent/回执、无 provider 调用；状态/事件/队列失败全回滚，取消先提交不被覆盖（design/08 §5，#42）。历史已排期 A1 证据不代替本分支验证。
- [Required] A4 时间错误：不存在本地时刻、重复未选、未知时区/显式别名分别 typed 422 失败；两候选由服务端提供，Web保留完整输入/时区，以 first/second 与新键重提议，不算 UTC、不当作确认。缺信息/模糊仍澄清。三 zone 的有限 2026–2027 本地区间及精确 UTC 边缘见 design/05 §5；范围外/规则不可用为 TZDB_UNAVAILABLE，未知别名不得因已有确认时区被忽略。认证/结构等边界后、SSE与新 run 前预检规则；已开流故障唯一失败终结，承诺零写/零调用。readyz共享实际规则/alias/版本与DB可达判断，不接受任意非空版本；真实缺失装载与旧冻结读取/确认/取消/执行隔离需取证，不能以mock代替（design/05 §9–§10、API §6）。
  - first/second 的待确认正文须同时展示选中的次数与冻结数值偏移；新 first 使用 v2，既有普通/second/cancel v1 不换模板。已确认显示有误的旧提议作废重来，不改旧快照或已建任务；规则缺失仍可读取并按冻结版本校验正确的新旧提议（design/05 §4、design/06 §2）。
- [Required · #92] 提醒日期锚归属请求：旧会话的新明确今天/明天使用本轮服务端接纳锚；仅同 owner/conversation、全部未完成候选唯一且紧邻上一 user 消息、原输入/冻结来源可追溯的终态 done/failed 缺时区澄清或歧义失败可继承。整条明确时区别名/规范 ID 可补原缺时区；精确 fold 重提议须原文完全相同、实际候选时区及 `clarification_of_run_id` 指原失败 Run，不是确认。多候选、无关中间目标、旧数据缺来源或其他不明补充要求完整重述，不从模型历史凑日期（design/05 §3、§9.2）。
  - 同日本地 120 秒不报 `DATE_CHANGED`，真正本地午夜 20 秒仍问具体日期；无时区先问，缺日期/时段/事项不建批准。新 Run 冻结 anchor/received 与 `reminderDateSource`，不新建表/迁移、不回填旧 Run；工具重放、批准恢复、历史只沿原冻结，未来时间/确认有效期不变。纯函数、真实 HTTP/隔离 PG、正式 native 与真实模型质量须分别取证，规范采纳或历史运行证据不代替新锚实施验收。
  - delegation 的直接创建在结构化 time 澄清中只读提供真实规则错误和 DST 候选；first/second 补充沿同 owner/conversation 的唯一前序关系、相同原文和候选时区继承原锚，补齐后直接创建，无新批准。创建回执本身既不证明已排期，也不证明“尚未排期”，实时状态须读取实际记录。
- [Required] 验收环境：单镜像 all 角色 + compose 冒烟；Postgres 唯一事实源；Redis 缺席不得影响验收（Redis 已延后）。
- [Required] CI 合并门：`static` 通过后，迁移约束、调度故障、契约双跑与 `compose-smoke` 四条下游只依赖 static、各自隔离并行；static 失败则全部下游不运行。五个 job 必须全部成功才允许合并，人工保护约定与 D1–D10 语义不变；Compose 可在其他下游失败前已消耗资源，但不共享用户数据或可变数据库（见 design/13 §3–§4、ADR 0007）。
- [Required] 工具链验收遵循 Bun 1.4.2 冻结安装、Oxlint 1.89.0、Oxfmt 0.74.0 与 `bun:test`；`bun run verify` 是本地与 static 的共同阻塞入口。依赖优先构建后串行执行全部 workspace 类型检查，保留源码、测试与 Next route typegen。文件级并行保留隔离及 mock/时钟恢复；只有只读边界 fixture 可最多两个真实 CLI 并行，逐项拒绝断言、绿例两种扫描和清理前等待均须保留。`test:contracts` 包含 API 两种传输及契约包，`test:integration` 覆盖全部真实 PostgreSQL 16 集成文件，`test:scheduler` 保留 D9 指定集。D1/D2 原边界与断言不因工具或调度改变（见 design/01 §5、design/13 §3–§4、ADR 0006、0008）。
- [Required] 同次 verify 仅复用成功 typecheck 构建的共享 packages；失败构建不消费，独立单元入口与跳过 typecheck 的 verify 仍真实准备包，不依赖旧 dist 或跨 job 产物。Compose 宿主不安装没有宿主消费者的依赖，镜像内仍真实执行 Bun 冻结安装、构建与运行；缺/有 `TZDB_VERSION` 两轮全新卷的就绪场景均须保留，格式错误不能作为警告放行。验收结果记在对应 change tasks / PR，不把未执行检查写成完成。
- [Required · #43] HTTP入口在业务POST收集前复用身份与适用CSRF头门禁；原始JSON字节累计不超过131072（含分块/UTF8），超限413 PAYLOAD_TOO_LARGE，空/畸形JSON400 VALIDATION_ERROR，响应头/envelope/error的request_id一致。拒绝未消费上传先发有限响应再关闭，不等end或无界drain；合法小JSON与keep-alive、冻结确认/取消事务不回归。真实HTTP有限上传和隔离PG覆盖见对应PR；不以此声明DoS、代理缓冲、内存/吞吐或慢连接防护已验收（design/10 §1.1）。
- [Required · 职责基线] 仓颉唯一组织模型/工具循环、本次上下文、行动选择、预算、等待/恢复/停止；TS 长期保留 ToolGateway/能力、身份/批准/时间/任务/worker、API/Web 与 Run/checkpoint 存储（design/09/11、ADR0009）。最小接入不等于完整 R1；补读不执行，checkpoint/fencing 不保证通用 external exactly-once。
- [Required · 工具提议] 供应商一次返回多个工具提议时均不执行；助理在原预算内按单步继续，逐项依据真实结果决策，不重复既成或效果未知的动作（design/09 §2）。
- [Required · #45] TS先持久预约逻辑工具引用；同引用顺序/并发/丢回答重交回同一接受结果，同参数新动作使用新引用。本地批准、接受结果及审计同事务，故障零脱节批准/任务/事件/outbox/通知；只追加审计不代替结果账。重放原冻结批准/只读快照，当前权限撤销遮蔽而不改写历史事实；原denied不升级执行。非事务一次许可后未知不再写，只读核对同引用/摘要证据才能完成。真实PG、临时文件fsync/强杀、签名会话HTTP→SSE→确认/取消与补读分别取证（design/04 §3、06 §10、09 §5–§6）；本项证据不扩张成MCP产品工具、通用exactly-once、跨语言消费者或Run自动恢复，D8按#47的独立消费者证据限定声明。
- [Required · #46] 明确 business/harness 归属，冻结 TS 权威，native/模型不能自报 owner/工具范围；每步验证当前 owner/授权/最新 attempt/取消。Run 终态消息/事件/attempt 同事务；取消先持久资格撤销再收回 native/模型传输，保留既成效果。真实批准后有限快照挂起，同 Run 显式恢复唯一新 attempt；提前确认/并发/丢回答/换键不重复调用，拒绝/过期/替代不追 successor 或绕拒绝。内部快照过滤，GET/同入站键只读，游标提交不漏帧；五工具公共 query-client 投影保原合同。正式 native 与真实 Web/HTTP/PG 证据可使用模型 transport 注入，不允许回放器替代核心或生产 fixture 回退（design/09/11）。
- [Required · #47] 根 `test:contracts` 与 `contracts-dual` 在本次生产构建的 Bun/native runtime 中执行相同合同，保留 healthz/契约包，新增本地公共用例与签名 HTTP 的真实 Run、工具结果、批准恢复、拒绝、取消和重放。必需消费者逐项出现在本次实际报告且唯一通过，缺构建/报告/消费者、跳过或失败均不能全绿；移除结果纳入或资格裁决须导致具体错误结果或越权效果而变红。unknown 只声明真实非事务核心→native 的停止/不重发子合同，不冒充产品 HTTP、生产 unknown 快照或通用恢复。D8有限 enforced 与未覆盖 partial 范围须在 manifest、检查器和文档一致（design/13 §4.2、design/11 §4）。

### #26 七步 smoke 的通知可见面与结论边界

- [Required] 站内通知经既有 `GET /api/v1/tasks/{id}` 的 `notifications` 只读数组与 Web 任务详情可见，无记录返回 `[]`，任务列表不加字段、不新增独立通知路由。每项仅含现有 `id/title/body/status/sent_at`；`status` 的实际域是 `pending/sent/failed`，`sent_at` 可为 `null`（design/03 §3.1、API tasks §2.1、schema `notifications`）。
- [Required] 详情与通知均限定当前 owner；不存在/非 UUID、跨 owner、未认证沿用详情 `404/403/401`，失败不能伪装成功空态。读取无发送、重试、已读或其他业务写副作用；通知查询归 notifications 公开 service 所有，tasks 按 owner/task ID 调用，Web 只经 HTTP 取值。标题/正文原样展示，不重算冻结时间，`sent` 不证明设备送达或用户已读（D1/D2/D8/D10、A1）。
- [Required] 按 `docs/demo/v0-slice-smoke.md` 在同一受控环境执行简报→只读卡片→真实 SSE→按钮确认→真实到点及通知→活动账→另建任务取消；以 API/Web/只读 SQL 与真实 provider 调用记录关联本次 ID，不用预置业务状态、假通知或测试手注回执代替生产入口。取消合同沿用安全 spec Requirement 5 与 design/07 §3：实际撤销本地队列并核对 fencing 后持久化撤销回执，才可 `cancelled`；无回执仍 `cancel_pending`。
- [Required] 取消已提交后 provider 实际调用数为零需单独证明，零通知/零 `fired` 不能替代。优先受控、非暂停 debug logpoint，必要时仅补无内容的最小证据，不新建遥测框架。运行记录须覆盖取消任务原到点窗口及原宽限窗，附正向任务调用作为观察器正控制（A3/D9）。
- [Required] 独立契约 PR 先经独立 review、既有五门全绿及 CLEAN 后合并，再实现、真实七步与 archive。七步代表性运行不等于完整 A1–A4 或 v0 结案；A2 完整替代确认、A3 完整 kill/resume、A4 错误合同与规则缺失冲突在本次不修、不宣称通过，仍保留为额外验收边界，详见 closeout plan §6。D1–D10、五门、按钮确认、回执门及冻结展示语义不变。

## R1 资料到简报任务（#62）

- [Required] 用户在现有 Web 选择本人受管工作区，以真实仓颉、真实模型和有限 TS 文件/MCP 工具查证项目资料、提出精确文档修改，按钮批准后在同 Run 保存并通过新读取核对；不需要先建设记忆平台或完整办公生态。合同见 [design/14 §1–§11](../design/14-r1-document-task-loop.md) 及主行为 spec：[workspaces](../../openspec/specs/workspaces/spec.md)、[agent-runtime](../../openspec/specs/agent-runtime/spec.md)、[tool-gateway](../../openspec/specs/tool-gateway/spec.md)；[归档验收记录](../../openspec/changes/archive/2026-10-26-define-r1-document-task-loop/tasks.md)限定实际证明范围。
- [Required · 验收边界] 资料位置、冲突日期和读失败的变体必须影响实际选择；至少一个真实 TS MCP 调用的结果被正式 native 消费，不能用固定工具回放或受控模型代替真模型任务证据。保留无关内容、范围外零披露/零修改、预算/取消停止、精确批准和新调用回读分别取证（D1/D6/D8/D9/D10）。
- [Required · 效果口径] 文档批准仅授权，非事务写入不等于 PG 原子事务。同批准只绑定一个 apply；未知不重写、不凭当前相同内容制造回执。确定零写冲突可在新读取和新批准后完成后继，保留原冲突事实；未尝试或未知动作不能借替代绕过。
- [Required · 收口] #45–#47 复用，不重做；R1 的合同审查、实现、正式消费者和真实模型/产物验收分别记录，完整矩阵通过后才归档并关闭 #62。A1–A4 原定义和五门不变，LLM 供应商/市场/推送/计费仍按 Deferred 管理。

## R1 本地生命周期（#67）

- [Required] 用户通过固定初始化、启动、停止、显式升级入口运行同一安装；复用 Bun/Compose/正式 Linux x64 native/MCP 和 Windows Web，不把根 dev 当完整正式环境。合同见 [design/15 §2–§7](../design/15-r1-local-lifecycle.md)，步骤见[本机使用指南](../guides/local-lifecycle.md)。
- [Required] 两次启停后原认证/模型配置、PG/资料卷、用户历史、原 owner 登记和 root 身份保持；原配置缺失明确停下，不生成替代密钥、换卷、清库或复制新根目录。只停止本入口拥有的进程，重启不自动恢复 Agent 或重做未知写入。
- [Required] 新库完整初始化，已核实的 0016 基线重复启动不重放 DDL，未知/部分旧库拒绝自动迁移；账本从 0012 建立，旧迁移冻结，不猜版本或自动 stamp。升级单一部署写者，停旧写者后迁移，失败不开新写者；修复后已提交步骤不重复，接纳新事实后停写前滚。
- [Required] 既有受管登记重启后按原 owner/root 加载，缺登记与无效登记有不同诊断；新安装可明确处于账户/工作区未配置或账户状态未核验，不冒充完整任务可用。#67 不选择管理员；#68 使用稳定配置与重载入口完成开户/转正后的绑定，不形成循环关闭前置。
- [Required] 按用户指南在受支持本机环境验证正式 Web/API/native/MCP/PG/模型路径；进程健康、配置齐备、真实模型调用分别取证，不自动付费探测。指南覆盖接入旧安装、配置保留、日常命令、升级与失败恢复，秘密不进仓库和普通输出。
- [Required · 验收边界] #67 独立负责生命周期证据，沿用五门与认证/CSRF/owner/批准/取消/unknown；合同校验不算运行验收，#62 历史证据不转记为新入口可用。正式账户、历史发现、视觉/MVVM 和跨模块完整任务分别由 #68–#70 及 #66 收口，不扩展 R2。

## R1 账户与正式登录（#68）

- [Required] 空安装通过真实 Web 建立唯一管理员并登录；同一真实 PG 事务和唯一约束保证并发唯一、失败无孤儿。已有用户、历史 owner、登记或管理员时禁止匿名接管，依赖不能核验不猜空安装。合同见 [design/16](../design/16-r1-account-access.md)、[auth API §4](../api/auth/auth_routes.md#4-r1-账户访问68) 和 [identity 行为规格](../../openspec/specs/identity/spec.md)。
- [Required] 有效旧签名会话经 CSRF/明确确认仅转正当前 owner；无会话由正式本机维护入口明确选原用户，不默选 seed、不手填 ID、不批量合并。原 users.id、历史、任务、批准及工作区 owner 保持；已有密码不被覆盖，disabled 不自动激活。
- [Required] 复用锁定 Better Auth 密码/credential/Cookie 和现有 HMAC resolver；补齐标准字段、UUID、真实事务及 raw token/HMAC 边界。浏览器经正式 proxy 获得的 Cookie 必须被 /me 接受，PG 不存 raw token、响应不泄漏凭据。
- [Required] 固定七天会话不滑动；过期正式重登同一人。退出确认 PG 撤销后才清 Cookie，库 success 或本地清理不代替服务端事实；DB 故障准确报错，不伪成功或误作会话过期。
- [Required] 窄接口核对真实 Origin、适用会话 CSRF、严格输入和原始 body 上限；proxy 保留真实来源、多 Cookie、no-store、SSE 和 abort。错误密码/无 credential/disabled 等公开失败不可区分，原 owner/批准/取消/unknown 与五门保持。
- [Required] 账户页面可用键盘、粘贴和密码管理器；401 保留安全原站内位置，重登后只读原状态，不重发消息、确认、取消、继续或其他 POST。403/503 不一律跳登录，错误可操作。
- [Required] 账户提交、登记/配置保存与 #67 重载分层完成，失败不重开户。正式本机入口自动取绑定管理员 ID，保留原 root/登记/有限授权，不让浏览器/模型决定 owner 或直接写宿主配置。真实本机和 PG 的完整路径不得依赖助手、seed、临时服务或手工 Cookie。
- [Required · 验收边界] 隔离确认锁定库字段/事务/token/退出/proxy 后完整实施 API、数据库、页面与本机收尾；只新增下一序号迁移并配套版本核验和扫描规则。合同不等于已运行，规划不冒充缺陷复现。七项验收齐备后独立归档只关闭 #68，不进入 #69/#70/R2、不提前关闭 #66。
- [验收依据] [2026-10-27 账户与本机登记验证记录](../verification/account-access-verification-2026-10-27.md)分别记录库实验、行为覆盖、真实生产构建、本机使用路径及独立静态审阅；[归档清单](../../openspec/changes/archive/2026-10-27-close-r1-account-access/tasks.md)对应七项验收，不以其中一种证据替代其余边界。

## 受邀账户（#112）

本节定义账户准入与 P1 验收目标。设计、接口、字段与行为分别见 [design/21](../design/21-invited-account-access.md)、[auth API](../api/auth/auth_routes.md)、[identity schema](../schema/identity-schema.md)与 [change](../../openspec/changes/productize-invited-accounts/proposal.md)。[实现验证](../verification/invited-account-implementation-2026-11-03.md)分列正式代码、隔离真实 PG/HTTP/浏览器与生命周期证据；外部放行依然须满足下方真实邮件、HTTPS、密钥托管和保留批准，不能用实现代替。飞书连接不属于本阶段。

- 准入与管理分离：绑定管理员仍是本人业务用户，只额外持有窄安装管理资格，不得读取其他 owner 的任务、批准、会话、Run、工具结果、通知或资料。邀请接受或明确本机维护建立准入；不因 `users.status=active`、邮箱相同或历史 owner 存在就放行。
- 原身份保留：原管理员验证真实恢复地址时，原 ID、不透明 `auth_email`、credential、认证 secret、历史 owner 和工作区身份不变。真实邮箱独立加密与用途分离 HMAC；旧邮箱 hash/verified 字段不自动授予恢复资格。
- 完整入驻：管理员经当前口令确认邀请；邮件 GET/预览零消费，收件人显式 POST 设置凭据，同事务完成账户/准入/已验证联系人/凭证消费，提交后不自动登录；随后经正式 Web/proxy/库 Cookie 登录。丢响应、并发接受/撤销/重发、旧代/跨用途/过期与地址唯一竞争最多产生一套完整事实。
- 本机口令重置（#131）：邮箱找回不可用时，部署者经受信本机终端 `local:account --reset-password` 明确选择已准入且 active 的账户并输入 `CONFIRM <序号>`，隐藏输入两次新口令；同一事务写入口令并撤销该用户全部会话与未消费挑战，失败保持旧口令。用户 ID、业务数据、登记不变；disabled、未准入或 credential 冲突账户拒绝。设计见 [design/16 §3](../design/16-r1-account-access.md)。
- 会话与恢复：固定七天、GET 不续期；本人改密与找回使旧密码失效、全部会话撤销，提交确认后才清 Cookie；持旧 Cookie 下一请求为 401。恢复不激活停用/注销请求账户，不变更安装绑定。匿名找回统一响应，依赖失败准确 503，持久原子限流覆盖多进程而不披露地址存在性。
- 无本机工作区是合法账户状态：第二用户进入本人空资源面，仍可完成账户/恢复/会话管理；聊天只在实际既有依赖就绪时可用。不继承管理员 root，不把安装级登记诊断当本人未开户。本机登记必须显式选人并合并保留其他条目。
- 停用/注销请求：撤销会话及未消费资格，阻止新动作、新披露和未获发送许可的新投递；实时事件和重放与停用串行，已写入响应缓冲的字节无法撤回。保留已发生事实，不伪造任务取消/撤销回执。唯一管理员不能被该路径停用/注销，用户禁止物理删除；Run 行为遵循其冻结生命周期，不接管 #104。
- 正式页面与旧安装：Origin/适用 CSRF、严格 DTO/原始 body 上限、多 Cookie/no-store/流式取消保持；401 才安全重登，403/503 保留错误，返回只 GET，绝不重放邀请/恢复/消息/批准等 POST。仅新增前向迁移，集成时分配编号并更新核验/扫描；旧安装副本升级及两次启停保留原身份/历史/密钥/卷/root，接纳新事实后只前滚修复。
- 验收责任：identity 负责人持有锁定库/真实 PG/邮件与竞争证据；Web 负责人持有双浏览器、正式 proxy/页面/生产 HTTPS 与零 POST 重放证据；本机维护负责人持有旧安装副本/显式登记证据；集成负责人只补跨模块缺口并汇总五门。P0 合同/实验不勾选 P1 产品完成、不归档 change、不关闭 #112。
- 证据分层：[本阶段库可行性](../verification/invited-account-feasibility-2026-11-03.md)、[外部前置核对](../verification/invited-account-external-prerequisites-2026-11-03.md)与[旧账户记录](../verification/account-access-verification-2026-10-27.md)保留各自日期/版本/限制，不把隔离库用户当正式邀请、不把公开资料当真实送达。

### 受邀账户外部前置（#112）

以下待确认项阻塞账户 P1 真实外部验收和入口放行，不阻塞代码实现与自有隔离验证。凭据只经既有安全配置渠道提供，不进入 issue、日志、Git 或本次 `.env*` 写入。

| 待确认项             | 提供/批准方       | 需要的事实与受阻验收                                                                                               |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| 邮件供应商与发送资格 | 用户/部署者       | 选择通道、Region/生产发送权限、最小 API 权限与费用边界；真实接受、失败/超时/接受未知尚未验证                       |
| 发信域名及 DNS       | 域名持有人/部署者 | 发件身份、SPF/DKIM/DMARC、回信/退信策略与 DNS 变更授权；不代注册或修改                                             |
| 受控邮箱             | 用户              | 管理员与第二测试用户可独立访问的收件箱、允许的测试对象/范围；真实送达、点击/预览/恢复尚未验证                      |
| 生产来源与 HTTPS     | 部署者            | 精确 `APP_ORIGIN`、邮件链接来源、HTTPS/证书/代理与访问日志处理；本地 Cookie 不证明生产来源与 Secure 边界           |
| 密钥托管与恢复       | 部署者/安全负责人 | 联系人 HMAC、一次凭证用途密钥、AEAD 的独立 key-id/托管/访问人/备份恢复/轮换；原认证 secret 不变，缺 key 不重生覆盖 |
| 隐私与保留           | 产品/安全负责人   | 供应商可见邮箱/链接、处理区域/保留、日志脱敏、本地载荷清理与注销请求口径；本地删除不承诺供应商零保留               |

实现提供显式 Resend HTTPS 适配器，不自动选取账户或配置生产发件人。供应商批准与真实接受/收件仍需外部证据：其发送幂等窗口为 24 小时，不能以邀请 48 小时有效期推导无限重发安全；SES 沙箱也不等于生产发送资格。公开依据见[外部核对记录](../verification/invited-account-external-prerequisites-2026-11-03.md)。

## R1 会话历史与只读恢复（#69）

- [Required · 用户目标] 清空客户端临时状态、不保存旧 URL，退出后以同账户正式登录，仍能从服务端找到原会话、原话、指定 Run、可见回复、批准及真实结果。历史不以提醒列表或活动账的首批数据代替。
- [Required] conversations 提供本人会话、可见消息与 Run 的有界集合；列表按不变的建立时间排序，活动时间只读展示。分页保留微秒与 ID tie-break、首屏上界及明确刷新语义，不承诺跨 HTTP 数据库快照。字段和 API 见 [design/17 §3](../design/17-r1-conversation-history.md#3-列表排序与cursor)。
- [Required] 原话只沿可信已存引用读取，旧数据缺关联时如实说明；可见回复沿全部外部事件分页，所有批准均可达。任务批准详情提供真实 task 结果引用，文档继续区分授权、写入和新回读，不另建资料任务事实表。
- [Required · 保护] owner 隔离、内部记录过滤、空/不存在/无权/依赖/部分失败准确区分；列表、打开、刷新、回退和重登恢复不调用模型/MCP，不新增 Run/attempt/决议/工具调用或文件写入，不自动重放业务 POST。工作区撤权不借历史展示恢复动作资格。
- [验收依据] 六项 #69 验收以真实浏览器与隔离 PG16 对照原始事实，复用 #67 生命周期与 #68 正式账户路径，记录读取前后执行账及文件证据不变。行为真源为 [conversations](../../openspec/specs/conversations/spec.md)，完整步骤见[归档清单](../../openspec/changes/archive/2026-10-28-close-r1-conversation-history/tasks.md)，版本化结果与未覆盖项见[验证记录](../verification/conversation-history-verification-2026-10-28.md)，不以合同校验代替运行。
- [验证边界] `0018` 四个非唯一索引的设计与核验见 [design/17 §9](../design/17-r1-conversation-history.md#9-数据索引与兼容发布)；新增 `conversation_idempotency(run_id)` 仅支撑旧原话回退查找，保留 scope/歧义检测与上述用户合同。原三索引与四索引查询计划/生命周期证据分别记录，不将后者扩大为重跑完整模型验收。
- [非目标] 不做 #70 全站视觉/目标导航、搜索、导入导出、跨 owner 合并、账户机制修改、自动恢复或 R2；实现与验收后独立 archive，只关闭 #69，不提前关闭 #66。

## R2-A 单 Run 上下文（#83）

- [Required] [design/18](../design/18-r2a-harness-context.md) 定义四种额度、不可变 policy、来源投影、原版本回取及有界批准恢复；[agent-runtime](../../openspec/specs/agent-runtime/spec.md)、[tool-gateway](../../openspec/specs/tool-gateway/spec.md)、[workspaces](../../openspec/specs/workspaces/spec.md) 定义行为，[归档清单](../../openspec/changes/archive/2026-10-30-manage-harness-context/tasks.md) 分列实现、受控运行和真实模型验收，不把文档校验当运行完成。
- 用户结果：保护输入/必要事实可容纳、预算未耗尽时，不因旧正文重复累积无谓失败；旧资料可查证，批准后沿原 Run 唯一写入并新回读。63＋1 与完整输入、精确批准/当前权限、取消和 unknown 不弱化。
- D8/D9：六个分别合法大读总量超过1MiB，正式 native/PG/本地和签名 HTTP 的恢复/下一轮仍有界，原接受正文与 snapshot2 全引用不变；独立输出 cap、完整 tools/包装计量、窗口/余额边缘与未知 usage，不能容纳时零后续调用，不增加硬上限。
- 输入计量不可用或仅为估算时，不承诺累计 tokens 的调用前硬封顶；在途请求可能超额，按返回的真实 usage 记账并停止后续请求。验收须明确区分该后验停止与 verified 输入计量下的调用前可行性判断。
- D1/D6/D8/D9/D10：原版本回取、同路径不同版本/冲突日期/部分 failures、Unicode 与页边界；跨 owner/Run/旧 attempt/撤权/取消拒绝，旧 Run 不扩权。片段不作全文基线或 apply 后新回读，unknown 不转成功。
- 真实验收须与 #70 串行：正式 Web/native/TS MCP/PG/真实模型处理至少六份各自合法大资料、冲突日期、一次读取失败，实际投影和新 invocation 回取旧证据后完整预览、批准零写、显式继续、唯一 apply、新全文读取；小任务对照无无谓模型轮。每轮 bytes、可得 usage/unknown、调用数、延迟与产物分账记录，合成实验/受控消费者不替代真实任务。
- 不包含 R2-B、R3/R4、摘要模型、任意崩溃恢复或 provider/市场/推送/计费决策。只有真实任务证明确定性投影不足或分页成本不可接受才重开摘要/页容量合同，不预建平台。完整矩阵与既有五门后才 archive/关闭 #83，不提前关闭 #66。

## R2-B 有限只读路由（#88，默认关闭）

- [Required · 用户结果] 完整规则或轻量语义匹配能够办完的自足只读请求，可经原工具网关直接交付，不调用聊天模型；其余完整交原模型处理。沿用 [design/19 §1–§4](../design/19-r2b-readonly-intent-routing.md#1-范围与不变项)，不改变 business/harness、缺省值、按钮批准、取消或原能力范围。
- [Required · 范围] 仅有限活动提醒列表（默认20或明确1–50）、本人记录时区、单个明确合法日期的现成简报卡片；查全、筛选/全文、核实效果、写动作、多目标、分析、承接或缺参数不直接处理。固定展示说明标题预览、has_more、时区null和简报50张边界，不多承诺。
- [Required · 自足问句] 对话已有历史不应阻挡意思完整的“哪些”查询；仍按完整目标、参数和语义阈值判断，不以识别到疑问词代替意图判断，不放行指代、否定、筛选或多目标。
- [Required · 完整目标] 不得以默认活动列表代替停用/标星筛选，以读取代替新增、加入或发送，以本人账户偏好代替他人或设备时区。批量提醒的请求数量与标题序号不证明已创建数量或后续计划，实际结果依创建/执行回执；部分失败不承诺自动补齐，不擅自补建。
- [Required · 选型] BGE-small中文INT8为资源优先候选，multilingual E5-small FP32仅离线对照，不在线双模型轮询。实际量化发行物、编码和独立阈值绑定版本，不能把旧Qwen/TEI或BGE FP32配置套过来；模型许可、Linux服务和逐意图质量分别验证，离线观察不等于生产批准。
- [Required · 许可交付] [第三方模型声明](../../apps/embedding/third-party/bge-small-zh-v1.5/NOTICE.md)随编码服务携带完整MIT文本、固定模型版本/哈希与量化作者声明依据；保留不同型号讨论的推断边界，不伪称第三方已补license标签。历史冻结manifest不回写，模型许可判断不代替完整镜像依赖清算。
- [Required · 误判验收] 保留BGE“时区→提醒”误接、被淘汰Dmeta的“读后修改丢目标”反例和六条共同规则误挡。修复为通用行为，不能逐句白名单、删失败、改gold或拿已见材料当新留出。新bundle重新校准、冻结后评估未见材料；任何已知实质误接均阻止开启（design/19 §6、§12）。
- [Required · 默认关闭] 新功能默认off；旧Run/GET/同入站键重放/批准恢复零分类，影子观察零旁路工具、回复仍走原模型。direct接纳前可因语义不适用或可选编码失败回原路径；接纳后执行/展示失败诚实终结，不换模型重做。取消、来源与数据库错误不能伪装成拒识绕行；路由记录未实际插入也按持久化失败处理，不留下半份接纳或已披露正文。
- [Required · 开启条件] 每意图分别有完整目标/参数/来源的人工审阅、无已知实质误接、正式消费者与真实宿主闭环、可接受的资源和拒识增量、对L1 miss非零正确增量和保守净收益；未满足保持shadow/off，不自动开量或降阈值。299独立接受/意图只对应特定统计声明，不是开发前置；5%起步是受控建议而非发布授权（design/19 §11–§12）。
- [Required · 验证与交付] [change](../../openspec/changes/define-readonly-intent-routing/proposal.md)的agent-runtime/tool-gateway/conversations增量按D1/D6/D8/D9/D10及既有五门分层验收。实现、Linux编码服务、合成质量、正式消费者、真实Web与自然流量分别在[任务记录](../../openspec/changes/define-readonly-intent-routing/tasks.md)取证；受控provider不替代原真实模型。默认off实施PR以覆盖最终变更的有效实现与消费者证据交付，使用`Refs #88`；自然shadow、受控接管及最终归档不是该PR必须全部完成的阶段，但不得冒称通过或免除其后续门槛，不因此部署、开量、archive或关闭#88。
- [Required · 暂停边界] 自然质量或保守净收益未获证实时，可暂停专项、保持off并停止专用编码服务，应用和历史事实继续保留；暂停不是自然shadow或受控接管验收通过。恢复shadow或开启enforce需对应授权，模型声明交付不代替完整镜像/依赖分发清算。时间性运行状态与结果仅记入任务Verification。
- [非目标] 不借优化裁决提醒改期次序、多目标同/拆Run、同名对象选择或批准流程中的独立请求策略，不进入R3/R4、工作区写入、在线学习或provider/市场/推送/计费决定。超出本白名单的请求沿原路径，不暗中改变原产品行为。

## 本人目标内委托（#105 目标合同；#107 本人时区切片）

合同真源为 [design/20 §1–§10](../design/20-goal-scoped-delegation.md) 及 [OpenSpec 增量](../../openspec/changes/refactor-assistant-capability-authorization/proposal.md)，总范围为 #104。时区、提醒及本人登记现有资料的能力各以实际冻结 profile 为准；有限新文件创建和 server-owned 仍属后续阶段。实现、受控消费者与真实用户路径分别取证，整体 change 随适用实施与真实验收收口。

- 接纳边界：Web 普通 Agent 显式发送 `authorization_revision:'delegation/1'`；可选 `workspace_ids` 收窄本人有效登记集合，省略则冻结全部，不能与 legacy `workspace_id` 同用。省略修订和提醒/资料快捷入口保持 legacy，不从部署或 wire 自动升级权限。本人时区写入经 identity 窄用例，不开放任意账户 patch。
- 配套合同：v6 start 的真实 trusted context 进入 system 层，legacy 显式 null；新委托 SSE v2 与旧 v1 历史严格分读。RunView 展示冻结 request-bound 与持久 GoalResult；0021 只新增根 `agent_runs.goal_result`，旧数据 NULL 不回填。最终 answer、目标结果和 Run/attempt/事件终结原子保存，收据须符合真实接受结果/设置事实，Run done 不能代替目标完成。
- 本切片的连接验收：初次发送和历史恢复均说明绑定连接、无后台继续；断连/停止后已接受设置和提醒仍可见，未完成或未知项不掩盖。GET、刷新、重连、重登只有只读恢复，不自动发消息/批准/继续/取消或重做已接受效果。新 profile 可用 `create_reminder` 直接创建明确的单次墙上时间或严格经过时长提醒，缺口仅补实际信息；旧 settings-only 和 legacy 不扩权。
- 资料编辑验收要求：同 owner 多工作区与显式子集、当前 grant/路径复验和真实 MCP 全文读取；正常修改及明确全文重写不生成虚假批准。精确写入绑定同 Run 完整基线与一次许可，只有写后独立新全文读取支持 verified；冲突、部分效果和 unknown 分别呈现。新增影响须完整预览、有效原等待点及一次明确授权并继续，拒绝、停止、撤权或未知效果不得绕路推进。旧 pending、旧 Run 和 legacy 单 grant 不迁写。实现、受控消费者及真实 Web→provider→native→TS→MCP→文件/PG 证据分开记录，不能由合同或模型回答代替验收；有限创建和 server-owned 不在此阶段实现。

- 正常自主：真实保存/清除本人时区，明确提醒直接创建/唯一取消，受管资料正常编辑/有限创建，多步混合目标零机械批准；明确重写/覆盖/取消不问相同授权。
- 必要打断：实质歧义只补缺口，新增目标/影响只授新增部分。新profile允许一次精确“授权并继续”，不机械要求第二按钮；决议自身不是写入/保存，拒绝/停止/unknown/迟到或无效等待点不推进，GET/重登不授权/继续。legacy保持原显式继续合同，HTTP次数不预设；跨owner、登记外/链接、缺能力不能按钮突破，零写冲突可自主新读修正。
- 资料正反例：仅摘要遇改设置/取消注入零额外效果；明确按资料建提醒可真实执行，不一概拒绝第三方事实。真实模型评估独立人工审定目标/预期效果，不用模型原答案当 gold；明示语义误判残余。
- 时间：可信 UTC 锚+180秒，无偏好不追问时区/时段；墙上/日历时间保留实际规则/DST/缺口。原目标过窗未建不顺延，UTC依据、展示版本与今日 UTC 区间投影同交付，不伪造 TZDB。
- 接续和结果：#103来源责任扩展typed缺口，同源并发唯一后继，既成收据只读带入、只做未完成项。Run结束不等于目标成功，completed/partial/blocked/unknown及真实任务/文件状态分呈；不增输入长等待/snapshot3/目标表/模型发号去重，不自建Run绕预算。
- 效果与停止：事务、append-only、取消/回执、文件版本/许可/新回读及unknown不重做不变。首批自主偏好可request-bound且如实显示断连取消，不伪造elapsed修订/创建能力；后台验收后仅新server-owned Run断订阅继续，旧/早期Run不随升级改义。停止/取消task/退出/禁用分别验证，最终收口仍须真实server-owned/失联收尾，不能用早期阶段替代。
- 历史发布：新 profile 才获新权能，旧 pending/快照/模板/hash/接受结果不迁写/消费/扩权；文档批准不是统一24h自然过期。v5严格拒绝新wire，新TS/native/Web配套，前向迁移且新事实不交旧写者。
- 验收责任按 design/20 §10 落到具体执行者，保留 D1–D10/A1–A4/五门并按profile更新授权场景。复用有效证据，集成仅补跨模块缺口；业务真实 Web/native/MCP/PG/文件/到点通知与文档检查分账，产品安装复用且不动冻结实验。

## Deferred 清单（每条写明阻塞阶段）

| #   | 事项             | 现状                                                                                                  | 阻塞阶段                                         |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D1  | 目标市场         | 未定；多租户隔离只预留，v0 跑单租户行为                                                               | 阻塞 P5 计费与组织模型；不阻塞 P1                |
| D2  | 仓颉职责（已定） | 唯一 Harness + TS 长期能力/业务/存储；固定 native 工具链与兼容 transport，真实 provider/R1 产物另验收 | 职责已冻结；不以最小接入/限定跨语言门代替完整 R1 |
| D3  | 鉴权方案         | 已定：Better Auth 自建 credential（D7 空环境冒烟不依赖外部 IdP；v0 单租户）                           | 已冻结；schema/05 与 api 鉴权章节按此落地        |
| D4  | Web 框架         | 已定：Next.js，RSC 开、Turbopack 开（默认配置，偏离另开 docs PR 说明）                                | 已冻结；apps/web 脚手架按此落地                  |
| D5  | 推送渠道         | Web Push 仅兜底；邮件/系统推送未选                                                                    | 阻塞 P5 触达扩展；不阻塞 P1（应用内通知先行）    |
| D6  | LLM 供应商       | 未选；预算护栏（BUDGET_EXCEEDED）先行                                                                 | 阻塞成本核算；不阻塞 P1 功能验收                 |
| D7  | 计费模型         | 未定；额度字段留占位不冻结                                                                            | 阻塞 P5；不阻塞 P1                               |
| D8  | 每日任务粒度     | 每日重复任务进 v1；v0 只做单次 + missed 一键重约                                                      | 阻塞 P2+ 重复语义设计；不阻塞 P1                 |

- [Required] 正文不得猜 Deferred 字段：相关 schema/API 留占位，由归属阶段决策解冻；解冻前 /readyz 按类型化错误如实报告，不降级。
- [Required] D3、D4 已在 P0 冻结，不再阻塞 P1 开工（见 03 准入）。

## 重开门槛（什么情况重开已定事项）

- [Required] 取消后触发数破 0：重开 P1，Scheduler claim/lease/fencing 与 outbox 核对逻辑必须复审，人复核放行前不得发版。
- [Required] missed 率或触发延迟持续超基线 2 倍：重开实验起步值（24h/15min/30s/3 退避），以 P1 实测 rescues 为准重新冻结；提醒日期不按锚龄设重问阈值。
- [Required] 仓颉实现/选库验证失败需修正适配或选库，不降为 TS 隐藏 Agent 或迁移全后端；旧 S1–S3 第二实现转正门不再适用。实际恢复保证按工具/故障窗口举证（design/11）。
- [Required] presentation_hash 比对失败率异常（展示与快照系统性对不上）：停在待核对，重开 stream-protocol 版本对照（thread-stream.schema.json）与卡片渲染链。
- [Required] /readyz 类型化错误（tzdb/别名表缺失）出现：服务保持不就绪，重开 deploy 单镜像构建流程，不得手动放行。
- [Proposed] 用户连续要求"范围提醒/尽快/有空时"类模糊时间：记入未支持请求列表（30 天归档、一年删除），只在用户主动查看或 v1 评审时翻出，不为此重开 v0。
