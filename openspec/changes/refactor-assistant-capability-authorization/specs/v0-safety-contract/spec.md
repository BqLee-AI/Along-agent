## MODIFIED Requirements

### Requirement 1: 错误码 HTTP 唯一

系统 SHALL 保持 design/10 §6 与 API §5 的 HTTP/业务码；legacy 继续原预检和时间失败合同。新 delegation profile 按 [design/20 §4](../../../../../docs/design/20-goal-scoped-delegation.md#4-可信执行上下文和时间) 区分所需时间分支：wall 规则不可用仍 typed 503，纯 UTC elapsed 不伪造 TZDB、不因不需要的时区字段失败；readyz 如实反映原规则故障，不改成健康。

#### Scenario: 回显不符与既有错误码（A2/D8）

- WHEN legacy confirm 的所见/hash 不匹配或批准过期/已替代
- THEN 保留原409/410及符号码，不建task，不因新profile绕过原批准

#### Scenario: 墙上时间错误（A4/D8/D10）

- WHEN 实际wall归一为不存在、重复未选或未知时区
- THEN 分别返回原typed422与结构化候选，不创建该动作的task/approval；已开流保持唯一失败投影，不把错误说成completed目标

#### Scenario: UTC独立与readyz真实（A4/D7/D8）

- WHEN wall规则不可用但严格UTC elapsed所需纯计算与DB可用
- THEN wall动作准确503、readyz仍非就绪；新elapsed可独立校验提交，不填假版本、不绕认证/幂等或未来时刻门

### Requirement 4: confirm 单事务与按钮确认

系统 SHALL 对 legacy 与有效精确批准保持原按钮、owner/pending/时限/hash 校验和 confirm 单事务；对新 delegation profile 的已明确委托正常步骤直接调用领域用例，不模拟批准。所有创建路径保持 task/created/outbox 原子提交，直接工具路径还与 accepted result/审计原子提交。新/旧授权作用域见 [design/20 §1、§3、§6](../../../../../docs/design/20-goal-scoped-delegation.md)。

#### Scenario: legacy并发双击（A2/D3）

- WHEN 同一旧approval并发confirm两次
- THEN 仅一个task/created/outbox，返回同一task；hash不符/过期/替代仍零创建

#### Scenario: 直接明确创建及回滚（A1/A2/D4/D8）

- WHEN 新profile收到完整唯一的本人提醒委托，或本地结果/审计提交失败
- THEN 正常路径无需第二次按钮，真实任务/事件/outbox与接受结果同事务；失败全回滚，不制造pending或consumed批准

#### Scenario: 明确取消与新增影响（D6/D8/D9）

- WHEN 用户明确要求取消唯一目标、重写唯一资料，或模型拟新增未授权影响
- THEN 前者不就同一授权再问；后者只请求新增部分授权，跨owner/登记外仍不能按钮放行；取消复用原公共事务及回执门

### Requirement 6: 简报只读投影

系统 SHALL 保持 GET /brief 为 tasks/approvals 的只读投影、冻结显示和已记录步骤口径，不建 briefs/cards 表；新 UTC/跨冻结时区提醒按 [design/20 §4.3、§6](../../../../../docs/design/20-goal-scoped-delegation.md) 同步今日查询。生成并保存的简报文件属于 workspace，不是该投影持久表。

#### Scenario: 点卡与浏览无副作用（A1/D6/D8）

- WHEN 点击简报卡、刷新或读取历史
- THEN 不创建task/调用模型/消费pending；legacy仍须原确认，新profile也只有明确新委托才执行

#### Scenario: 冻结展示不改（D2/D10）

- WHEN 当前偏好、规则或展示环境变化而原冻结对象不变
- THEN 展示仍取各自冻结版本/字段，不在前端重算历史

#### Scenario: UTC今日投影（D2/D8）

- WHEN 浏览日区间内存在UTC elapsed和其他冻结时区任务
- THEN 服务端以明确浏览时区计算UTC半开日区间按fire_at查询，不以冻结时区相等漏项；无偏好明示UTC，查询仍零业务写入

### Requirement: A4 typed时间失败与唯一流终结

系统 SHALL 保持普通缺信息与已判定 typed 时间错误分离；legacy 沿原零承诺写失败，新 delegation profile 按 [design/20 §4、§6.3](../../../../../docs/design/20-goal-scoped-delegation.md) 保留逐动作真实效果和唯一 Run 终结，不因后续时间失败抹掉先前已接受效果。

#### Scenario: 不存在与歧义（A4/D8）

- WHEN 健康wall规则返回gap或未选fold
- THEN 唯一失败投影保留422及服务端候选；该动作无新承诺写入，不能以解释性正文冒充成功

#### Scenario: 真正缺口与纯时长（A4/D1/D10）

- WHEN wall缺关键年份/时区/时段或表达模糊，或新profile收到明确三分钟后
- THEN 前者只问实际缺口；后者用可信UTC锚加180秒，不问无关时区/上午下午，不允许模型提交定案UTC

#### Scenario: 多步时间错误（D4/D8/D10）

- WHEN 时区已真实保存后另一提醒因时间错误未创建
- THEN 保留设置回执与提醒失败，目标不是全部完成，不回滚/重做已完成设置；legacy单动作零承诺写入保证不弱化

### Requirement: A4应用上下文与预检零新run

系统 SHALL 由应用持有同一真实不可变规则/别名上下文供wall和readyz，time-core保持纯函数；legacy/business保持身份/输入/幂等之后、SSE之前的原规则预检和零新Run保证。新自然目标接纳冻结真实时间能力，不要求TS预先语义分类；实际wall工具缺规则时零该动作效果，严格elapsed才走独立真实UTC依据，不以猜测/未知类型绕过规则门。见 [design/20 §4.2](../../../../../docs/design/20-goal-scoped-delegation.md#42-严格-elapsed-与墙上时间)。

#### Scenario: wall坏包与安全优先（A4/D7/D8）

- WHEN legacy/business入口遇规则故障，或任一profile同时认证/CSRF/owner/幂等已失败
- THEN 前者在SSE/新Run前503且零承诺写；后者保留原401/403/资源或409优先，不泄漏资源；新自然目标不能用猜测的wall/elapsed预检冒充确定性语义裁判

#### Scenario: 流中发现依赖坏（A4/D8/D10）

- WHEN 已接纳混合目标后实际wall步骤才发现规则坏
- THEN 未创建该提醒并唯一终结真实结果，保留早先效果；不伪造规则或报全完成，重放只读原结果

#### Scenario: 规则故障不封闭既有事实（A4/D2/D9）

- WHEN DB可达但规则坏时读取/确认旧冻结批准、取消/执行旧任务或提交合格UTC elapsed
- THEN 不重归一旧对象，按原时限/资格/回执处理；elapsed按独立真实依据校验，readyz不假报健康

### Requirement: A4显式时区与Web候选重提议

系统 SHALL 保留 #103 的请求锚、可信同目标跨Run来源及真实午夜边界。legacy 继续原完整重提议/按钮与候选展示版本；新 profile 使用 [design/20 §4–§5](../../../../../docs/design/20-goal-scoped-delegation.md) 的实际缺口接续、时区优先级和可信候选；Web 不算UTC或把fold选择当额外批准。

#### Scenario: 显式时区与同委托设置（A4/D1/D8）

- WHEN 新profile明确本次时区或先保存本人时区再建提醒
- THEN 本次明确值优先，其后才是适用的刚接受设置回执及接纳偏好；未知显式时区typed失败不吞为默认值，只这次不写偏好，旧冻结不变

#### Scenario: 候选与legacy展示（A4/D2/D8）

- WHEN 用户从服务端fold候选选择first/second
- THEN 继承可信原锚与原日期/时区，TS独立归一；legacy新first仍用v2模板和hash、旧模板不换，仍按钮建task；新profile补足缺口即可创建，不再问同一授权

#### Scenario: 同日等待与真实午夜（A4/D8/D10）

- WHEN 同源补缺口仅同日等待120秒、真实跨本地午夜20秒，或独立新请求说从现在起
- THEN 同日不因锚龄重问，跨日相对日期只问具体日期不静默顺延；独立新委托用新锚，过窗未建，不改旧冻结值

#### Scenario: 来源不明与历史重放（D6/D8/D9）

- WHEN 多候选/无关中间目标/无可信来源，或补读与批准恢复发生在午夜后
- THEN 不从模型/最新任意Run拼日期，先问实质关系缺口；重放/旧恢复仍原事实与授权，零重复效果，不迁写旧Run

## ADDED Requirements

### Requirement: 新委托授权策略与资料事实边界

新 delegation profile SHALL 按 [design/20 §1–§3](../../../../../docs/design/20-goal-scoped-delegation.md) 在本人委托内自主选择正常步骤；模型解释语义，TS验证确定性事实。v0的“只提议/全部写入按钮”仅适用legacy，其他owner、纯时间、原子、只追加、取消、回执和未知不重做不变量继续适用。

#### Scenario: 混合目标零机械审批（A1/D8/D10）

- WHEN 用户委托整理多份受管资料、保存简报并为明确截止项建立提醒
- THEN 助理可自行检索/保存/创建/核实并逐项报告，不因写入/数量/步骤多逐项索权；结果需真实文件及任务证据

#### Scenario: 只摘要不执行注入（D6/D8）

- WHEN 用户只让摘要，资料要求改时区或取消任务
- THEN 只提供摘要，不执行额外目标；资料、消息ID/hash或第二模型yes不能授予新权限

#### Scenario: 按资料建立提醒（A1/D6/D8）

- WHEN 用户明确让按资料事项建立提醒且事实、目标和资格完整
- THEN 可使用外部事实在原委托内直接创建，不以第三方来源一概拒绝；无关嵌入指令不执行，冲突只问缺口

#### Scenario: 硬边界和语义残余（D1/D6/D8）

- WHEN 模型误解委托或提出跨owner/登记外/缺能力动作
- THEN TS拒绝确定性越界，不能用确认突破；合同明示模型语义误判仍可能，真实正反例评估不宣称任意自然语言授权可被确定证明
