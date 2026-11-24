# 普通对话的 Microsoft Learn 单一公开搜索

## 依据与取舍

Observed：代码基线 `ea01db0` 的 `agent/tools/workspace/mcp-workspace.ts` 使用 MCP SDK 2.4.0；`executeReadOnlyInvocation` 已短事务核验、事务外执行并以短事务接受唯一结果。`startConversationRun` 持久化实际工具 allowlist，仓颉校验工具与结果。未发布实施稿曾要求连接和专用输入，用户明确否决该产品路径。

Observed（2026-11-23 公开协议实验）：`https://learn.microsoft.com/api/mcp` 无需认证，协商 MCP `2025-06-18`，HTTP POST/SSE；发现 3 个工具，无下一页。`microsoft_docs_search` 标注只读并接收 query，一次 PostgreSQL 备份搜索约 48 KB wire，返回至多本次观察的 10 条 title/content/contentUrl。产品消费验证后的 structuredContent，不重复复制 text。官方参考：https://learn.microsoft.com/en-us/training/support/mcp-developer-reference 。该实验不证明普通会话自主检索已验收。

Required：没有 Learn 设置或模式的新普通对话能由现有模型决定何时检索、提炼/翻译技术查询、使用真实来源回答；无需检索时不出站。推荐固定适配，保留 SDK 协议实现及原网关，不做动态工具注册或新的授权平台。

## 入口、工具名单与私有读取

沿用现有普通消息入口和模型选择；为合格的新 delegation Harness Run 冻结 `learn_docs_search` 工具名单资格，不增加 microsoft_learn_query、连接状态、generation、专属状态或单独开关。名单资格不是自动执行，模型决定是否调用。旧 Run 的持久化 allowlist 是权威，继续、恢复、刷新或部署不补工具；不从全局新目录覆盖旧名单。

既有飞书私有读取 Run 仍按原规则收窄工具，不暴露公开搜索。公开工具说明要求仅生成检索所需的公开技术关键词；不得把私有正文、个人/账户/工作区标识、令牌或密钥当搜索词。可提炼、翻译，不要求查询逐字来自当前消息。说明约束模型行为而非严格的数据防泄漏门；不造新分类器，不把所有受管资料一律判为禁止公开搜索的来源，也不新增正常对话、工作区、提醒、审批的阻断。

## 唯一工具与协议边界

`learn_docs_search({query:string})` 是严格单字段对象，query 非全空白、最多 500 个 Unicode 码点且无孤立 surrogate。模型组织查询词，适配器只验证并发送该参数，不追加历史或正文；接受结果中的 query 与实际派发值一致。endpoint、远程工具、owner、headers 和凭据不可由模型指定。缺 query、额外字段、无效资格本地拒绝，零 MCP 出站。

每个新 invocation 使用短生命周期 SDK Client/StreamableHTTPClientTransport：初始化、单页发现、调用一次固定 microsoft_docs_search、关闭。不缓存或动态注册目录，不请求 roots/prompts/resources。发现最多 16 项、无 cursor；固定工具须仍声明只读，具有可识别 query 输入与 results 输出合同，其他工具不暴露或调用。

沿用已实测容量：每个远程响应累计 131072 字节，SDK 解析前流式计数；至多 10 条结果，标题 512、URL 2048、摘录 4096 UTF-8 字节，总序列化结果不超过 65536 字节。初始化/发现/调用共用 15000ms deadline，合并 attempt 取消与 SDK signal；禁止重定向、认证回退、自动重试、独立 SSE 重连和扩大目的地。每次必要的 SDK HTTP 派发也核验同一固定 endpoint 与执行资格。

结果为 kind:'learn_docs_search'、query、fetched_at、representation:'search_excerpts'、items:[{title,url,content}]。只接受 HTTPS learn.microsoft.com、无 userinfo 或非默认端口的来源，不跟随链接；空数组仅表示本次无返回。字段及总容量失败整体拒绝，不截断为完整结果。远端描述/schema、不可信内容均不成为指令或授权。

## 资格、接受与失败

复用 executeReadOnlyInvocation、invocation/call key/args hash、首次不可变结果和 tool_calls 审计。模型 query 是 invocation 参数绑定的一部分；同 invocation 改 query 不替换原执行。每次真正出站前及最终接受时核验 owner、Run/attempt、冻结名单与停止信号，网络期间无数据库锁。取消或原资格失效先提交时不接受迟到成功，不宣称能撤回已经派发的 HTTP。

合格重放返回原接受结果，零上游；历史及上下文恢复能读取已接受的公开事实，但不能增加旧 Run 的工具名单。公开结果不复制飞书私有内容的加密、披露或撤回机制。

失败保留 REMOTE_MCP_TIMEOUT、REMOTE_MCP_SERVICE_FAILED、REMOTE_MCP_PROTOCOL_ERROR、REMOTE_MCP_RESULT_TOO_LARGE；本地资格/参数走既有 denied。失败不伪报空结果，不用旧结果兜底，不自动重试或切换 slot，不扩展错误平台。

## 未发布结构的移除

连接卡、连接路由/服务、generation 与查询冻结字段、专用入口无当前用途，全部删除，不留兼容别名或废弃开关。删除本分支未合并的 0042_microsoft_learn_connections.sql、0042 manifest/baseline 和其独有目标测试变化，回到已合并迁移末版本；不编辑任何已合并迁移。不修改、清理、升级或降级旧实验安装，不拿旧隔离 0042 库作为新版本证明。

## 验证与交付

Spec-only 分支先校验、提交推送 #170，再实施 #172；两者保留草稿，不合并、不归档、不关闭 #168。验证记录区分合同校验、SDK/网关受控实验、真实 native 与产品运行，不把旧验收冒充新普通输入路径。

新隔离正式安装使用实际 Web 普通输入“请查微软官方文档，Azure Database for PostgreSQL Flexible Server 的备份保留多久？请给出处”或等价合成问题，无连接、无模式。优先已有可用真实模型与真实 public MCP，捕获模型选择、实际 query、真实来源和历史；模型不可用则记录真实失败原因，另用受控模型证明链路，不称自主意图已验证。无需检索的普通消息不产生 MCP 派发。

定向覆盖已冻结旧 Run 不增权、模型 query 与固定 endpoint、非法参数、取消先于接受、失败与容量、重放/审计、既有飞书私有读取隔离。保留有效既有结果，仅对受影响合同补测；正式安装从空库证明移除未发布表后的真实目标版本，旧环境保持原状。
