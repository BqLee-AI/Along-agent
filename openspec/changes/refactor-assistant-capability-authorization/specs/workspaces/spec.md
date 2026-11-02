## MODIFIED Requirements

### Requirement: 可信工作区选择与有限文件授权

系统 SHALL 由服务端登记并冻结本人资源资格；legacy继续用户显式单选，delegation profile按 [design/20 §7](../../../../../docs/design/20-goal-scoped-delegation.md#7-工作区资格有限创建与精确写入) 冻结可用集合或用户明确收窄子集，模型在其中自主选择。不因缺少手动“资料模式”阻断合法委托，不接受模型自报root/owner。

#### Scenario: 自主选择和真实歧义（D1/D8）

- WHEN 新委托的资料对象在冻结集合内唯一，或有两个确实合理的位置
- THEN 前者可检索执行不先问工具/登记，后者只问位置缺口；不默选首项，legacy选择及历史刷新不变

#### Scenario: 越界与链接（D1/D6/D8）

- WHEN 请求登记外路径/owner，或symlink/硬链接/目录身份替换破坏边界
- THEN 拒绝读取/写入，不披露范围外字节，不因前缀相同或确认按钮放行

#### Scenario: 登记变化与容量（D8/D9/D10）

- WHEN 登记撤销/digest或root变化、新登记加入，或集合不能在预算内完整表达
- THEN 原Run不静默扩权，新动作重验当前资格；超界明确限制不悄悄截成权限事实，原接受事实按历史资格读取

#### Scenario: 重叠登记（D1/D8）

- WHEN 不同登记指向同root或祖先/后代
- THEN 冲突登记不启用，不借两个workspace锁覆盖同一目标；无工作区业务仍可用

### Requirement: 文档批准绑定精确基线与完整目标

文档修改 SHALL 绑定本Run真实完整读取、精确基线及完整目标。legacy和新增影响仍需精确冻结审阅；新profile新增影响按 [design/20 §3](../../../../../docs/design/20-goal-scoped-delegation.md#3-自主澄清授权升级与硬拒绝) 允许一次明确授权并继续，不机械追加继续按钮，决议自身零文件写。正常步骤直接绑定invocation，不创建自动批准；用户明确整篇重写不再次索权，效果边界见design/20 §7。

#### Scenario: 正常精确修改或明确重写（D2/D6/D8）

- WHEN 新profile收到登记内明确编辑/整篇重写且对象/影响唯一
- THEN 编译并绑定全文基线和确切目标直接执行，不逐文件批准；局部编辑保留无关字节，全文重写只改变获委托内容

#### Scenario: legacy预览和新增影响（D6/D8/D10）

- WHEN 旧profile提出修改，或新动作需要未获委托的破坏性影响
- THEN 只授完整冻结的精确动作；legacy沿原显式继续合同，新profile可一次授权并继续且仍验当前Run/等待点/停止/预算和冻结资源；决议本身不是写入/保存，拒绝不能同义重提绕过，unknown/迟到失效不推进

#### Scenario: 错误引用或目标（D1/D8）

- WHEN 基线非全文/不属本Run、唯一替换无匹配/多匹配，或预览hash不符
- THEN 不写入，不自动replace-all/rebase或改原批准；直接路径不因免按钮取消对象/版本绑定

### Requirement: 版本冲突与无关内容保留

实际编辑 SHALL 验证当前基线版本并只写冻结目标字节；冲突需真实零写证据，不能以unknown/未尝试替代。legacy变更目标仍需新批准；新委托内已确定零写冲突可自主新读重算。见 [design/20 §7](../../../../../docs/design/20-goal-scoped-delegation.md#7-工作区资格有限创建与精确写入)。

#### Scenario: 可信零写冲突自主修正（D6/D8）

- WHEN 新profile编辑因当前版本不同已接受零写conflict
- THEN 可在原目标内新读、编译并绑定新调用，不沿旧精确许可写新版本；legacy新目标仍须新批准，原冲突事实保留

#### Scenario: 精确字节和真实回读（D2/D8/D10）

- WHEN 编辑在合法版本成功
- THEN 字节等于冻结目标，局部未修改BOM/换行/空格不变；后续真实新读取核对，不回显参数冒充结果

#### Scenario: 未知与拒绝不能作后继（D8/D9/D10）

- WHEN 原动作unknown/未尝试/被拒，或后继仍pending/未执行
- THEN 不借冲突修正绕过、不报告完成；只有真实写入及独立新回读成功才可验证相应产物

### Requirement: 非事务写入唯一许可与诚实未知

文件效果 SHALL 复用稳定invocation、动作前持久unknown与一次许可；直接写入绑定精确目标/版本，批准路径同批准只绑定一个apply。仅明确取得许可提交回答的当前执行栈执行。见 [design/20 §7](../../../../../docs/design/20-goal-scoped-delegation.md#7-工作区资格有限创建与精确写入) 及tool-gateway未知合同。

#### Scenario: 重交与许可丢回答（A3/D3/D8）

- WHEN 原调用重交、同批准换新apply、许可已提交但执行栈未确认或进程终止
- THEN 原引用只重放结果/unknown，新重复apply拒绝；即使实际可能零写也不盲执行，不换slot绕过

#### Scenario: 已写但接受结果丢失（A3/D8/D10）

- WHEN 文件可能已改变而没有绑定的已接受成功，当前内容恰好等于目标
- THEN 保持unknown，不重写、不补造原调用成功；可报告当前内容事实但不等于原动作verified

#### Scenario: 确定写前失败（D8）

- WHEN 可信执行器证明写前冲突或失败
- THEN 接受明确零效果观察，实际字节不变；原调用重交不重新执行，正常冲突修正仍需新的完整绑定

## ADDED Requirements

### Requirement: 有限输出目录内真实创建

系统 SHALL 仅在冻结登记输出目录内创建普通文件，沿 [design/20 §7](../../../../../docs/design/20-goal-scoped-delegation.md#7-工作区资格有限创建与精确写入) 提供真实原子no-replace发布、目录/链接资格及一次许可；不开放任意mkdir/move/delete或覆盖降级。

#### Scenario: 创建产物与新回读（D6/D8/D10）

- WHEN 用户委托生成并保存简报且输出目录/对象明确
- THEN 模型可自主生成创建，不逐动作批准；真实文件写入接受后独立新全文read相符才verified，产物不是briefs/cards新表

#### Scenario: 撞名不覆盖（D3/D8）

- WHEN 创建目标已存在或并发其他创建抢先
- THEN 零覆盖；未固定文件名可选不覆盖别名并报告，固定名涉及未授权无关内容才问新增影响，明确授权覆盖也不能伪装成no-replace创建

#### Scenario: 发布前提不满足（D1/D8/D10）

- WHEN 目标在登记外、目录/链接身份不符或文件系统不支持真实排他发布
- THEN 不写范围外/已有内容并准确报不可用，不以普通覆盖rename充当创建；不宣称PG锁是OS级沙箱
