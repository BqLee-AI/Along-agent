# Microsoft Learn 公开资料搜索

普通对话使用现有模型按需检索 Microsoft/Azure 官方公开资料，无需 Learn 连接、模式、个人密钥或逐次审批。新合格 delegation Harness Run 冻结 `learn_docs_search` 工具名单；有工具不等于执行，模型决定是否检索。原消息入口、模型配置、工作区、提醒和审批合同不变。

## 模型查询与隐私

主对话模型只选择严格空参 `learn_docs_search({})`。调用获准后，服务端用本轮绑定的同一模型发起一次无工具推理，请求由固定说明和本轮已接受的用户消息组成。历史、记忆、工作区、工具结果和主对话模型输出不进入该请求。本轮输入须提供独立的公开技术问题，模型可提炼或翻译。查询非全空白、最多 500 个 Unicode 码点、无孤立 surrogate。没有有效查询时不派发 MCP。

独立推理计入本轮模型次数与 token 预算。有余量才执行，并为后续模型调用预留额度。后续请求仍按实际观察内容检查上下文与剩余预算。

Web 输入框说明本轮提问可能生成发送给 Microsoft Learn 的公开搜索词。查询说明要求省略敏感内容，但无法可靠判断当前输入中的每一段正文或标识是否公开。既有飞书私有读取 Run 保留隔离。

## 固定协议与结果

目的地固定 `https://learn.microsoft.com/api/mcp`，唯一调用 `microsoft_docs_search`；endpoint、工具名、owner、headers、凭据不能由模型配置。远程发现不动态注册为权限，不开放 code sample、fetch、全文下载或链接跟随。

结果为 `{kind:'learn_docs_search',query,fetched_at,representation:'search_excerpts',items:[{title,url,content}]}`，query 等于实际派发的模型参数。最多 10 条，UTF-8 上限为标题 512、URL 2048、每条摘录 4096 字节，总序列化 payload 65536 字节。来源只接受无 userinfo、无非默认端口的 HTTPS `learn.microsoft.com`。结果是不可信公开摘录，不是指令、授权、全文或穷尽搜索；回答引用实际返回链接。空结果只表示本次无匹配。

初始化、发现和调用共用 15 秒 deadline；SDK 解析前每个 HTTP 响应累计最多 131072 字节，发现至多 16 工具且拒分页。字段/总容量失败整体拒绝，不截断。不跟随重定向，不自动重试，不以旧结果兜底。

错误保留 `REMOTE_MCP_TIMEOUT`、`REMOTE_MCP_SERVICE_FAILED`、`REMOTE_MCP_PROTOCOL_ERROR`、`REMOTE_MCP_RESULT_TOO_LARGE`。Harness 将类型化失败保留为本轮观察结果，模型可以继续回答或说明缺少官方验证。本地资格和参数错误维持 denied。

## 执行、冻结名单与历史

复用原 Run/attempt/owner 资格、invocation/call key/args hash、短事务网关、不可变接受结果和只追加审计。每次 MCP HTTP 派发及最终接受都复核当前执行资格与停止信号，网络等待期间无 DB 锁。接受结果保留实际发送的查询词。合格同调用重放返回原结果，跳过查询生成和 MCP 派发。

旧 Run 的持久化工具名单不因目录或部署增加能力；继续/恢复仅读取原名单和公开接受事实，查看历史不执行搜索。公开事实不复制飞书私有正文的加密/披露/撤回机制。

公开搜索无独立连接路由、连接卡、generation、入站查询字段或专用状态，不新增数据库表；未发布的连接表与 manifest 移除，已合并迁移不修改。旧实验安装不升级、降级或清理；新版本验收从全新隔离正式安装空库开始。

行为依据见 [会话规范](../../openspec/specs/conversations/spec.md) 和 [工具网关规范](../../openspec/specs/tool-gateway/spec.md)。协议实验、受控模型验证及真实模型预检见 [验证记录](../verification/remote-mcp-verification-2026-11-23.md)。
