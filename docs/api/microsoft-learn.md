# Microsoft Learn 公开资料搜索

连接页的 Microsoft Learn 开关只记录本人的公开搜索选择，不执行 Microsoft 登录、不要求密钥，也不探测上游健康。连接本身不授权普通聊天出站；仅本轮显式提交查询的新 delegation/1 Harness 请求可以冻结该能力，已有 Run 不扩权。查询词会发往 Microsoft，不能包含秘密或私有正文。

## HTTP 与状态

三条路由均要求有效本人签名会话，返回通用 envelope 和 `Cache-Control: no-store`：

| 方法 | 路径                                             | 请求                           | data                          |
| ---- | ------------------------------------------------ | ------------------------------ | ----------------------------- |
| GET  | `/api/v1/connections/microsoft-learn`            | 无                             | `{state:'idle'\|'connected'}` |
| POST | `/api/v1/connections/microsoft-learn/connect`    | 严格空 JSON `{}`；Origin、CSRF | `{state:'connected'}`         |
| POST | `/api/v1/connections/microsoft-learn/disconnect` | 严格空 JSON `{}`；Origin、CSRF | `{state:'idle'}`              |

连接操作不访问上游。状态不是服务可用性或 Microsoft 身份证明。服务端不接受 endpoint、工具名、请求头或凭据配置。额外配置字段返回 `400 VALIDATION_ERROR`。

## 本轮显式查询

会话输入框的固定“Microsoft Learn 查询”入口明确说明全文将发往 Microsoft；选择或填写不执行，点击发送才提交，发送后回到普通聊天。沿用 `POST /api/v1/conversations/messages`，仅该入口附带 `microsoft_learn_query`，必须与本次 `raw_text` 完全相同。

查询不得全为空白，最多 500 个 Unicode 码点，不接受孤立 surrogate。保留首尾空白、标点和确切文本，不 trim、翻译、扩展或补全。要求本人签名会话、已连接、`execution:'harness'` 与 `authorization_revision:'delegation/1'`；不能与资料工作区、卡片、补充请求或飞书私有读取组合。字段无效或连接失效时拒绝，不降级成普通请求。普通聊天即使文字要求“搜索一下”，也没有该工具资格。

查询字段是否存在及确切值都纳入既有入站幂等绑定；同键从普通请求变成查询、变更查询或移除字段均冲突。重放沿用原接纳，不重冻。继续、恢复、历史、摘要、受管资料和工具结果不能代填新的查询。

## 工具与结果

模型只见 `learn_docs_search({})`，严格空对象，额外字段（包括 `query`）在本地拒绝、零出站。工具只消费服务端冻结的本轮查询，原样作为远端 `microsoft_docs_search` 的 `query`，结果中的 `query` 也保留该值；模型不能替换或追加。服务端固定访问 `https://learn.microsoft.com/api/mcp`；发现目录不成为模型工具或授权来源。不开放 code sample、fetch、全文下载或链接跟随。

接受结果为 `{kind:'learn_docs_search',query,fetched_at,representation:'search_excerpts',items:[{title,url,content}]}`。最多 10 条，每条 UTF-8 上限为标题 512、URL 2048、摘录 4096 字节，整个序列化 payload 最多 65536 字节。来源只允许无用户信息、无非默认端口的 HTTPS `learn.microsoft.com` URL。内容是低信任公开摘录，不是指令、授权、全文或穷尽结果；引用使用实际返回的来源 URL。

一次连接、发现、调用共用 15 秒 deadline。SDK 解析前限制单个 HTTP 响应累计 131072 字节；发现至多 16 工具且拒绝分页。超界整体失败，不静默截断。不跟随 HTTP 重定向，不自动重试，不使用旧结果兜底。

工具失败分为 `REMOTE_MCP_TIMEOUT`、`REMOTE_MCP_SERVICE_FAILED`、`REMOTE_MCP_PROTOCOL_ERROR`、`REMOTE_MCP_RESULT_TOO_LARGE`；本地资格不足是 denied，不伪装为上游失败。

## 冻结、断开与历史

迁移 `0042_microsoft_learn_connections.sql` 新增 remote-mcp 自有窄表 `microsoft_learn_connections`：`owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`、`generation uuid NOT NULL`。重复启用保留 generation；断开删除本人行，重新启用产生新的 UUID。

仅显式查询的新 Run 将 `{microsoftLearn:{generation,query}}` 写入既有冻结上下文；旧 Run 不回填，不从历史重建查询。飞书私有文档收窄 Run 不增加公开搜索。每个出站 HTTP 请求之前，以及最终接受之前，核对本人有效资格、当前 Run/attempt、signal、冻结代次和查询；网络等待期间不持有数据库锁。

断开不能撤回已经发送的 HTTP 请求，但断开或取消先于接受时不得保存迟到成功。有效 invocation 重放复用原接受结果、零上游；失效代次禁止执行和执行重放。既有公开接受结果仍可经本人只读历史或上下文恢复读取，不套用私有飞书正文的加密/撤回机制。审计和结果继续归既有 `tool_invocations`、只追加 `tool_calls`，不建第二本账。

行为依据：[OpenSpec change](../../openspec/changes/add-readonly-remote-mcp-connection/design.md)。协议实验和产品验收分别取证，本文不证明部署状态。
