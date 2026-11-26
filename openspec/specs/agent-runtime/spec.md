# agent-runtime Specification

## Purpose

规定仓颉唯一 Harness 与 TS 可信运行权威之间的身份、调用、生命周期、批准等待、有限恢复及事件投影合同。真实边界与副作用验收不替代真实模型供应商、完整 R1 或任意崩溃恢复证明。

## Requirements

### Requirement: 明确执行归属与可信运行资格

系统 SHALL 明确区分既有确定性业务与仓颉执行，并将选择冻结到 Run。仓颉工具请求不能自报 owner、权限或执行资格；TS 从可信进程绑定与持久化恢复实际身份、工具范围、当前 attempt 和取消状态。接口及数据见 `docs/api/conversations/conversations_routes.md` §1–§3 与 `docs/schema/conversation-and-runs-schema.md`，长期职责见 `docs/design/09-agent-runtime-and-checkpoint.md` §1–§2。

#### Scenario: I1 伪造权限或借用调用

- **WHEN** 仓颉帧携带 owner/allowlist 等额外授权字段，或借用其他 owner/Run 的调用引用
- **THEN** TS 拒绝该提交，不披露他人结果、不执行越权工具，不改变原调用归属

#### Scenario: I1 旧 attempt 继续提交

- **WHEN** 已终结或被新 attempt 取代的进程提交新的工具、快照、回答或终结
- **THEN** TS 不赋予新执行资格，不接受其推进 Run 或消息状态；历史结果仍服从独立访问资格

#### Scenario: I6 默认业务兼容且不回退

- **WHEN** 请求省略执行选择、显式选业务、或显式选仓颉但运行依赖不可用
- **THEN** 省略与业务保持既有行为；显式仓颉走正式原生路径或类型化失败，不自动换成业务/fixture；同入站键更换执行类型返回冲突而不新建 Run

### Requirement: 单一生命周期与取消裁决

TS SHALL 原子保存真实资格、运行/attempt/消息及事件投影，仓颉独占下一步选择。按 [design/20 §6.3、§8](../../../docs/design/20-goal-scoped-delegation.md) 区分停止执行、领域取消和目标结果；停止先持久撤销后续资格，不伪撤销既成效果。

#### Scenario: 停止先提交（D8/D9）

- WHEN 显式停止Run先提交，旧进程再预约/调用/挂起/回答/成功终结
- THEN 新动作与迟到推进拒绝，只有一个终态；native/transport被收回，不因换引用或新Run继续

#### Scenario: 效果先于停止（D4/D8/D10）

- WHEN 本地结果已提交或在途非事务效果可能发生后停止
- THEN 保留已发生/unknown，Run停止不等于任务取消/文件回滚；取消已建task须独立明确目标并走原回执门

#### Scenario: 并发终结与传输失败（D4/D8）

- WHEN finish/suspend/stop竞争或传输在接受效果前后失败
- THEN 唯一合法状态和消息/事件原子提交，不留下半终态，不重做原已接受工具

以下保留原合同场景：逐项批准及旧预检属于 legacy，其他安全约束适用新旧 profile；新授权按 design/20 执行。

#### Scenario: I2 取消先于新动作提交

- **WHEN** Run 取消先提交，随后旧进程提出工具、挂起、继续回答或成功终结
- **THEN** 新工具不执行，迟到输出不能覆盖 cancelled 或生成第二终态；仓颉观察取消后停止安排，失控进程由宿主收回

#### Scenario: I2 工具效果先提交

- **WHEN** 本地工具先接受结果或外部效果已发生，之后 Run 取消
- **THEN** 保留已发生事实及 #45 结果账，不宣称效果已撤销；后续新动作仍被取消资格拦截

#### Scenario: I2 并发终结或传输失败

- **WHEN** cancel、finish、suspend 竞争，或事件传输在效果接受前后失败
- **THEN** 只有一个合法状态裁决及对应终态投影，失败不留下半个消息/终结；效果账不因重传而再执行

### Requirement: 批准等待与同一 Run 显式恢复

