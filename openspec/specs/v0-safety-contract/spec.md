# v0-safety-contract

Issue: #14（S0 契约冻结：v0 安全内核 5 项裁决）

## Purpose

冻结 v0 安全内核的唯一行为契约：错误码 HTTP、事件词封闭集、表名、confirm 三件套、取消计时点、按钮确认、简报只读。实现（#4/#7a/#7b/#8/#9/#10）只认本契约 + design，不认旧 api/schema 别名。

## Requirements

### Requirement 1: 错误码 HTTP 唯一

系统 SHALL 以 `docs/design/10 §6` numeric `40xxxx` 为码，以 `docs/api/README.md §5` HTTP 表为传输语义：`PRESENTATION_MISMATCH 409`、`APPROVAL_EXPIRED 410`、`APPROVAL_SUPERSEDED 409`、时间四错 `422`、`BUDGET_EXCEEDED 429`、`TZDB_UNAVAILABLE/NOT_READY 503`。

#### Scenario 1.1 回显对不上停住

- WHEN confirm 的 `presentation_hash` 与快照重建预期不一致
- THEN 返回 `409 PRESENTATION_MISMATCH`，不建 task（映射 A2）

#### Scenario 1.2 时间四错只澄清

- WHEN normalize 返回 `NONEXISTENT/AMBIGUOUS/UNKNOWN_TZ`
- THEN 走流内 `thread.failed`（422 语义），不建 approval（映射 A4）

#### Scenario 1.3 规则缺失不开张

- WHEN `TZDB_VERSION`/alias/ruleset 缺失
- THEN `/readyz` 返回 `503 TZDB_UNAVAILABLE/NOT_READY`，不降级（映射 F3）

### Requirement 2: 事件账封闭集

系统 SHALL 只写 `created/scheduled/fired/missed/cancel_requested/cancelled/reconciliation_run` 七类；`ACK_UNKNOWN/FAILED_DEADLINE_WINDOW/SUPERSEDED` 只进 `outbox.status`。

#### Scenario 2.1 一态一事件

- WHEN task 状态跃迁提交
- THEN 同一事务恰好一条对应事件，无合成行（映射 A1/A3）

#### Scenario 2.2 非法 type 拒绝

- WHEN 写入 `saved/schedule_confirmed/superseded/ack_unknown` 作为 `task_events.type`
- THEN check 约束拒绝（映射 D5）

### Requirement 3: 表名与约束

系统 SHALL 用 `outbox`（废 `outbox_events`），`task_leases` 承载 fencing，`security_events` 记录取消破 0（一年留存、不留内容）。

#### Scenario 3.1 并发双写唯一

- WHEN 同 `(task_id, fire_at_utc)` 并发双写
- THEN 一成一 `23505`，无第二条 scheduled（映射 D3）

#### Scenario 3.2 取消破 0 有行

- WHEN 取消提交后仍发出触发请求
- THEN `security_events` 记 `cancel_breach`，人复核（映射 D9）

### Requirement 4: confirm 单事务与按钮确认

系统 SHALL 只认按钮确认；同一事务验 owner/pending/有效期→比 hash→建 task→写 created→写 outbox→consumed；任一失败全回滚；重复回同一 task。

#### Scenario 4.1 并发双击同一 task

- WHEN 同一 approval 并发 confirm 两次
- THEN 仅 1 task/1 created/1 outbox，两次 200 同 `task_id`（映射 A2）

#### Scenario 4.2 三错零 task

- WHEN `PRESENTATION_MISMATCH/EXPIRED/SUPERSEDED` 任一发生
- THEN 建 task 数为 0（映射 A2）

### Requirement 5: 取消计时与回执门

系统 SHALL 以 `cancel_pending` 提交事务落定为取消已提交计时点；无 `schedule_receipt` 不标 `scheduled`，无撤销回执不标 `cancelled`。

#### Scenario 5.1 取消竞争两终局

