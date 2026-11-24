## ADDED Requirements

### Requirement: 固定公开 MCP 的模型查询工具

系统 SHALL 在合格新普通 Harness Run 中提供单个固定 learn_docs_search 工具，严格接受 {query:string}。模型可按任务提炼、翻译公开技术查询；不得发送私有正文、个人/账户/工作区标识或密钥。服务端 SHALL 固定 endpoint 与 microsoft_docs_search，验证参数、原执行资格与冻结名单，不从其他上下文追加请求内容，不动态注册远端发现项。具体容量和输入见本 change design；提示说明不是严格防泄漏门。

#### Scenario: 模型提供技术 query

- **WHEN** 合格 Run 的模型用有效 query 调用搜索，该 query 可以不同于当前消息全文
- **THEN** 经既有只读网关派发到 https://learn.microsoft.com/api/mcp 的唯一 microsoft_docs_search，实际 query 和结果中的 query 等于模型参数，返回真实公开摘录与官方来源，不要求连接状态或额外审批。

#### Scenario: 目的地与参数不能扩展

- **WHEN** query 缺失、全空白、超过 500 个 Unicode 码点或包含孤立 surrogate，或模型提供 endpoint/工具名等额外字段，或调用不在冻结名单/当前资格中
- **THEN** 本地拒绝且零 MCP 出站；其他发现工具、写工具和任意 URL 不可调用。

### Requirement: 当前执行资格、取消与不可变重放

系统 SHALL 沿用原 invocation 参数哈希、Run/attempt/owner 绑定、事务外执行及首次不可变接受结果。每次真实 HTTP 派发和最终接受均复核当前执行资格与停止信号，不持数据库锁等待网络。不增加连接代次、专属状态或新的效果账。

#### Scenario: 取消或资格失效先于派发

- **WHEN** 原执行已取消、名单不含工具或 Run/attempt/owner 资格无效
- **THEN** 拒绝且零新出站，不恢复旧 Run 权限。

#### Scenario: 在途取消先于接受

- **WHEN** 网络查询在途，取消先于最终接受提交
- **THEN** 不接受迟到成功、不推进 Run，不把已经派发的请求说成零调用或已撤回。

#### Scenario: 相同 invocation 重放与改词

- **WHEN** 相同合格 invocation 已有接受结果，或相同调用键的 query 被改动
- **THEN** 合格重放仅返回原结果并记录审计，零上游；参数变更按既有绑定拒绝，不覆盖原结果或重新搜索。

### Requirement: 公开结果有界且可关联来源与失败

系统 SHALL 保留固定服务的发现、传输、条数、字段和总结果容量限制，仅返回 HTTPS learn.microsoft.com 官方来源的实际文本摘录与读取时间，不执行链接，不把远端内容当指令或授权。失败经原 invocation/Run 和审计关联；公开结果不套用飞书私有撤回/披露机制。

#### Scenario: 真实来源与空结果

- **WHEN** 搜索返回有效结果或空数组
- **THEN** 仅返回本次真实摘录和来源，明确不是全文、实时状态或穷尽搜索；空结果不证明资料不存在。

#### Scenario: 超时和服务失败

- **WHEN** 整体 deadline 超时或 HTTP/MCP 服务失败
- **THEN** 保留不同的超时/服务失败分类，不自动重试，不以旧结果或空数组伪装成功。

#### Scenario: 超界和不合约响应

- **WHEN** 工具清单/正文超界、需要分页、固定工具缺失，或返回非文本/非官方来源/不合约内容
- **THEN** 整体返回有界协议或容量失败，不静默截断、跟随链接或重定向扩大出站。
