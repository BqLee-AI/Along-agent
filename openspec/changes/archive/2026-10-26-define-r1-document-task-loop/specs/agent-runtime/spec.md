## MODIFIED Requirements

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

## ADDED Requirements

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