- WHEN 取消与到点并发
- THEN 或 `cancelled` 后无 `fired`，或 `fired` 后取消 `409`，无中间态；取消已提交后触发数为 0（映射 F2）

#### Scenario 5.2 kill 后恰好一次

- WHEN worker `kill -9` 后 resume
- THEN 通知恰好一条，事件账仅一条 `fired`（映射 F1/A3）

### Requirement 6: 简报只读投影

系统 SHALL 以 `GET /brief` 只读投影 tasks/approvals，不建 `briefs`/`cards` 表；展示只读冻结字段；口径只说已记录步骤。

#### Scenario 6.1 点卡不建 task

- WHEN 点击简报卡片
- THEN 不产生 task，须走确认门（映射 A1）

#### Scenario 6.2 改 UTC 展示不变

- WHEN 快照 `fire_at_utc` 改 1 小时
- THEN 展示输出不变（映射 D2）

### Requirement: 任务详情只读站内通知投影

系统 SHALL 在既有任务详情成功响应及 Web 任务详情提供仅属于当前 owner 与该任务的站内通知只读投影，遵循 `docs/design/03-v0-vertical-slice.md` §3.1 与 `docs/api/tasks/tasks_routes.md` §2.1 的 DTO、空态、错误和模块所有权；不得新增通知路由或任务列表字段，不得把读取变成发送、重试或已读操作，展示只报告已记录步骤。映射 A1、D1/D2/D8/D10；取消与真实七步安全要求继续引用主 spec Requirement 5 及 design/03 §3.2，不在本增量重定义。

#### Scenario: owner 与既有详情错误边界

- WHEN 已认证 owner 读取本人、他人、不存在或非 UUID 的任务详情
- THEN 本人成功响应只含该 owner/任务的通知，其他情况沿用详情既有 `403` 或 `404` 而不返回通知；未认证仍为 `401`，通知读取由通知模块公开 service 承接，tasks/Web 不绕过存储边界（映射 D1/D8）

#### Scenario: 尚无通知的明确空态

- WHEN 本人任务存在但尚无已持久化的站内通知记录
- THEN 详情返回必有的空通知数组，Web 明示无记录，不从任务状态或事件合成通知；通知查询失败沿用详情错误而不伪装成功空态，任务列表保持原形状（映射 A1/D8）

#### Scenario: 冻结展示与无副作用读取

- WHEN 重复读取任务详情，或只改变触发 UTC/展示环境而未改变通知存储文本
- THEN 已存通知标题/正文保持原样，读取不调用 provider、不发送/重试/标已读，不新增或改写任务、通知、事件、outbox；展示不宣称设备送达或用户已读（映射 D2/D8/D10）

#### Scenario: 真实通知持久化后可见

- WHEN 已确认任务由真实 worker 到点处理并提交站内通知记录，随后 owner 成功读取详情与 Web 任务页
- THEN API 与页面显示同一已存通知及其实际状态/可空发送时间，不以 fired 文案冒充通知，不多造通知或触发请求；本地记录不被表述成用户收悉证明（映射 A1/D8/D10）

### Requirement: A4 typed时间失败与唯一流终结

系统 SHALL 按 `docs/design/05-time-core.md` §9.1、`docs/design/10-api-and-stream-design.md` §4/§6 与conversations §4区分普通缺信息/模糊澄清与已判定时间错误，保持既有七事件词、HTTP/SSE分层及每run唯一终结；失败只允许既有审计，不产生承诺写入。

#### Scenario: 不存在时刻不是completed澄清

- WHEN 健康规则下已建立SSE的请求归一纽约2027-03-14 02:30且结果为不存在时刻
- THEN 外层HTTP200，流内唯一thread.failed承载NONEXISTENT_LOCAL_TIME与422语义；可解释但不再completed/cancelled，不建approval/task/task_events/outbox/notification、不调用provider（映射A4、D8/D10）

#### Scenario: 重复未选带结构化双候选

