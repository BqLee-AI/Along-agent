## MODIFIED Requirements

### Requirement: 本地批准与接受结果原子提交

网关 SHALL 将本地领域效果、首次接受结果和审计同一事务提交；legacy批准仍适用原创建/确认边界，新profile直接设置/建任务/取消通过所属模块公共事务而非假批准。见 [design/20 §6](../../../../../../docs/design/20-goal-scoped-delegation.md#6-领域提交稳定调用与真实结果)。

#### Scenario: 直接创建的原子性（A1/A2/D4/D8）

- WHEN task、created、outbox、结果或审计任一步失败
- THEN 整个本地事务回滚，无脱节任务/事件/命令/接受结果；预约可按原稳定身份恢复，不另造批准或调用

#### Scenario: 批准和明确回滚失败（A2/D4/D8）

- WHEN legacy本地批准插入后结果/审计失败，或工具错误已证实事务回滚
- THEN 前者全回滚；后者只在失败结果/审计能够提交时接受真实失败，不宣称未持久化失败已有接受结果

#### Scenario: 提交回答丢失（A2/D3/D8）

- WHEN 本地COMMIT回答丢失后同引用跨连接重交
- THEN 已接受则回原结果，未提交则无该事务效果并沿原引用处理，不新建task/第二批准；同键异参仍冲突

### Requirement: 实际使用路径与既有安全保证保持

实现 SHALL 经真实身份、HTTP、native、PG和文件边界证明所属事实及结果；新profile的正常执行不以legacy五工具输出为永久上限，legacy仍保持原合同。设计见 [design/20 §6、§9–§10](../../../../../../docs/design/20-goal-scoped-delegation.md)，不保留绕网关的旧签名或对新调用方的旧工具别名。

#### Scenario: 新直接与旧批准消费者（D1/D8/D10）

- WHEN 正式新委托直接创建/取消，或legacy从批准等待恢复
- THEN 各按冻结profile执行同一领域不变量；新路径真实直接用例，旧路径按钮/hash/决议不变，不扩大旧权能

#### Scenario: 重放与GET（D6/D8）

- WHEN 同入站键重放或GET补读事件
- THEN 保留原running冲突/已存重放规则，零新调用/attempt/批准/业务效果；重连不补发POST

#### Scenario: 正式效果与传输失败（D4/D8/D10）

- WHEN 实际TS MCP/文件和PG参与执行后结果已接受但流或checkpoint失败
- THEN 保留原事实且不重做，缺失真实效果证据不能靠HTTP200、模型正文或历史报告补足

### Requirement: 同 Run 原接受观察的受控回取

系统 SHALL 沿同一网关回取有界原接受事实；本Run来源与经 [design/20 §5](../../../../../../docs/design/20-goal-scoped-delegation.md#5-澄清与接续复用可信跨-run-来源) 接纳的可信前序收据分开核验。扩充接续不开放任意跨Run读取；旧Run不新增回取权限，回取不重执行原操作。单位/分页继续 design/18 §6–§7。

#### Scenario: 原来源与新读取不同（D2/D8/D10）

- WHEN 当前文件已变化但请求回取已接受来源
- THEN 返回原版本/页/完整性，不调用MCP；context_slice不能作完整写基线或写后新回读

#### Scenario: 来源拒绝与接续（D1/D6/D8/D9）

- WHEN 来源属于他人、任意其他Run、未接受结果、旧attempt/撤权/取消，或为接纳时明确核验的前序事实
- THEN 前者拒绝不泄漏；后者仅按冻结引用用于未完成项，不回写原接受结果、不冒充新执行

#### Scenario: 新调用和不可递归（D8/D9）

- WHEN 模型分页回取、重放同引用或试图再切context_slice
- THEN 新读取计入原调用/上下文预算、重放原页，拒绝递归来源；不得生成免费调用链

## ADDED Requirements

### Requirement: 能力资格与语义委托各有来源

网关 SHALL 按 [design/20 §2–§4、§7](../../../../../../docs/design/20-goal-scoped-delegation.md) 使用单一工具目录及真实执行分类，核验身份/profile/当前attempt、停止、引用、资源/时间/版本/效果；不能将工具可见性或资料正文当本次授权，也不把确定性关联当语义证明。

#### Scenario: 正常自主执行（D6/D8）

- WHEN 委托内设置/提醒/文件动作的事实和资格完整
- THEN 不因risk、写操作或步骤数量生成逐项审批；模型选择顺序，TS只执行真实用例，不新增隐藏Agent或语义关键词分诊

#### Scenario: 欠缺与新影响（D6/D8/D10）

- WHEN 缺目标指代/时间/目的位置，或拟新增未授权影响
- THEN 只澄清实际缺口或请求该新增授权；跨owner/登记外/不存在能力硬拒绝，不用确认放行

#### Scenario: 多提醒补缺保留各自动作时间（A1/D8）

- WHEN 同一可信请求有两个不同的未来日期/时刻，实际缺时区并接纳前序缺口，用户只补时区后模型分别选择两项时间
- THEN 每次调用保留该动作选定且可核验的日期/时刻，只从可信补充填缺失事实；不得用整段多事项原文的首个时间覆盖其他动作。两个任务各有正确冻结时间、来源调用、created、outbox和接受回执，不要求完整重述或逐项批准；来源资格、原锚、午夜及fold规则仍生效

### Requirement: 既有调用幂等不冒充语义去重

系统 SHALL 按 [design/20 §6.2](../../../../../../docs/design/20-goal-scoped-delegation.md#62-去重承诺的边界) 复用入站键、稳定调用与不可变接受结果；不新增模型item_key/effect_key/supersedes持久层，不按hash合并独立目标，不承诺语义exactly-once。

#### Scenario: 合法相同新动作（A2/D3/D8）

- WHEN 用户明确新发同样请求或要求两条相同提醒
- THEN 不因参数相同吞掉合法新动作；同一入站键/调用引用重放仍不能重复效果

#### Scenario: 未知与已完成接续（A3/D8/D9）

- WHEN 原效果unknown或用户补缺口时已有真实完成收据
- THEN unknown停止且不换slot/Run重发；接续只做未完成部分，语义误判为新动作的残余风险仍需真实模型评估
