## MODIFIED Requirements

### Requirement: 单一生命周期与取消裁决

TS SHALL 原子保存真实资格、运行/attempt/消息及事件投影，仓颉独占下一步选择。按 [design/20 §6.3、§8](../../../../../docs/design/20-goal-scoped-delegation.md) 区分停止执行、领域取消和目标结果；停止先持久撤销后续资格，不伪撤销既成效果。

#### Scenario: 停止先提交（D8/D9）

- WHEN 显式停止Run先提交，旧进程再预约/调用/挂起/回答/成功终结
- THEN 新动作与迟到推进拒绝，只有一个终态；native/transport被收回，不因换引用或新Run继续

#### Scenario: 效果先于停止（D4/D8/D10）

- WHEN 本地结果已提交或在途非事务效果可能发生后停止
- THEN 保留已发生/unknown，Run停止不等于任务取消/文件回滚；取消已建task须独立明确目标并走原回执门

#### Scenario: 并发终结与传输失败（D4/D8）

- WHEN finish/suspend/stop竞争或传输在接受效果前后失败
- THEN 唯一合法状态和消息/事件原子提交，不留下半终态，不重做原已接受工具

### Requirement: 复用工具事实与所属模块业务规则

工具 SHALL 沿稳定调用、原接受结果、当前资格和unknown规则，通过所属模块公共用例/只读投影执行；新profile不再强制所有领域写入经批准，但时间、事务和回执不变量保留。见 [design/20 §2、§6](../../../../../docs/design/20-goal-scoped-delegation.md)。

#### Scenario: 同调用及未知（A3/D8/D9）

- WHEN 同调用在新attempt重交或非事务效果未知
- THEN 回原接受事实，unknown停止不盲重发，不按参数/attempt重造动作或伪成功

#### Scenario: 新旧路径共享领域保证（A1/A2/D1/D4/D5/D9）

- WHEN 新委托直接创建/取消，或legacy批准恢复
- THEN tasks公共用例保持task/created/outbox原子、纯时间/typed错误、append-only、取消优先和真实回执；legacy仍验证冻结批准，新路径不造批准

## ADDED Requirements

### Requirement: 目标结果独立于执行终结

系统 SHALL 按 [design/20 §6.3](../../../../../docs/design/20-goal-scoped-delegation.md#63-目标结果不是-run-done) 通过同Harness结构化控制出口保存GoalResult，分别表达completed/partial/blocked/cancelled/unknown及逐项收据；TS验证真实归属/领域状态，不以Run done、tool completed或正文证明目标完成。

#### Scenario: 全部或部分目标（A1/D8/D10）

- WHEN 文件已verified但提醒缺日期，或全部要求均有真实相应证据
- THEN 前者partial且只问日期，后者可completed；created只能说已创建，不能说已排期/通知送达；纯回答可无副作用

#### Scenario: 缺口和unknown（A3/D8/D10）

- WHEN 没有达成项目而缺信息，或任一要求效果unknown
- THEN 前者blocked，后者unknown并停止Run；逐项保留其他已知事实，不用partial/成功覆盖未知，也不以当前相同文件补成功

#### Scenario: 原子结果与证明限度（D4/D8/D10）

- WHEN 接受最终结构化结果、消息及Run/attempt终结
- THEN 同事务保存唯一终态及版本化投影；虚假/跨owner收据被拒，预算/失败也保留真实成果；TS不宣称能证明模型没遗漏任意自然语言目标

### Requirement: 有界接续而非目标执行引擎

系统 SHALL 复用conversations可信前序关系和每Run预算，不新增输入长等待、suspended_input、snapshot3、目标表/执行器或模型发号持久去重。见 [design/20 §5–§6](../../../../../docs/design/20-goal-scoped-delegation.md)。

#### Scenario: 用户补实际缺口（D6/D8）

- WHEN 当前执行以blocked/partial结束后用户明确补充唯一可信缺口
- THEN 新Run带来源与既成收据仅做未完成项，新Run有独立预算；不重批目标、不重做已完成项，旧上下文不变

#### Scenario: 预算与批准恢复（D8/D9）

- WHEN 同Run批准恢复或迭代/usage预算已耗尽
- THEN 累计不重置且停止后续动作，系统不得自建Run绕预算；不承诺跨目标总费用硬上限，未知usage不伪零

### Requirement: 新委托的服务端执行所有权

delegation profile SHALL 按 [design/20 §8](../../../../../docs/design/20-goal-scoped-delegation.md#8-连接停止退出与服务端所有权) 由服务端同一Harness driver持有有界执行，PG session独占与attempt资格绑定；SSE只订阅。不能仅删abort回调就宣称后台继续，不承诺崩溃自动恢复。

#### Scenario: 刷新离开断网（D6/D8/D9）

- WHEN 新委托已接纳后页面离开/刷新/断网
- THEN 执行在原预算/超时内继续，重连只GET持久状态，不补发消息/恢复/工具；legacy仍原连接合同

#### Scenario: 所有权失联或进程崩溃（A3/D8/D9）

- WHEN 独占连接失联或执行宿主崩溃
- THEN 失去资格后禁止新预约/许可/终结推进并abort，取得同锁的收尾者复验后只终结中断，不自动重放；在途效果如实已知/unknown，不永久假报running

#### Scenario: 停止退出与禁用不同（D6/D8/D9）

- WHEN 显式停止、退出登录/到期或账户禁用
- THEN 停止持久撤销Run后续资格，退出只撤会话访问不撤新委托，禁用阻止新动作；都不谎称回滚任务或文件

### Requirement: profile与协议前向迁移不扩历史权限

系统 SHALL 按 [design/20 §1、§9](../../../../../docs/design/20-goal-scoped-delegation.md) 仅新接纳profile获得新权能，v6与TS/native/Web配套，旧事件可读、snapshot2继续、历史不可变；发布只前向迁移，不向新调用方留旧工具别名。

#### Scenario: 严格旧native与新消费者（D6/D8）

- WHEN v5旧二进制遇v6，或新start/GoalResult传给配套消费者
- THEN 旧者硬拒绝不暗收未知字段，新者按显式版本消费；外部新结果SSE v2，旧v1仍可读，不静默改shape

#### Scenario: 旧有效等待（D2/D6/D8）

- WHEN 新执行器受限适配可恢复旧批准等待或读取旧snapshot/pending/接受结果
- THEN 只沿原profile/allowlist/grant/预算/模板/hash/决议，历史不迁写/自动消费/扩权；snapshot1仍限原旧引用，不能安全适配须发布前续完或明确停止

#### Scenario: 期限与回退（D4/D7/D8）

- WHEN 发布清点旧等待或新授权/UTC/直接来源事实已产生后发生版本失败
- THEN 文档批准不按任务统一24h假称过期；停旧写者后前向迁移配套发布，新事实不交不理解它的旧写者，关闭新入站保留事实并前向修复