仓颉 SHALL 在真实待批准结果后保存有限上下文并等待；TS 验证对应调用/批准后原子保存等待点。批准决议按任务与文档种类分别解释，只能按有效等待点恢复同一个 Run，不新造逻辑动作或绕过拒绝。任务批准保留真实消费/任务语义；文档批准只授权后续冻结写入，不能伪造任务结果。见 `docs/design/09-agent-runtime-and-checkpoint.md` §6、`docs/design/06-approvals-confirmation-gate.md` 及 `docs/design/14-r1-document-task-loop.md` §5、§7。

#### Scenario: I3 确认后继续

- **WHEN** 工具建立冻结批准，仓颉挂起，用户按钮确认后显式继续
- **THEN** 等待时 Run 非成功终态；恢复使用同 Run 的新 attempt，引用原 invocation/批准及真实决议，不重建批准/任务、不改写原接受结果

#### Scenario: I3 重复或提前决议

- **WHEN** 确认早于等待提交，或恢复并发、回答丢失后重交、同等待点换新幂等键
- **THEN** 系统从真实批准决议恢复；同一等待点最多分配一次有效新 attempt，不依赖一次通知，也不因重交重复动作

#### Scenario: I3 拒绝、过期或替代

- **WHEN** 等待批准被拒绝、过期或替代，之后显式恢复
- **THEN** 仓颉将决议纳入上下文并停止该未授权动作，不自动跟随新批准或重新提议同义效果绕过拒绝；pending 不允许继续

### Requirement: 执行上下文与事件补读分离

系统 SHALL 将仓颉有限等待快照与对外事件投影分开。快照只追加、仅引用已接受且受当前 owner/Run 校验的调用，预算及逻辑调用进度不倒退；事件补读不启动执行。非事务 unknown 正常失败，不构造可恢复的未知快照。字段及过滤见 `docs/schema/conversation-and-runs-schema.md`、`docs/design/09-agent-runtime-and-checkpoint.md` §3、§6、§8 和 `docs/design/14-r1-document-task-loop.md` §7.3；外部七事件及冻结展示不扩张。

#### Scenario: I4 GET 或入站幂等补读

- **WHEN** GET after_seq 补读，或同入站键重放已挂起/终结 Run
- **THEN** 只返回已存对外事件，不启动进程、新建 attempt 或再次调用工具；running 仍遵守既有冲突规则

#### Scenario: I4 内部快照与旧事件

- **WHEN** 新内部快照和对外事件交错持久化，或读取历史业务 Run
- **THEN** 内部快照不交给外部 ThreadEvent 解析，游标间隙不导致漏帧；历史事件原样可读，不能伪造可恢复上下文

#### Scenario: I4 非法恢复点

- **WHEN** 调用者提交他人、旧等待点、普通中间 checkpoint 或已取消 Run 的恢复请求
- **THEN** 不启动新 attempt、不重放工具；仅本阶段明确定义的有效批准等待点可继续

#### Scenario: R1 未知效果正常终结（D8/D10）

- **WHEN** 正式文件工具返回没有已接受结果的 unknown
- **THEN** native 正常失败并保留真实未知调用，不将其加入恢复快照或继续模型/工具；GET 只读，终态恢复被拒绝

### Requirement: 复用工具事实与所属模块业务规则

工具 SHALL 沿稳定调用、原接受结果、当前资格和unknown规则，通过所属模块公共用例/只读投影执行；新profile不再强制所有领域写入经批准，但时间、事务和回执不变量保留。见 [design/20 §2、§6](../../../docs/design/20-goal-scoped-delegation.md)。

#### Scenario: 同调用及未知（A3/D8/D9）

- WHEN 同调用在新attempt重交或非事务效果未知
- THEN 回原接受事实，unknown停止不盲重发，不按参数/attempt重造动作或伪成功

#### Scenario: 新旧路径共享领域保证（A1/A2/D1/D4/D5/D9）

- WHEN 新委托直接创建/取消，或legacy批准恢复
- THEN tasks公共用例保持task/created/outbox原子、纯时间/typed错误、append-only、取消优先和真实回执；legacy仍验证冻结批准，新路径不造批准

以下保留原合同场景：逐项批准及旧预检属于 legacy，其他安全约束适用新旧 profile；新授权按 design/20 执行。

