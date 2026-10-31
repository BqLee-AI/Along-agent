## ADDED Requirements

### Requirement: direct 决议绑定唯一原网关只读调用

TS ToolGateway SHALL 在接纳 direct 后，仅允许该 Run 当前资格下与决议目标及规范参数一致的一个既有只读 reserve/invoke，不增加旁路 handler 或平行调用身份。owner/Run/attempt、当前权限、逻辑引用、冻结接受结果和取消原合同保持。见 [design/19](../../../../../docs/design/19-r2b-readonly-intent-routing.md) §3–§4、§8–§10。

#### Scenario: 三白名单真实调用（D1/D8）

- **WHEN** 正式 native 使用已接纳决议预约并调用对应 list_tasks/get_user_prefs/read_brief_cards
- **THEN** 经原网关及所属模块公共用例/明确只读投影执行，只有一个真实绑定调用；不直读他模块私表，不绕身份/权限，不伪造模型函数调用或 provider call ID

#### Scenario: 换目标、换参数或增加调用（D8/D9）

- **WHEN** direct 后提交不同工具/参数、写工具、跨 owner/Run/旧 attempt 引用或第二 slot
- **THEN** 拒绝且不产生新业务读取/副作用，不因相似分数或原决议恢复执行资格；取消先提交仍阻止新动作，不以新引用绕过唯一调用

#### Scenario: 同引用重交与源变化（D6/D8）

- **WHEN** direct 工具结果已接受后源数据改变，或原调用回答丢失而同引用重交
- **THEN** 回原接受快照，不重新查询、不覆盖、不新建引用；重放不等于 Run 可恢复或可换路线，当前访问资格仍核验

### Requirement: direct 完成依赖真实成功与完整快照

系统 SHALL 将 direct 的真实 invocation、已接受只读成功结果、原 snapshot2 和确定性展示回执绑定；仅在唯一真实成功结果、合法 render 回执及零聊天模型调用同时成立时接受成功 finish。direct 不伪造模型输入计量或 usage，embedding 计量不混入 provider 账。见 design/19 §7–§10。

#### Scenario: 接受结果、快照与成功（D6/D8）

- **WHEN** direct 工具真实成功，原接受结果与完整 snapshot2 已按资格保存，随后真实结果被展示
- **THEN** 真实工具引用/next_call_no 单调且完整，finish 校验同 Run 的唯一成功与 render 回执后才能完成；不构造假的 assistant.tool_calls、模型历史或 provider usage，零模型仅表示实际没有模型调用

#### Scenario: 缺步骤或失败结果（D8/D10）

- **WHEN** 仅有候选/决议/预约而无真实成功，缺 snapshot/render，或结果为拒绝/失败/unknown
- **THEN** 拒绝成功终结，保留原账且不切 LLM/换 slot重做；消费者省略真实结果纳入、snapshot 或 render 时同一根入口必须因行为错误变红，不能由 HTTP200 或文本宣称补足

#### Scenario: fallback 保留原模型预算与来源（D8/D10）

- **WHEN** 路由终局为 fallback，随后原模型实际执行或工具进入批准等待
- **THEN** 继续原完整模型计量/窗口/累计预算、真实 provider 增量和可得 usage/unknown，不因路由重置预算或补假零账；批准恢复沿原工具/snapshot2，不再路由

### Requirement: 确定性展示的可信来源与原子接受

TS SHALL 仅从本 Run 已接纳 direct 决议与真实接受结果生成固定版本的纯展示，不接受 native 任意正文，不调用模型或第二工具收尾。展示复用原安全文本投影及既有事件，全部 delta 与 render 回执同事务接受；原模型 answer 仍须真实 pending provider delta 来源。见 design/19 §7、§9–§10。

#### Scenario: 原始结果与 renderer 来源（D1/D8/D10）

- **WHEN** 正式 native 请求展示合法决议及其唯一 invocation 和模板版本
- **THEN** TS 从原 accepted_result 纯投影生成正文，不信任自报工具结果/owner/任意文本，不另查当前源；结果中的标题/正文仅为数据而非指令，沿原安全 Markdown/转义路径显示

#### Scenario: 任意 answer 与损坏引用（D8/D10）

- **WHEN** 首次模型前提交任意 answer，或 renderer 引用跨 Run/未接受结果/不匹配模板/缺失或损坏来源，或普通 answer 不匹配真实 provider delta
- **THEN** 拒绝而不写可见成功内容；不以空结果、当前源、模型润色或宽松首轮 answer 修复可信事实，也不因错误来源切 LLM

#### Scenario: delta 与 render 原子提交（D6/D8）

- **WHEN** TS 在锁外准备完整文本并通过字节/Unicode安全分块检查，随后写 delta 或 render 时失败，或当前资格已撤销
- **THEN** 全部展示与回执要么同事务提交、要么均不接受，取消先提交不产生迟到正文；不留下半个可见成功或有回执无正文，不偷偷摘要/截断凑完成

#### Scenario: 已提交展示后传输丢失（D6/D8/D10）

- **WHEN** 正文与 render 已提交但 socket 回答丢失，用户随后刷新/GET/同键重放
- **THEN** 仅按原事件顺序补读已存正文，不重查工具、不重渲染/重分类；不等待后拆成假的 provider 逐字流，也不向外暴露内部路由回执或扩充七事件
