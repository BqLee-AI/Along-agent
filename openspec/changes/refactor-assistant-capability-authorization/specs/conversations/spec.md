## MODIFIED Requirements

### Requirement: 面向用户目标的确定入口

系统 SHALL 默认提供真实Agent对话；新delegation profile按 [design/20 §3、§7](../../../../../docs/design/20-goal-scoped-delegation.md) 在冻结资源集合内自主选择，不让手动资料模式/工具选择成为合法目标前置。legacy快捷入口、显式单登记及不可用失败仍保持原合同，选择本身不执行。

#### Scenario: 新目标与旧入口（D6/D8）

- WHEN 新profile用户直接发送明确资料或混合目标，或legacy用户选提醒/资料快捷入口
- THEN 新目标无需先选工具/登记；legacy仍按原business/harness和显式登记执行，切换入口不改历史Run、不自动续办

#### Scenario: 没能力和真正多义（D1/D8/D10）

- WHEN 没有可用登记/依赖不可用/当前资格拒绝，或有多个合理目的位置
- THEN 准确说明不可用或只问位置，不假报空资料、默选第一项、切换执行器或接收任意宿主root

### Requirement: 精确批准与显式继续原运行

系统 SHALL 对legacy保留原精确审阅/决议及显式同Run继续合同；新profile正常编辑/创建不逐项批准，真实新增影响则允许一次范围精确的“授权并继续”用户动作，不机械要求第二次继续。授权决议自身仍零领域/文件写入，不等于保存，后续执行仍走原Run/等待点及当前资格。见 [design/20 §3、§7](../../../../../docs/design/20-goal-scoped-delegation.md)，不模拟批准或消费历史pending，不预设HTTP请求数量。

#### Scenario: 正常写入不是批准队列（D6/D8/D10）

- WHEN 新委托内资料正常编辑、明确重写或有限文件创建
- THEN 可直接执行并展示真实效果/回读，不制造自动approved记录、不因写入/多文件重复索权

#### Scenario: legacy精确审阅与原显式继续（D2/D6/D8）

- WHEN legacy文档需用户核对冻结预览并作原决议/继续动作，或只GET历史批准
- THEN 完整before/after、目标与preview.body/hash可读且不trim/重建；决议本身零文件写，仍按原Run显式继续合同，不因新profile自动消费旧pending或把approved当saved

#### Scenario: 拒绝停止未知与迟到（D8/D9/D10）

- WHEN 已拒绝/停止/终结、效果unknown、预算耗尽、失去资格或等待点未有效时收到早到/迟到授权
- THEN 不推进或复活Run、不新建工具调用、不排队稍后自动恢复；只读实际决议/不可继续原因，GET/导航/重登不触发授权或继续，不用新引用绕过

#### Scenario: 新增影响一次明确授权并继续（D2/D6/D8/D10）

- WHEN 新profile在当前有效等待点展示冻结的新增影响，用户一次明确选择授权并继续
- THEN 仅授该精确范围并显式续原Run，用户无需再点继续；可复用已有决议/继续请求，后续Harness/工具仍验稳定调用、当前资格、停止/预算和生命周期，不扩冻结资源，只有真实写入及新回读才报相应完成

### Requirement: 效果与运行状态依据可信事实