#### Scenario: I5 同引用重交及未知效果

- **WHEN** 同调用引用在新 attempt 重交，或非事务调用结果未知
- **THEN** 已接受结果按原事实重放，不因参数/attempt 新造动作；unknown 只核对或停下，不盲重发、不假报成功

#### Scenario: I5 原业务安全不变量

- **WHEN** 仓颉经工具提议/确认/取消任务，或读取任务、简报和偏好
- **THEN** 保留冻结确认、确定性时间及 typed 错误、只追加事件/审计、取消优先和真实回执门；公共投影抽取不改变五工具输出或受控原子事务

### Requirement: 正式原生核心与真实边界证明

正式仓颉代码 SHALL 实际组织模型循环、上下文/工具结果纳入、预算、等待/恢复与停止；TS 不保留第二个通用 Agent。构建/运行及证明边界见 `docs/design/11-cangjie-runtime-spike.md` §1–§4 与 `apps/harness/README.md`。

#### Scenario: I6 真实生产者与消费者

- **WHEN** 真实 Web 会话经 TS 启动本次构建的正式仓颉，再经 TS 工具与 PostgreSQL 执行
- **THEN** 可从真实状态及效果验证 Run/attempt/invocation/批准归属、授权拒绝与等待/恢复，不以参数转发、HTTP200 或独立 echo 代替集成

#### Scenario: I6 受控模型响应源

- **WHEN** 测试注入受控模型响应验证成功、失败、预算或取消
- **THEN** 仅替换模型传输响应，不替换仓颉生产核心的循环/提议解析/上下文/预算/等待/停止；报告不得据此宣称真实模型或完整 R1 产物已验收

#### Scenario: I6 依赖缺失或协议不兼容

- **WHEN** 原生产物、运行库、模型连接或协议前提缺失/不兼容
- **THEN** 正式仓颉路径明确失败，无旧产物、测试替身、业务 Agent 或 fixture 隐式回退；原确定性业务仍独立可用

### Requirement: 文档批准后的原运行继续

系统 SHALL 将文档授权决议纳入原运行，并由仓颉选择执行冻结写入及新读取；批准本身不等于效果完成。见 `docs/design/14-r1-document-task-loop.md` §5–§7。

#### Scenario: R1 文档批准后继续（D6/D8）

- **WHEN** 用户核对冻结文档预览并确认，随后从原会话显式继续
- **THEN** 唯一新 attempt 属于原 Run，模型观察真实授权并使用原批准执行，之后实际新读取核对；不新建任务、批准或 Run

#### Scenario: R1 待决、早决议与拒绝（D6/D8）

- **WHEN** 决议仍 pending、早于挂起提交、被拒绝或继续请求并发重交
- **THEN** pending 不启动；早决议从持久事实读取，重复继续不分叉；拒绝停止原动作而不重提同义效果

### Requirement: 真实观察驱动计划与预算

正式仓颉 SHALL 将真实资料、冲突和操作失败纳入后续模型上下文，展示简短可调整的用户可见计划，并执行跨批准继续累计的预算和取消裁决；TS 只提供 transport 和单步能力。见 `docs/design/14-r1-document-task-loop.md` §7–§11。

#### Scenario: R1 任务变体改变选择（D8）

- **WHEN** 真实模型在现有 Web 执行资料任务，资料位置、证据日期冲突或一次读取失败发生变化
- **THEN** 后续选择反映实际观察，必要时查证/改变检索，计划可见而非固定调用回放或隐藏 TS Agent

#### Scenario: R1 批准不重置预算（D8/D9）

- **WHEN** 运行在批准继续后达到预算，或取消已先提交
- **THEN** 不开始新的模型、MCP 或文件动作，预算不因新 attempt 重置；在途或既成效果保留真实已知/未知状态

### Requirement: 分离额度并计量完整模型请求

仓颉 SHALL 分开累计 Run 预算、模型窗口、单次输出上限和序列化字节容量，TS 只计量/传输指定候选；计量与实际 usage 分账，未知不伪造。规则见 `docs/design/18-r2a-harness-context.md` §2–§3、§6。