- WHEN 请求纽约2026-11-01 01:30且fold未选择
- THEN HTTP200流内唯一thread.failed为AMBIGUOUS_LOCAL_TIME/422，按design/05 §9.1返回明确墙上时间/时区和有序两候选，不以中文话术代替结构；无承诺写入，GET恢复与同键重放仍是同一失败序列（映射A4、D8）

#### Scenario: 普通缺信息仍澄清

- WHEN 用户缺年份/时区/时段或给模糊范围，且没有已判定typed时间错误
- THEN 按既有必问/挡回规则解释，可completed但无approval，不用设备/LLM/默认时区猜决定；不得把gap/fold/UNKNOWN归入此成功路径（映射A4、D1/D10）

### Requirement: A4应用上下文与预检零新run

系统 SHALL 按 `docs/design/05-time-core.md` §5.2/§5.3共用API应用拥有的不可变实际规则上下文、别名及可用结论，供readyz与所有新归一入口使用；time-core保持零I/O纯函数、调用方显式提供锚点，不复制fixture。预检先保持既有身份/权限/输入/幂等边界，不把新规则门变成全站阻断。

#### Scenario: 坏规则在SSE与新run之前拒绝

- WHEN 通过既有认证/CSRF/结构/owner/幂等边界的新归一请求遇到规则、alias、版本或声明内容不可用
- THEN 返回HTTP503业务envelope TZDB_UNAVAILABLE，未发送SSE头、不调用normalize，新conversation/message/run/attempt/idempotency与承诺写入均为零；修复后可用未占用的新请求正常提交（映射A4、D1/D8）

#### Scenario: 认证与CSRF不被503覆盖

- WHEN 同一坏规则部署收到未认证请求、CSRF不符请求或已通过身份但既有资源/幂等冲突请求
- THEN 保持既有401/403、资源错误或409优先，不创建新run、不泄漏他人资源；不以TZDB故障绕过权限或覆盖既有边界（映射A4、D8）

#### Scenario: 流中发现故障与旧结果重放

- WHEN 新run已建立流后才发现规则故障或所需时间范围外，或客户端重放既有终结run
- THEN 前者以HTTP200内唯一failed503 TZDB_UNAVAILABLE结束，允许既有失败审计但零承诺写；后者只重放原序列不重归一/新建run，不因故障或断连追加第二终结（映射A4、D8）

### Requirement: A4有限覆盖与用户未知时区分界

系统 SHALL 只承诺 `docs/design/05-time-core.md` §5.1/§5.2 的三zone有界实际规则，精确执行本地与UTC半开边界、相对锚点及全部转换校验；不得宣称全IANA或固定zone历史任意年份正确，不得把用户未知指示混成服务坏规则。

#### Scenario: 年月边缘与转换瞬间不外推

- WHEN 三zone输入触及已声明本地上下界、UTC对应边缘、24:00/相对次日跨界，或纽约四次转换前一秒/瞬间/后一秒
- THEN 包含下界、排除上界，所有成功/候选/所需锚点依design/05 §5.1校验，越界报TZDB_UNAVAILABLE而不沿末偏移；范围内gap/fold继续正确失败或按显式选择归一（映射A4、D1/D8）

#### Scenario: 用户未知与声明zone缺失不同

- WHEN 健康上下文收到本profile未知ID/别名，或实际部署丢失声明支持的zone/alias/规则内容或标识不匹配
- THEN 前者为UNKNOWN_TIMEZONE/422且不污染readyz，后者为TZDB_UNAVAILABLE/503并令readyz非就绪；不能把丢失纽约规则报用户未知，也不把未知用户zone报服务坏包（映射A4、D7/D8）

#### Scenario: 不重算旧冻结对象

- WHEN 实际规则不可用但DB可达，用户读取/确认既有冻结approval、读取/取消旧task或worker自然执行旧task
- THEN 仍按既有权限/有效期/按钮/取消回执及冻结UTC运行，不调用新归一、不被新规则门阻断、不重写旧时区/fold/偏移，取消安全合同与旧证据按适用性保留（映射A4、D2/D9）

