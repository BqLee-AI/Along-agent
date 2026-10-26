## MODIFIED Requirements

### Requirement: 分类结果与冻结快照重放

网关 SHALL 持久关联成功、批准等待、拒绝、澄清、类型化错误与明确失败，并区分已接受的操作未完成观察；已接受结果不能被重交覆写。任务/文档批准按各自冻结材料恢复，只读工具回接受时安全快照；原始秘密不得落账。见 `docs/design/06-approvals-confirmation-gate.md` §10、`docs/design/09-agent-runtime-and-checkpoint.md` §5–§6 和 `docs/design/14-r1-document-task-loop.md` §4–§5、§7。

#### Scenario: I4 批准终态后的调用重放

- **WHEN** 已接受调用的批准后来被确认、拒绝、过期或替代，再提交原调用
- **THEN** 仍关联原批准及其种类的冻结材料，任务批准保留原 hash、展示版本和有效期，文档批准保留原版本/确切目标；不重建、不重新归一、不消费，当前状态另读

#### Scenario: I4 只读源变化或时间规则不可用

- **WHEN** 接受结果后任务／偏好等源发生变化，或当前时间规则不可用，再重交同引用
- **THEN** 系统回原接受快照或类型化结果，不重新查询／归一伪装成重放；新引用才可获得新结果

#### Scenario: I4 拒绝与错误重交

- **WHEN** 已接受denied、clarification、time_error或failed的调用被再次提交
- **THEN** 回原分类和安全结构，保持调用／Run／首次接受关联；不因权限后来扩大或时间变化重新执行

### Requirement: 非事务效果未知不盲重发

共同调用协调边界 SHALL 将一次非事务执行资格在动作前持久提交，只有取得该次资格且确认提交的当前执行栈能够调用动作。文档批准只绑定一个 apply 调用；未知只能核对或保持未知，不能因新 slot 再写、凭次数/当前相同内容转成功或宣称外部 exactly-once。见 `docs/design/04-five-seams-contract.md` §3 和 `docs/design/14-r1-document-task-loop.md` §5.3–§6。

#### Scenario: I5 许可后动作前进程终止

- **WHEN** 一次资格已提交，但进程在真实非事务动作前终止，再重启重交
- **THEN** 即使实际效果计数为零也保持未知，不补执行，不假报成功

#### Scenario: I5 效果已发生但接受结果前终止

- **WHEN** 真实非事务副作用已持久产生，进程在接受结果提交前终止，随后顺序或并发重交
- **THEN** 真实效果累计不再增加，回未知；可查询时只读核对同调用／内容绑定的证据，确证才接受结果，无查询或查不到继续未知

#### Scenario: I5 明确未生效失败与已接受成功

- **WHEN** 可信动作证明写前失败，或成功结果已被接受后再次提交
- **THEN** 前者为明确失败且零外部写，后者回原成功且真实效果仍一次；两者都不因重交重新发动作

#### Scenario: R1 同批准换新调用（D8）

- **WHEN** 原文档 apply 重交或试图借同批准预约另一个逻辑调用
- **THEN** 原调用只重放接受结果/未知，新调用被拒绝，不发生第二次替换

### Requirement: 实际使用路径与既有安全保证保持

实现 SHALL 在真实 HTTP、会话、PostgreSQL 和效果边界验证调用与结果归属，workspace 工具也只能经同一可信网关。事件补读不执行，工具接受不等于 Run 自动恢复；五个既有工具和新增工具不保留绕过网关/身份的旧签名层。D8 依正式消费者实际证据限定，不以声明替代 MCP/真实模型/文件产物证明。见 `docs/design/14-r1-document-task-loop.md` §8–§11。

#### Scenario: I6 真实提议确认与取消

- **WHEN** 有效会话／CSRF经HTTP发起消息得到工具批准，再按冻结详情按钮确认或走取消提议
- **THEN** 批准、调用结果与Run正确关联，同批准重复确认同task；未有撤销回执仍cancel_pending，冻结展示、时间类型错误、事件只追加与取消优先不变

#### Scenario: I6 POST重放及GET补读

- **WHEN** 原消息按同入站幂等键重交，或GET after_seq补读已存事件
- **THEN** 沿既有运行中409／完成重放合同处理，补读不新建调用／attempt／批准，不再执行工具

#### Scenario: I6 工具接受前后传输失败

- **WHEN** 批准后审计写失败，或工具结果已接受后socket／checkpoint写失败
- **THEN** 前者无脱节批准且流仅有既有失败终结，不发虚假批准成功；后者保留已接受结果、不重做工具，不声称自动继续该Run

#### Scenario: R1 正式 MCP 与文件消费者（D8）

- **WHEN** 本次生产构建经本地公共用例及签名 HTTP 执行 workspace 文档任务
- **THEN** 实际 native、PG、SDK Client/TS Server 和真实文件参与；省略必要调用或结果纳入导致同消费者失败，而非以历史报告补足

## ADDED Requirements

### Requirement: 事务外只读 MCP 与唯一接受结果

只读 MCP SHALL 在短事务资格检查后、事务外调用，再以短事务裁决首次接受的不可变快照，不占 Run 锁等待外部 IO，不借写效果 unknown 限制纯读。见 `docs/design/14-r1-document-task-loop.md` §4.3、§8。

#### Scenario: R1 读取未返回时取消（D8/D9）

- **WHEN** MCP Server 尚未返回且取消先提交
- **THEN** 取消不被等待 IO 的 Run 锁阻塞；连接被收回，迟到数据不推进运行或披露撤权内容

#### Scenario: R1 同引用并发读取（D6/D8）

- **WHEN** 首次接受前同引用读取取得不同源版本，随后再次重交
- **THEN** 只接受并返回首次接受的原快照，后续结果不覆盖；已有接受结果时不再次调用 MCP
