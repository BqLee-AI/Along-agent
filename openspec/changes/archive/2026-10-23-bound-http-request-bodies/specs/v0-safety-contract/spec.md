## ADDED Requirements

### Requirement: 身份先于有限请求体收集

HTTP入口 SHALL 在受保护POST请求收集业务body之前复用既有actor身份与适用CSRF请求头门禁；SHALL 不引入第二套认证规则，不改变正常确认、对话或取消的业务合同。引用`docs/design/10-api-and-stream-design.md` §1、§3及`docs/design/03-v0-vertical-slice.md` §2。

#### Scenario: 无会话的未结束上传

- WHEN 受保护POST上传已发送有限前缀但客户端尚未结束，且无有效会话
- THEN 返回既有401 envelope而不等待end，响应后关闭未消费连接，不进入业务写入（D8、A1/A2）

#### Scenario: CSRF拒绝先于收集

- WHEN 既有会话actor对受保护写路由提交缺失或无效CSRF头，且上传尚未结束
- THEN 返回既有403 FORBIDDEN及CSRF_MISMATCH原因，响应后关闭未消费连接；合法CSRF保留原有owner/确认事务（D8、A2）

### Requirement: 原始字节有界且错误合同一致

HTTP入口 SHALL 以131072字节为JSON请求体原始累计上限，覆盖无Content-Length的分块上传；SHALL 在保存越界块或解析前拒绝超限，以HTTP413、顶层code413及PAYLOAD_TOO_LARGE符号码返回既有envelope。空/畸形JSON SHALL 使用400 VALIDATION_ERROR；所有错误中的request_id SHALL 与响应头一致，不新建40xxxx业务编号。引用`docs/design/10-api-and-stream-design.md` §1、§3、§6。

#### Scenario: 单块和声明长度超限

- WHEN 身份/CSRF通过的请求声明Content-Length超过上限，或单次到达的数据令累计字节超过上限
- THEN 无需等待剩余上传即可413，不保存越界块，不进入业务写入（D8、A2）

#### Scenario: 分块与多字节文本

- WHEN 无长度请求分多块发送，或UTF8文本字符数与字节数不同
- THEN 按原始字节累计，等于上限允许解析，超过一字节即413，不受块边界影响（D8）

#### Scenario: 小JSON与语法错误

- WHEN 合法小JSON或上限内畸形/空JSON到达正常结束
- THEN 合法输入进入既有业务验证；畸形/空输入返回400 VALIDATION_ERROR；request_id在响应头、envelope与error中一致（D8、A1/A2）

### Requirement: 请求流收尾不依赖任意上传完成

HTTP入口 SHALL 停止保存被拒绝请求的数据并释放已收集块；对于未消费/超限请求 SHALL 先发送有限错误响应并声明Connection: close，然后关闭连接，不无界drain。客户端中断或流错误 SHALL 结束读取、移除读取监听器且不调用业务；正常完整请求 SHALL 保留原有连接复用能力。引用`docs/design/10-api-and-stream-design.md` §1、§6。

#### Scenario: 拒绝后客户端不结束

- WHEN 客户端收到401/403/413或未知路由404而仍未结束上传
- THEN 有限错误响应可读且连接随后关闭，不等待任意body完成（D8）

#### Scenario: 上传中断

- WHEN 客户端在JSON完成前关闭连接
- THEN 请求读取结束，不解析部分JSON或进入业务，服务端继续处理下一条正常请求（D8、A1/A2）

#### Scenario: 合法请求保持原有业务

- WHEN 合法会话和CSRF提交完整小JSON，随后再次发送请求
- THEN 正常批准/对话/任务业务仍可达，完整合法请求不强制关闭连接，冻结确认与取消事务不变（D8、A1/A2、D3/D5/D9）