### Requirement: A4显式时区与Web候选重提议

系统 SHALL 按 `docs/design/05-time-core.md` §9.1/§9.2和conversations §2/§4的字段与优先级识别显式时区、保留结构化fold，并在Web用服务端候选完成新键重提议；客户端不得计算UTC或将选择当成确认。

#### Scenario: confirmed timezone不能吞未知别名

- WHEN 原文给未知显式别名/规范ID，分别在无已确认值及已有Shanghai默认值下提交
- THEN 均为UNKNOWN_TIMEZONE typed失败422，不静默忽略或排到Shanghai；多个不同有效时区则问清，不按别名表顺序选首项（映射A4、D1/D8）

#### Scenario: first与second保留同一意图

- WHEN 真实Web收到纽约歧义失败后用户分别选择第一次或第二次
- THEN 显示服务端偏移并保留原输入、明确日期/纽约时区与对应结构化fold_choice，用新幂等键重提议；服务端独立归一，2026-11-01 01:30得到对应05:30Z/-14400或06:30Z/-18000，pending回显冻结数字fold与偏移，只有按钮确认才建task（映射A4、D2/D8/D10）
- THEN 选定后的 SSE 正文与审批详情均明确第一次/第二次及对应数值 UTC 偏移；新 first 冻结 v2 并按同一版本计算 hash 和校验所见正文，不能以缺少选择语义或偏移的旧普通回显确认。既有 v1 模板不悄悄替换，有展示缺陷的旧提议作废后重来，正确的冻结新旧对象不依赖当前规则可用性（design/06 §2、§5，映射A4、D2/D8）

#### Scenario: 编辑或跨午夜不沿旧候选算UTC

- WHEN 用户编辑原日期/时区，或相对表达的重提议发生在既有跨午夜/延迟约束下
- THEN 清除不再适用的候选选择并重新校验/追问，保留服务端原锚点而不按点击时刻重算，不复用未选fold的幂等键、不用/me覆盖明确纽约、不从自由文字猜fold或由客户端算UTC（映射A4、D1/D2/D8）

### Requirement: A4真实readiness与可追溯缺失证据

系统 SHALL 按 `docs/design/05-time-core.md` §5.3/§10和`docs/design/10-api-and-stream-design.md` §6维持既有探针形状、D7及五门，并以真实装载故障与旧冻结行为证据补齐A4，不把mock或readyz单点冒充完整演练。

#### Scenario: 规则与DB未就绪reason确定

- WHEN 实际规则/alias/标识不可用、仅DB不可达或二者同时失败
- THEN readyz返回非envelope的503，规则故障优先TZDB_UNAVAILABLE，否则DB失败NOT_READY；healthz仍200，不新增组合码或全系统健康框架（映射A4、D7/D8）

#### Scenario: D7保留而不接受假版本

- WHEN 两轮全新卷执行原D7缺版本与有实际规则场景
- THEN 缺版本503含TZDB_UNAVAILABLE；使用匹配实际加载内容的fixture-v1且DB可达才200，未认证业务仍401，不为旧2024a字符串放宽规则；D1–D10和固定五门均保留（映射D7/D8）

#### Scenario: 真实缺失部署与证据范围

- WHEN 后续A4收口声称规则缺失/alias缺失/损坏/标识不符及旧冻结task隔离通过
- THEN 证据串联实际生产装载源变更、源码/镜像/规则身份、重启、HTTP/SSE、SQL及旧冻结结果；mock坏对象只作回归，部署缺失未实际发生或关联缺失则不宣称验收/完整v0完成，独立review及archive仍需执行（映射A4、D7/D8/D10）

### Requirement: 明确目标的完整修改与重新确认

系统 SHALL 只通过design/06 §9.1–§9.2定义的显式修改动作，替代本人有效pending create_task提议；新提议冻结完整内容/时间和重新计算的回显hash，旧提议只变superseded，修改不等于确认，也不推断同会话其他pending为修改目标。

