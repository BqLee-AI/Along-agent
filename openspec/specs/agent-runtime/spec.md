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

TS SHALL 原子保存运行资格、被接受的状态转移及消息/事件投影；仓颉独占本次执行的下一步决策。取消在 TS 提交后阻止新工具动作和迟到状态推进，不能伪撤销既成效果。具体锁序和终结见 `docs/design/09-agent-runtime-and-checkpoint.md` §4、§8，既有任务取消/回执保证不变。

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

工具 SHALL 使用稳定调用身份、冻结接受结果、当前权限和 unknown 规则；TS 工具通过所属模块公共用例或明确只读投影访问数据，不在语言边界另建批准、时间或结果规则。见 `openspec/specs/tool-gateway/spec.md`、`docs/design/09-agent-runtime-and-checkpoint.md` §5 及 `docs/design/04-five-seams-contract.md` §3。

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