系统 SHALL 按 [design/20 §6.3](../../../../../docs/design/20-goal-scoped-delegation.md#63-目标结果不是-run-done) 分开呈现Run生命周期、目标结果和逐项真实效果。completed/partial/blocked/unknown与created/排期/取消中/文件applied/verified不可互换；不以模型措辞或前端旗标证明完成。

#### Scenario: 文件和任务事实分开（A1/D8/D10）

- WHEN 一个目标有已核实文件、仅created提醒或未完成日期缺口
- THEN 分别显示真实回执和缺口，created不说已排期/已提醒，applied不说verified；部分完成不因Run结束报全部完成

#### Scenario: 直接创建回执与真实DST候选（A4/D8/D10）

- WHEN 新委托已直接创建提醒，或保存了重复墙上时刻的规则错误并等待用户选择
- THEN 只读展示真实任务/接受回执；创建回执不证明当前已排期或尚未排期。DST候选来自实际接受的规则错误，沿相同原文、候选时区和显式前序关系提交first/second后直接创建，不伪造候选、不再批准；GET本身零创建

#### Scenario: 冲突与未知（A3/D8/D10）

- WHEN 文件有可信零写冲突或效果unknown
- THEN 新profile可按原委托修正零写，legacy仍新批准；unknown可能已生效且停止，不换身份重写、不凭当前相同内容补成功

#### Scenario: 停止和阶段不可确认（D9/D10）

- WHEN Run停止但先前可能已有效果，或没有可信阶段事实
- THEN 保留已知/unknown，不伪报回滚/取消任务；未知阶段不编造进度，连接关闭不冒充显式停止回执

### Requirement: 错误恢复不自动产生副作用

系统 SHALL 准确区分401/403/404/依赖/领域错误；历史、刷新、回退、重登和重连仍只读，不重放消息/批准/继续/取消。按 [design/20 §1、§8–§9](../../../../../docs/design/20-goal-scoped-delegation.md) 读取冻结授权及execution_lifecycle，不以delegation/1或当前部署推断后台能力，不用前端自动补POST实现后台能力。

#### Scenario: 真实401与其他错误（D6/D8/D10）

- WHEN 请求401、403、404、网络失败或503
- THEN 只有真实401走安全站内重登，其他保留真实原因；重登只GET，不称空集合/模型缺配置或补发原动作

#### Scenario: 响应丢失或断流（A3/D8/D9）

- WHEN 消息/继续/批准/取消响应丢失或SSE断开
- THEN 读取原持久状态，不换键/Run重做；仅server-owned执行不因断订阅撤销，legacy及早期request-bound仍原连接策略，已接受效果不回滚，unknown不盲重写

## ADDED Requirements

### Requirement: 冻结profile界定旧交互策略

系统 SHALL 按 [design/20 §1、§8–§9](../../../../../docs/design/20-goal-scoped-delegation.md) 以Run冻结事实而非当前页面/部署版本裁决策略。资料入口和批准按授权作用域解释，连接按独立生命周期解释；早期delegation/1可显示request-bound，不能因正常步骤免批准就显示后台继续。通用布局、可达性、明确发送、真实流式增量、owner、只读历史和在途/unknown不可绕过不变。

#### Scenario: 新旧并存只读展示（D2/D6/D8）

- WHEN 同一新版Web打开legacy待批Run和新delegation Run
- THEN 各展示本来授权/连接/结果合同，不让旧pending因新界面自动消费或变直接写；新目标也不被旧资料菜单强制成逐项审批

#### Scenario: 选择不执行与明确发送（D6/D8）

- WHEN 用户展开工具菜单、选择收窄范围或浏览历史
- THEN 仍零业务执行；只有明确发送接纳新委托，不因导航/重连新建Run或改变旧grant

#### Scenario: 能力与连接限制真实可见（D6/D8/D10）

- WHEN 新版Web同时读取早期request-bound委托和后台验收后新接纳的server-owned委托
- THEN 前者如实显示断连取消限制，后者才显示离开继续；未交付elapsed/文件创建不能显示可用，部署升级不改变原Run，最终后台验收仍必需

### Requirement: 可信缺口接续与完整任务定位

conversations SHALL 复用 #103 来源责任并按 [design/20 §5](../../../../../docs/design/20-goal-scoped-delegation.md#5-澄清与接续复用可信跨-run-来源) 接纳typed缺口与既成收据；任务选择来自tasks完整分页/详情公共读取，不让用户抄内部ID，不从模型历史猜前序授权。

#### Scenario: 取消唯一目标与真实歧义（D6/D8/D9）

- WHEN 用户明确取消唯一匹配任务、取消所有未来提醒或两个对象均符合指代
- THEN 前两者读完所需页后按明确范围取消并逐项报告，不因数量重问/承诺全局原子；后者只问目标缺口，定位后不再问同一授权，仍守cancel_pending/撤销回执

#### Scenario: 部分完成后补缺口（D6/D8/D10）

- WHEN 前Run已保存文件但提醒缺日期，用户补唯一可信日期
- THEN 沿核验前序引用和原锚仅完成未建提醒，带入既成收据不重写文件；未决缺口可来自已接受工具或原子目标结果，无工具不造invocation

#### Scenario: 来源不明或并发（D3/D6/D8）

- WHEN 多候选/无关中间目标/旧来源缺失，或两个消息并发续同缺口
- THEN 不取最新任意Run，先问实际关系缺口；接纳事务沿现有会话串行锁及必要前序核验保证唯一后继，不先查后写分叉，不修改旧冻结上下文

#### Scenario: 独立新委托与预算（D3/D8/D9）

- WHEN 用户明确新发相同文本或系统遇预算耗尽
- THEN 新明确目标不因相似度并入旧动作；系统不自动创建续Run绕预算，同入站键仍只重放原响应，普通补缺口不是长期输入等待