#### Scenario: R1 完整修改仅产生新待确认提议

- WHEN owner对有效目标提交完整且可唯一归一的内容
- THEN 原子形成旧superseded与唯一新pending，新详情冻结新回显/hash且指向旧项，修改及重放均零task/task_events/outbox/notification；同会话独立新建不自动替代（A2/D2/D8）

#### Scenario: R2 严格body和不可归一输入

- WHEN 修改缺必选字段、包含非法类型/null/超界/未知字段，或完整内容仍缺必要信息/模糊
- THEN 依API §6返回既有VALIDATION_ERROR，无新提议/替代；fold省略仅等价none，不能替用户猜歧义或补账户/会话默认内容（A2/D6）

#### Scenario: R8 新提议必须重新按钮确认

- WHEN 用旧确认键或新键确认已superseded旧项，或展示输入已改变后用旧hash/旧所见确认新项，再以新详情三件套重复按钮确认
- THEN 旧项409 APPROVAL_SUPERSEDED，新项旧展示409 PRESENTATION_MISMATCH，错误均零task；正确新确认只产生同一task及既有单事务结果，不因修改自动确认（A2/D3）

#### Scenario: R8 相同展示仍可按新详情重新确认

- WHEN 合法修改产生与旧项相同的canonical presentation，客户端读取新ID详情并重新按钮确认
- THEN 沿既有v1允许相同hash及相同所见值，不因来源相同拒绝；旧ID仍因superseded不能确认，新ID重复确认只产同一task，不引入盐或额外无变化校验（A2/D2/D3）

### Requirement: 修改边界不得越权或改变冻结时间权威

系统 SHALL 按design/06 §9.2、§9.4与API §6执行既有session/CSRF/UUID/owner错误边界，使用#30/A4公共时间上下文与纯归一用例，不复制fixture/alias/解析，不在Web算UTC或以修改重算旧冻结任务。

#### Scenario: R3 安全边界先于任何持久写入

- WHEN 未认证、CSRF不符、路径非UUID/不存在，或actor修改他人目标
- THEN 沿用401/403/404/403及既有numeric/symbolic envelope；不产生幂等预约、替代或task，不暴露他人successor/task，亦不将他人pending顺路写expired（D6/D8）

#### Scenario: R2 共享时间失败不废旧项

- WHEN 共享入口判定不存在/重复未选/未知时区或别名/规则不可用或超批准范围
- THEN 按A4公共合同分别返回422/503与既有码及结构化歧义候选，不静默回退；旧项不supersede、新项/task不创建，允许已接受请求的预约留存；公共规则不可用不阻断已有冻结详情、确认、执行或取消（A4/D1/D6）

#### Scenario: R11 真实详情入口明确编辑再回显

- WHEN owner在真实Web的有效pending create_task详情修改完整内容/显式时区，必要时选择服务端fold候选并提交
- THEN 客户端保留未决body/键以安全重试，修正输入才换键；失败保留旧项/输入，成功读取新详情显示真实状态和新回显再按钮确认，不算UTC、不自动confirm、不将本地持久记录宣称必达（A2/D2/D10）

### Requirement: 修改幂等与首次持久时间跨重启成立

系统 SHALL 依design/06 §9.3将修改键、目标、规范请求摘要、首次持久接收anchor及可空结果关联存于approvals自有最小持久映射；安全/结构/owner通过后才预约，完成结果优先重放，保留期不以自动清理释放键，禁止借outbox或conversation幂等表。

#### Scenario: R4 同键重放与不同请求冲突

- WHEN 同owner同键以同请求（包括fold省略/none等价）重复或并发修改，或以异body/跨目标复用该键
- THEN 同请求成功只关联同一新提议，后续200 duplicate=true；异body/跨目标409 STATE_CONFLICT且不返回其他目标结果；不同owner独立，不用confirm/reject的键误命中revise（A2/D3/D6）

