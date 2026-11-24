# 普通对话的 Microsoft Learn 单一公开搜索

## 依据与取舍

Observed：代码基线 `ea01db0` 的 `agent/tools/workspace/mcp-workspace.ts` 使用 MCP SDK 2.4.0；`executeReadOnlyInvocation` 已短事务核验、事务外执行并以短事务接受唯一结果。`startConversationRun` 持久化实际工具 allowlist，仓颉校验工具与结果。未发布实施稿曾要求连接和专用输入，用户明确否决该产品路径。

Observed（2026-11-23 公开协议实验）：`https://learn.microsoft.com/api/mcp` 无需认证，协商 MCP `2025-06-18`，HTTP POST/SSE；发现 3 个工具，无下一页。`microsoft_docs_search` 标注只读并接收 query，一次 PostgreSQL 备份搜索约 48 KB wire，返回至多本次观察的 10 条 title/content/contentUrl。产品消费验证后的 structuredContent，不重复复制 text。官方参考：https://learn.microsoft.com/en-us/training/support/mcp-developer-reference 。该实验不证明普通会话自主检索已验收。

Required：没有 Learn 设置或模式的新普通对话能由现有模型决定何时检索、提炼/翻译技术查询、使用真实来源回答；无需检索时不出站。推荐固定适配，保留 SDK 协议实现及原网关，不做动态工具注册或新的授权平台。

## 入口、工具名单与私有读取

沿用现有普通消息入口和模型选择；为合格的新 delegation Harness Run 冻结 `learn_docs_search` 工具名单资格，不增加 microsoft_learn_query、连接状态、generation、专属状态或单独开关。名单资格不是自动执行，模型决定是否调用。旧 Run 的持久化 allowlist 是权威，继续、恢复、刷新或部署不补工具；不从全局新目录覆盖旧名单。

既有飞书私有读取 Run 继续按原规则收窄工具。普通对话模型可看到原有上下文，只能选择是否调用严格 `learn_docs_search({})`。服务端在获得执行资格后，使用本 Run 已绑定的同一 provider 和模型，从固定说明与本轮已接受的用户输入进行一次独立查询生成。推理不接收主模型输出、历史、摘要、工作区、记忆、工具结果、资源 ID 或任何工具定义。仅续用先前材料而缺少独立技术问题时，要求查询生成返回无可用查询。本轮用户输入本身可含敏感信息，搜索生成说明要求省略这些内容，Web 输入框提示本轮技术问题可能用于公开搜索。该说明无法分类任意当前输入。

## 唯一工具与协议边界

独立推理可以提炼或翻译技术问题，只接受 JSON 对象 `{"query":string|null}`。输出须在有界时间、输出容量和本轮绑定内完成。query 非全空白、最多 500 个 Unicode 码点且无孤立 surrogate。无可用查询、推理失败或输出不合约均不调用 MCP，由模型继续对话并说明缺少可检索的公开问题。网关只发送该独立推理的 query。接受结果中的 query 与实际派发值一致。endpoint、远程工具、owner、headers 和凭据不可由模型指定。额外工具字段或无效资格在本地拒绝。

每个新 invocation 使用短生命周期 SDK Client/StreamableHTTPClientTransport：初始化、单页发现、调用一次固定 microsoft_docs_search、关闭。不缓存或动态注册目录，不请求 roots/prompts/resources。发现最多 16 项、无 cursor；固定工具须仍声明只读，具有可识别 query 输入与 results 输出合同，其他工具不暴露或调用。

沿用已实测容量：每个远程响应累计 131072 字节，SDK 解析前流式计数；至多 10 条结果，标题 512、URL 2048、摘录 4096 UTF-8 字节，总序列化结果不超过 65536 字节。初始化/发现/调用共用 15000ms deadline，合并 attempt 取消与 SDK signal；禁止重定向、认证回退、自动重试、独立 SSE 重连和扩大目的地。每次必要的 SDK HTTP 派发也核验同一固定 endpoint 与执行资格。

结果为 kind:'learn_docs_search'、query、fetched_at、representation:'search_excerpts'、items:[{title,url,content}]。只接受 HTTPS learn.microsoft.com、无 userinfo 或非默认端口的来源，不跟随链接；空数组仅表示本次无返回。字段及总容量失败整体拒绝，不截断为完整结果。远端描述/schema、不可信内容均不成为指令或授权。

## 资格、接受与失败

复用 executeReadOnlyInvocation、invocation/call key/args hash、首次不可变结果和 tool_calls 审计。模型搜索选择的空参数进入 invocation 绑定，实际查询词进入接受结果以关联真实来源。合格重放不重做查询生成。每次真正出站前及最终接受时核验 owner、Run/attempt、冻结名单与停止信号。网络等待期间无数据库锁。取消或原资格失效先提交时不接受迟到成功。

合格重放返回原接受结果，零上游；历史及上下文恢复能读取已接受的公开事实，但不能增加旧 Run 的工具名单。公开结果不复制飞书私有内容的加密、披露或撤回机制。

失败保留 REMOTE_MCP_TIMEOUT、REMOTE_MCP_SERVICE_FAILED、REMOTE_MCP_PROTOCOL_ERROR、REMOTE_MCP_RESULT_TOO_LARGE。与成功一样保留本轮对应观察，在检查点前写入引用与观察结果。模型收到实际失败后继续生成回答，只有成功结果可作为成功证据。资格或参数错误走既有 denied。无自动重试、旧结果兜底或切换 slot。

## 未发布结构的移除

连接卡、连接路由/服务、generation 与查询冻结字段、专用入口无当前用途，全部删除，不留兼容别名或废弃开关。删除本分支未合并的 0042_microsoft_learn_connections.sql、0042 manifest/baseline 和其独有目标测试变化，回到已合并迁移末版本；不编辑任何已合并迁移。不修改、清理、升级或降级旧实验安装，不拿旧隔离 0042 库作为新版本证明。

## 验证与交付

OpenSpec-only PR 先于实现合并。验证记录区分合同校验、受控模型与真实 native/Web/MCP 执行。

新隔离正式安装使用实际 Web 普通输入“请查微软官方文档，Azure Database for PostgreSQL Flexible Server 的备份保留多久？请给出处”或等价合成问题，无连接、无模式。优先已有可用真实模型与真实 public MCP，捕获模型选择、实际 query、真实来源和历史；模型不可用则记录真实失败原因，另用受控模型证明链路，不称自主意图已验证。无需检索的普通消息不产生 MCP 派发。

定向覆盖旧 Run、飞书私有读取隔离、独立查询生成无法接收历史或工作区结果、主模型无法传入 query、缺少查询零 MCP、固定 endpoint、取消、失败时真实 Harness/API 对话继续、容量和重放审计。正式安装从空库验证实际目标版本。