#### Scenario: 独立输出与完整边缘（D8/D9）

- **WHEN** 累计余额远大于输出 cap，或完整 tools/角色/函数包装使输入达到窗口或余额边缘
- **THEN** 请求仅使用独立可行输出额度；无至少一个输出 token 的可信空间时零模型请求，不把 remaining_tokens 原样作为 max_tokens

#### Scenario: 计量不足与 usage 缺失（D8/D9）

- **WHEN** 输入只有估算/不可计量，或任次 provider 缺 usage，随后批准恢复
- **THEN** 精度如实标识，累计 usage 保持 unknown 而非零或估算，原迭代/已知账不重置；精确字节门仍生效，不宣称不可证明的窗口/费用保证

#### Scenario: 最终包装和输出截断（D8/D10）

- **WHEN** 消息正文单独合法但完整 wire/HTTP 超限，或 provider 明确窗口拒绝/length 截断
- **THEN** 诚实容量失败，不执行截断参数或静默重试；可得 usage 照实记账，不假报完成

### Requirement: 确定性投影不改变事实与调用语义

仓颉 SHALL 仅在容量压力下选择有来源的确定性观察投影，保护冻结输入和执行事实，保持真实函数配对与完整 snapshot2；TS 不替代仓颉决策。见 `docs/design/18-r2a-harness-context.md` §4–§6。

#### Scenario: 六次大观察与原事实（D8）

- **WHEN** 六个分别合法的大读取使聚合体超过 1MiB，且保护集及最小输出可容纳
- **THEN** 正式 native 后续请求有界，旧正文经合法可回取来源投影，接受结果和全部快照引用/usage/调用号不变，不提高硬门

#### Scenario: 新观察、不同版本与函数配对（D8/D10）

- **WHEN** 新结果到达，或旧调用对被投影，同路径存在不同版本、失败/部分搜索
- **THEN** 新结果先真实呈现，旧函数对整体移出且无孤立 tool/假调用；来源/版本/失败/冲突不合并成成功，观察不升级为系统指令

#### Scenario: 无法容纳保护集（D8/D9/D10）

- **WHEN** 完整冻结输入、新全文基线或其他不可省略事实自身超限，或已到引用/消息/迭代门
- **THEN** 明确容量或预算失败，不截断冻结材料、不删账、不换 slot/自动新 Run、不再调模型或工具

### Requirement: 有界批准恢复与不可变上下文策略

系统 SHALL 使用冻结的 per-Run policy 和完整 snapshot2 引用重建有界 start；只恢复显式有效批准等待点，不扩大旧 Run 权限。见 `docs/design/18-r2a-harness-context.md` §3、§6、§8。

#### Scenario: 批准后大观察恢复（D6/D8）

- **WHEN** 用户批准后显式继续，原全量观察聚合超过 1MiB
- **THEN** 先核当前决议/权限，再用全部引用的有界视图启动唯一新 attempt，不先拼超限全文、不重跑 MCP；拒绝/未知与原 apply 身份仍不绕过

#### Scenario: 旧 Run 及策略并发（D8/D9）

- **WHEN** 旧有效等待点在新执行器恢复，或部署策略后来变化/并发恢复
- **THEN** 原冻结输入/预算/allowlist 不变，策略最多补入一次且同恢复事务原子；无新增回取资格时保留唯一正文，放不下明确失败，不自动扩权

#### Scenario: 只读与取消（D1/D8/D9）

- **WHEN** GET/同入站键补读，或旧 pipe/取消后提交内部源查询、测量后的模型请求
- **THEN** 只读不创建策略或 attempt，不执行；旧或取消资格拒绝新读取/动作，不披露被撤权内容，不覆盖既成事实

### Requirement: 目标结果独立于执行终结