#### Scenario: R5 预约后死亡或成功响应丢失

- WHEN 首次持久预约后、替代前进程死亡，或替代结果已提交但响应丢失并重启重试，且重试跨本地午夜
- THEN 前者沿原持久anchor恢复，后者重放同关联而不重归一；相对表达不被原会话/重试/客户端时间改义；预约提交前未被服务端接受的请求不被谎称已有可恢复到达时间（A2）

#### Scenario: R5 成功后状态变化仍只回原结果

- WHEN 同请求成功后其新项已消费、过期或再次被替代，或者当前规则不可用，原请求再次到达
- THEN 返回原旧/新ID与duplicate=true，不假称当前仍pending、不重建后继/重算/延寿；详情读取现状态，当前request_id不冒充首次调用ID（A2）

### Requirement: 替代原子性与锁后有效性一致

系统 SHALL 按design/06 §9.3–§9.4将新pending、旧superseded和成功结果一次提交，以同一目标行锁与confirm/reject串行化；获得锁后及写入前使用DB实际当前时间核对有效期，不用事务起始时间或冻结anchor充当现在。新迁移唯一后继约束禁止分叉。

#### Scenario: R6 修改与确认或拒绝竞争

- WHEN revise与confirm或reject竞争同目标，各自可能先获锁提交
- THEN 修改先赢时旧confirm/reject均409 APPROVAL_SUPERSEDED；confirm先赢时修改409 STATE_CONFLICT并保留原task语义，reject先赢时修改409 STATE_CONFLICT；不自动取消task、不创建失败替代（A2/D3）

#### Scenario: R6 两次修改及后继再次修改

- WHEN 两个不同键竞争修改同旧项，或用户后续明确修改已生成的pending后继
- THEN 同旧项仅一个直接后继，落后请求409 APPROVAL_SUPERSEDED；后继再改需显式以该ID为目标，形成单链而非重复修改旧前驱；cancel_task和rejected/consumed非可修改状态沿既有STATE_CONFLICT（A2/D3）

#### Scenario: R7 等锁或归一期间到期

- WHEN confirm/reject/revise等待目标锁期间expires_at或fire_at到期，或修改归一后写入前旧项/新目标时刻已过
- THEN 依API §6返回410 APPROVAL_EXPIRED，旧pending到期须正常提交expired后返回错误；不因抛错回滚该状态，不建新task/后继，不因锁前曾有效而放行（A2）

#### Scenario: R9 业务故障全回滚并保留可恢复预约

- WHEN 新项插入、旧state更新或结果关联填写任一步失败，或试图直接插第二个同前驱后继
- THEN 三项业务改动全回滚而已提交预约保留原anchor可恢复，数据库唯一约束拒绝重复后继；不产生无后继superseded、双替代或task，非预期DB错误脱敏500而不伪造成功（A2/D3/D4）

### Requirement: 修改契约通过受控迁移及真实证据收口

系统 SHALL 依design/06 §9.5–§9.6仅用新迁移部署修改能力，保留已有迁移和业务行，按独立契约→实现→真实验收→review→archive顺序交付，不把合同草稿或预置superseded测试当作A2完成。

#### Scenario: R10 干净库与脏后继迁移

- WHEN 在全新/已有干净库应用迁移，或预检发现重复、缺失、自指、跨owner、循环或非法关联后继
- THEN 干净库原子建立最小映射及唯一约束；脏库中止发布并保留原行待明确修复，不自动删除/改owner/state、不LIMIT 1掩盖（D3/D4/D7）

#### Scenario: R10 迁移或版本发布失败

- WHEN 迁移失败，或schema成功但新API/Web版本发布失败
- THEN 迁移事务全回滚且不暴露revise；版本失败保留additive schema/数据并受控恢复，无法满足新owner/锁后时限的旧版本不得恢复写流量，不以删表或独立新建静默降级（D4/D7）

#### Scenario: R11 独立合同与真实A2证据

