# close-v0-time-errors 任务

> Issue #30。契约 PR34 已经独立审查及其精确 head 五门 SUCCESS/CLEAN 后合入；下列实现和运行项依据版本化证据勾选。固定 Bun1.4.2、OpenSpec1.3.1；五门不改名、不减项。收口 PR 的精确最终 head 结果在 PR/CI 中记录，不把旧结果改标。

## 1. 独立契约块（实施前置）

- [x] 1.1 只读核对fixture三zone/纽约2026–2027四转换、entry优先级、normalize结果/候选、HTTP/SSE/schema/readyz/D7与Web缺口；起草proposal/design/spec及design/05、design/10、conversations、Agent话术、黄金说明。
- [x] 1.2 主线程整合PRD04、API README §5/§6与共享索引；明确readyz reason优先级、DB可达非迁移检查及D7用实际版本，保留冻结spec权威与D1–D10。
- [x] 1.3 OpenSpec1.3.1严格校验、独立契约review；PR34精确head五门SUCCESS/CLEAN后合入，随后才实施。

## 2. 规则与入口实现块

- [x] 2.1 在API应用装配实际不可变规则/alias/版本/有界覆盖上下文，readyz、开始帧及全部新归一入口共用结论，移除生产gateway旁路fixture；time-core保持零I/O纯函数，不读env/时钟/网络。
- [x] 2.2 公共归一用例接受调用方显式UTC首次接收anchor/跨日判定接收时刻、原文/已确认时区/fold_choice；conversation保持会话anchor，A2只适配其持久首次anchor，不重建规则。范围、显式时区/未知别名、字段优先级和fold语义统一。
- [x] 2.3 新归一在身份/CSRF/结构/owner/幂等只读边界之后、任何新run写入及SSE头之前预检503；既有结果重放和旧冻结读取/确认/取消/执行不被全局门阻断。
- [x] 2.4 readyz校验实际规则/alias/标识并最小真实DB探测；沿非envelope形状与reason优先级。D7有版本轮及相关fixture改成实际fixture-v1，保留两轮全新卷与原断言，不改五门/CI编排。

## 3. 协议与Web实现块

- [x] 3.1 时间四错保留typed结果跨gateway/agent/conversation投影；HTTP200内failed422/503、AMBIGUOUS结构化details与唯一终结/回放；普通缺信息和模糊表达继续澄清。
- [x] 3.2 在任何approval创建前完成全部时间校验；失败允许既有审计但approval/task/task_events/outbox/notification/provider为零，预检连新conversation/message/run/幂等都无。
- [x] 3.3 Web展示服务端两候选与数值偏移，保留原输入/明确日期/所选timezone，first/second以新键重提议，编辑清除旧选择；客户端不算UTC、不从话术猜fold、不拿/me覆盖纽约，成功后才显示既有按钮确认门。

## 4. 有效回归与真实部署证据

- [x] 4.1 复用仍适用golden/DST/reverse-clock/表达与冻结展示回归，新增上下文完整性与alias/标识检查；逐zone测本地/UTC上下界包含排除、24:00与相对跨界，纽约四次转换前/瞬间/后与gap/fold两候选。
- [x] 4.2 HTTP/PG回归证明预检无新run、认证/CSRF/owner/冲突优先、流内200+failed422/503、唯一终结与恢复、零承诺写；未知ID/别名在空/已有时区下均失败，坏声明zone与用户未知不混码。Web实际覆盖first/second及新键/保留意图。
- [x] 4.3 独占真实生产装载来源分别制造缺version、规则缺失/损坏、alias缺失、标识内容不符，记录源码/镜像/实际输入/重启与HTTP/SSE/SQL差异；mock仅作回归，不作为真实演练。静态嵌入资源需落实最小实际装载边界，不编造不存在的资源文件/环境变量。
- [x] 4.4 故障前经真实入口冻结旧task；故障期按既有合同读取/取消或自然到点，证明无重算/新规则门阻断。DB断开单独记录readyz503/healthz200，不宣称DB坏时业务可用；保留适用#26证据，不重开已完成主链。
- [x] 4.5 真实Web/session/Next/SSE取证未来DST错误与两候选重提议，关联request/run/approval及偏移/fold；不靠确认过期黄金日期或mockUTC证明成功。first遗漏回显缺陷由新增v2解决，旧有缺陷v1实际拒绝不改写；复验Chat/revise/confirm及未知冻结版本拒绝。

## 5. 收口、D项变红测试与A4验收

- [x] 5.1 D1：time-core零依赖/零I/O与单一应用上下文，坏包/缺alias不能走fallback；D2：候选UI只读服务端值、冻结展示/客户端禁算时间变红测试保留；D7：缺版本/坏规则/DB不可达非就绪、有实际规则+DB可达就绪，healthz与401保留；D8：HTTP/进程内契约、SSE唯一失败/structured details/重放与Web边界有效；D10：失败不冒充completed、选择不冒充确认、口径不承诺必达。映射A4：NONEXISTENT/AMBIGUOUS/first/second/UNKNOWN/TZDB与真实缺失部署全部有证据。
- [x] 5.2 D3–D6及D9既有唯一性/append-only/确认与取消安全门不降级；按真实影响补回归，不用A4新规则检查重算旧task，不把mock故障代替旧冻结路径真实证据。
- [x] 5.3 已执行适用本地检查及独立代码/证据review；验证版本和原失败/补跑分别记录。收口PR仍强制检查其精确最终head五门SUCCESS/CLEAN才合并，不用本项勾选冒充尚未完成的最终CI。
- [x] 5.4 已整合共享PRD/API/索引与证据，并由OpenSpec1.3.1实际archive为2026-10-22-close-v0-time-errors；仅本领域实现/验收收口PR可 `Closes #30`，精确最终head五门SUCCESS/CLEAN仍为合并前硬门。独立契约PR只 `Refs #30`，完整v0由总计划A1–A4/D1–D10共同决定。

运行记录：[A4 时间错误与规则就绪](../../../../docs/demo/v0-time-errors-evidence-2026-10-21.md)。代码审查 .99、DB中断证据 .90、资源矩阵 .98、first-v2 定向 .97 均为只读AI审查，不是独立运行或人工批准；原始负面证据保留。完整v0仍受独立的 A1 验收阻塞，不因本领域收口提前宣布完成。
