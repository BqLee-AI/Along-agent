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