- WHEN 提交合同PR或申请关闭#31
- THEN 合同只Refs且经独立review、精确head固定五门SUCCESS和CLEAN后才实施；关闭前有真实详情修改/旧确认拒绝/新回显确认单task及重试竞争证据、独立代码和证据review与archive，保留D1–D10和固定工具版本；未覆盖项不得写已收口（A2/D6/D10）

### Requirement: 本地发送许可与独立接收

系统 SHALL 遵循 `docs/design/08-scheduler-and-delivery.md` §7–§9，以持久一次性许可区分可发送与可能已发送；仅当前成功领取许可的执行可在重新通过 task/outbox 栅栏后调用；notifications 模块独立提交接收事实并通过公开 service 核对。取消提交后不得调用。未知不重发，唯一通知行不替代实际调用证据。

#### Scenario: 确定未许可的崩溃可正常恢复

- WHEN claim 已提交而调用许可未提交，worker 被真实 SIGKILL 后恢复，task 仍符合版本/时刻/登记回执及发送宽限
- THEN 可领取一次许可并正常发送；并发恢复最终实际调用 1、接收事实 1、通知 1、fired 1，许可事务失败不残留半结果（映射 A3、D3/D4）

#### Scenario: 接收匹配和独立提交

- WHEN 接收事实已提交后回答丢失或 worker 结果事务回滚，或核对输入带错 owner/task/版本/冻结时刻/发送键
- THEN 匹配事实跨连接和重启存活，通知由接收端独立提交、worker只核对幂等收尾，错绑定不获成功也不触发；不因外层 task 锁、FK 或池饥饿形成接收锁环，不新增跨模块写事务（映射 A3、D1/D3/D9）

#### Scenario: 许可不越过取消

- WHEN 一次性许可提交后取消先提交，或取消与调用串行竞争
- THEN 调用前重新栅栏拦住已取消项，取消提交后实际调用 0；无撤销回执仍 pending，历史接收事实不授权取消后调用或 fired（映射 A3、D9）

#### Scenario: 核对宽限与终态重启

- WHEN 有效接收事实在截止前已提交但恢复核对迟于 fire+15min，或无事实项已超窗，或终态后重启
- THEN 已接收项可只核对完成历史结果，无事实项不补发并诚实保留未完成，终态不重复调用/通知/fired；升级旧不确定 send 不得直接重放（映射 A3、D5/D9/D10）

### Requirement: 未排期过窗必须终结

系统 SHALL 按 `docs/design/08-scheduler-and-delivery.md` §4–§5、§8 的取消优先与回执边界，在任务锁及同一事务内将超过触发时间 15min 的 saved/pending_schedule 任务转为 missed，追加唯一对应事件并终结排期队列；不改变冻结时间、不补发、不伪造 scheduled/sent 或回执。恢复扫描 SHALL 包含旧 worker 已终结 schedule 命令但仍残留的未排期活跃任务。

#### Scenario: 首次调度已过窗

- WHEN 用户已确认任务但从未完成排期，worker 首次处理时已超过触发时间 15min
- THEN saved 或 pending_schedule 转为 missed，schedule 命令终结、事件只有 created/missed，schedule receipt 和通知均不存在，provider 实际调用为零（A1/A3、D5/D9）

#### Scenario: 旧命令终结后恢复及重复处理

- WHEN 未排期任务已过窗且 schedule 命令已被旧 worker 标为 failed_deadline，或多个 worker 重复/并发处理同一过窗任务
- THEN 仍能恢复到 missed，每任务仅一条 missed 事件、状态版本仅递增一次，不重开旧命令、不调用 provider（A1/A3、D5）

#### Scenario: 取消先提交及已排期接收边界

- WHEN 取消先于 missed 转移提交，或已排期任务存在需要核对的真实接收/未知发送结果
- THEN 未排期终结不覆盖 cancel_pending/cancelled；取消仍需真实撤销回执，已排期沿用原接收核对和未知不盲重发规则，不借此新增 fired 或调用（A3、D9）