系统 SHALL 按 [design/20 §6.3](../../../docs/design/20-goal-scoped-delegation.md#63-目标结果不是-run-done) 通过同Harness结构化控制出口保存GoalResult，分别表达completed/partial/blocked/cancelled/unknown及逐项收据；TS验证真实归属/领域状态，不以Run done、tool completed或正文证明目标完成。

#### Scenario: 全部或部分目标（A1/D8/D10）

- WHEN 文件已verified但提醒缺日期，或全部要求均有真实相应证据
- THEN 前者partial且只问日期，后者可completed；created只能说已创建，不能说已排期/通知送达；纯回答可无副作用

#### Scenario: 缺口和unknown（A3/D8/D10）

- WHEN 没有达成项目而缺信息，或任一要求效果unknown
- THEN 前者blocked，后者unknown并停止Run；逐项保留其他已知事实，不用partial/成功覆盖未知，也不以当前相同文件补成功

#### Scenario: 原子结果与证明限度（D4/D8/D10）

- WHEN 接受最终结构化结果、消息及Run/attempt终结
- THEN 同事务保存唯一终态及版本化投影；虚假/跨owner收据被拒，预算/失败也保留真实成果；TS不宣称能证明模型没遗漏任意自然语言目标

#### Scenario: 创建撞名的目标恢复（D8/D10）

- WHEN 目标结果声明零写撞名由后续别名创建及独立新读完成
- THEN 校验真实用户消息来源和同 Run 的冲突、冻结目标、调用先后及完整回读；声明只是模型对目标的语义解释，不因原文或 ID 可核验就声称语义授权得到独立证明
- AND 缺少声明时不得按同内容推断，旧 Run 不因部署新增恢复能力而改变冻结语义

### Requirement: 有界接续而非目标执行引擎

系统 SHALL 复用conversations可信前序关系和每Run预算，不新增输入长等待、suspended_input、snapshot3、目标表/执行器或模型发号持久去重。见 [design/20 §5–§6](../../../docs/design/20-goal-scoped-delegation.md)。

#### Scenario: 用户补实际缺口（D6/D8）

- WHEN 当前执行以blocked/partial结束后用户明确补充唯一可信缺口
- THEN 新Run带来源与既成收据仅做未完成项，新Run有独立预算；不重批目标、不重做已完成项，旧上下文不变

#### Scenario: 预算与批准恢复（D8/D9）

- WHEN 同Run批准恢复或迭代/usage预算已耗尽
- THEN 累计不重置且停止后续动作，系统不得自建Run绕预算；不承诺跨目标总费用硬上限，未知usage不伪零

### Requirement: 冻结阶段能力与执行生命周期

系统 SHALL 按 [design/20 §1、§4、§8](../../../docs/design/20-goal-scoped-delegation.md) 独立冻结授权修订、真实阶段能力和两种具体执行生命周期；delegation/1不等于后台已交付。可信start与只读Run/Web使用同一事实，不建通用profile平台，最终订阅解耦验收不缩小。

#### Scenario: 偏好先交付但后台未交付（D6/D8/D10）

- WHEN 本人偏好保存已交付而后台、elapsed或文件创建尚未交付，新Run按delegation/1接纳
- THEN 可自主真实保存偏好，冻结并显示request-bound及断连取消限制；不宣称离开/退出后继续，不编造elapsed修订、创建工具或输出资格，已接受偏好不回滚或自动重做

#### Scenario: 后台完成后的新接纳（D6/D8/D9）

- WHEN 服务端唯一执行占有及失联收尾已完成验收后接纳相应新Run
- THEN 才冻结并显示server-owned，刷新/离开仅断订阅且执行在原预算/超时内继续；其他未交付能力仍不可用，不以授权修订暗示全部能力已上线

#### Scenario: 先前运行不随部署改义（D2/D6/D8）

- WHEN server-owned或其他能力部署后读取/批准恢复legacy或早期request-bound Run
- THEN 保留各自冻结连接语义和能力，不依当前开关重新解释或回填历史，不将断连取消偷换成后台继续；重连只读，不重做既成效果

### Requirement: 新委托的服务端执行所有权

冻结server-owned的Run SHALL 按 [design/20 §8](../../../docs/design/20-goal-scoped-delegation.md#8-连接停止退出与服务端所有权) 由服务端同一Harness driver持有有界执行，PG session独占与attempt资格绑定；SSE只订阅。request-bound阶段不承诺后台继续，最终server-owned要求不能仅删abort回调交付，不承诺崩溃自动恢复。

#### Scenario: 刷新离开断网（D6/D8/D9）

- WHEN 已冻结server-owned的新Run接纳后页面离开/刷新/断网
- THEN 执行在原预算/超时内继续，重连只GET持久状态，不补发消息/恢复/工具；legacy及早期request-bound仍原连接合同

#### Scenario: 所有权失联或进程崩溃（A3/D8/D9）

- WHEN server-owned的独占连接失联或执行宿主崩溃
- THEN 失去资格后禁止新预约/许可/终结推进并abort，取得同锁的收尾者复验后只终结中断，不自动重放；在途效果如实已知/unknown，不永久假报running

#### Scenario: 停止退出与禁用不同（D6/D8/D9）

- WHEN server-owned Run显式停止、退出登录/到期或账户禁用
- THEN 停止持久撤销Run后续资格，退出只撤会话访问不撤该委托，禁用阻止新动作；request-bound仍按冻结连接策略收尾，都不谎称回滚任务或文件

### Requirement: profile与协议前向迁移不扩历史权限

系统 SHALL 按 [design/20 §1、§9](../../../docs/design/20-goal-scoped-delegation.md) 仅新接纳profile获得新权能，v6与TS/native/Web配套，旧事件可读、snapshot2继续、历史不可变；发布只前向迁移，不向新调用方留旧工具别名。

#### Scenario: 严格旧native与新消费者（D6/D8）

- WHEN v5旧二进制遇v6，或新start/GoalResult传给配套消费者
- THEN 旧者硬拒绝不暗收未知字段，新者按显式版本消费；外部新结果SSE v2，旧v1仍可读，不静默改shape

#### Scenario: 旧有效等待（D2/D6/D8）

- WHEN 新执行器受限适配可恢复旧批准等待或读取旧snapshot/pending/接受结果
- THEN 只沿原profile/allowlist/grant/预算/模板/hash/决议，历史不迁写/自动消费/扩权；snapshot1仍限原旧引用，不能安全适配须发布前续完或明确停止

#### Scenario: 期限与回退（D4/D7/D8）

- WHEN 发布清点旧等待或新授权/UTC/直接来源事实已产生后发生版本失败
- THEN 文档批准不按任务统一24h假称过期；停旧写者后前向迁移配套发布，新事实不交不理解它的旧写者，关闭新入站保留事实并前向修复

### Requirement: 仓颉生产宿主拥有入口与运行编排

生产部署 SHALL 由仓颉接收 HTTP/SSE 请求、编排 Run 生命周期并驱动 Worker；用现有公开合同及已核验的 PostgreSQL 事实决定对外事件和副作用。见 design/08 §2–9、design/09 §1–8、design/10 §1–6。

#### Scenario: 聊天提醒经真实入口完成

- **WHEN** 用户通过生产 HTTP/SSE 入口请求一个具备执行资格的到点提醒
- **THEN** 仓颉 SHALL 接收请求并编排 Run，仓颉 Worker SHALL 推进到点投递，最终状态 SHALL 由独立回执支撑

#### Scenario: SSE 断开后的行为与补读

- **WHEN** 用户断开流连接后使用既有游标重新连接
- **THEN** 请求绑定和服务端所有权的 Run SHALL 各自保留其既有取消与继续语义，并按公开游标返回可披露事件

### Requirement: 服务交接保留持久执行权与回执

升级、重启和回滚 SHALL 保留已验证的授权、排空、恢复和唯一写入权限语义，继续使用 PostgreSQL 已提交的事务事实。见 design/08 §2、§7–9、design/09 §4–6 和 design/15。

#### Scenario: Worker 重启遇到已经投递的任务

- **WHEN** 旧 Worker 退出，新 Worker 处理具有投递回执的任务
- **THEN** 新 Worker SHALL 按现有回执推进状态，旧执行权 SHALL 无法重复提交该效果

#### Scenario: 历史 Run 在切换后继续

- **WHEN** 支持范围内的旧 Run 在服务切换后从合法等待点继续
- **THEN** 服务 SHALL 核验原执行权、资格和回执，恢复原目标、预算和协议语义，保持以前接受的效果
