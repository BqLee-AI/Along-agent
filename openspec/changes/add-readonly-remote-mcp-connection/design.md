# Microsoft Learn 单一公开查询的最小接入

## 依据与取舍

Observed：代码基线 `ea01db0`。现有 `/connectors` 页面管理飞书机器人；`agent/tools/workspace/mcp-workspace.ts` 使用 MCP SDK 2.4.0；`executeReadOnlyInvocation` 已在短事务核验后事务外执行，并以短事务接受唯一结果。`startConversationRun` 冻结实际 allowlist，仓颉严格校验工具和结果，不能只增加 HTTP 客户端。

Observed（2026-11-23 公开协议实验）：官方 `https://learn.microsoft.com/api/mcp` 无需认证，协商 MCP `2025-06-18`，以 HTTP POST/SSE 响应工作。`tools/list` 返回 3 个工具、无下一页；`microsoft_docs_search` 标注只读，接收 `query`，返回至多本次观察的 10 条 `title/content/contentUrl` 摘录。一次 PostgreSQL 备份保留查询约 48 KB wire，包含重复的 JSON text 和 structuredContent；产品只消费验证后的 structuredContent，不复制两份到模型。官方参考：https://learn.microsoft.com/en-us/training/support/mcp-developer-reference 。该实验不证明产品用户路径已验收。

推荐固定适配，而不是动态发现后直接注册模型工具。保留 SDK 的初始化、版本、JSON-RPC 与 SSE 处理；新增部分仅拥有固定目的地、出站资格、响应容量和结果投影。直接网页抓取不能验证 MCP；通用服务器注册/OAuth 超出单个公众查询需求。

## 新 Run 与连接所有权

Proposed：`features/remote-mcp` 拥有唯一 Microsoft Learn 连接状态和协议适配，公共用例经 `public.ts` 暴露；不借用飞书机器人身份或私有正文存储。

- `GET /api/v1/connections/microsoft-learn`：本人签名会话、no-store，返回 `{state:'idle'|'connected'}`，仅读本地状态，不查询上游。
- `POST` 同路径的 `/connect` 和 `/disconnect`：本人签名会话、Origin/CSRF、严格空 JSON 对象。连接只启用后续显式查询入口，不授权普通聊天出站，不测试服务健康、不做 Microsoft 登录。重复连接保持当前代次；断开删除本人的状态；重连生成新 UUID 代次。
- 新窄表 `microsoft_learn_connections(owner_id PK, generation UUID)`，仅前向迁移。无 URL、令牌、schema、动态工具或通用 provider 表。
- 仅用户本轮经下述查询入口显式提交的新签名 `delegation/1` Harness Run 冻结 `microsoftLearn:{generation,query}` 并获 `learn_docs_search`。资格属 owner，沿原 Run 生命周期执行；不以已退出的发起会话代替 server-owned Run 资格。飞书私有读取 Run 仍保留现有收窄工具集合，不获得外部搜索工具。
- Run、invocation、恢复上下文绑定同一冻结代次和确切查询词；旧 Run 无字段不补权。原入站幂等重放不重新冻结，继续或恢复也不从新消息、历史、摘要或资料重建查询词。连接页 GET、历史、刷新和重登均不执行查询。

## 本轮显式查询输入

Proposed：复用会话输入框和提醒/资料快捷入口的交互，增加固定的“Microsoft Learn 查询”入口，不增加通用出站授权平台。用户选中后，输入框明确说明“输入全文将作为查询词发送到 Microsoft Learn”；选择或填写本身不执行。用户点击发送才提交本轮查询，发送后回到普通聊天，不沿用该选择授权下一轮。

沿用 `POST /api/v1/conversations/messages`，仅该快捷入口发送可选字符串字段 `microsoft_learn_query`，其值为本轮输入框全文，且必须与本次消息 `raw_text` 完全相同。服务端在签名、owner、`delegation/1` Harness 和当前连接校验后，于新 Run 接纳时冻结确切值；查询词按 Unicode 码点计数，最多 500 字符且不能全为空白，不 trim、改写、翻译或补全。字段缺省就是普通聊天，即使内容要求搜索、连接已启用或模型判断需要查询，也不授予此工具；显式字段无效或连接不可用则拒绝本次查询，不降级为普通 Run。该字段只接受本次用户请求，不接受模型、工具结果、历史消息或受管文件代填，也不与飞书私有读取或资料快捷入口组合。沿原入站幂等合同，将该字段是否存在及确切值纳入请求绑定；同键变更查询或从普通消息变为显式查询均冲突，不重冻、不扩权。

## 唯一工具与协议边界

Proposed：模型工具 `learn_docs_search({})`，严格空对象，任何额外字段（包括 `query`）均在本地拒绝且零出站。工具只消费当前 Run 服务端冻结的 `microsoftLearn.query`，将其原样作为唯一的远端 `microsoft_docs_search` 参数 `query`，结果中的 `query` 也使用该值。模型只能决定是否调用，不能提供、替换、扩展或追加查询词；endpoint、远程工具名称、owner、headers 和凭据也不可由模型指定。工具描述仅作说明，资格和确切出站内容由服务端强制，不依赖提示词约束。

每个新的查询 invocation 使用一个短生命周期 SDK Client/StreamableHTTPClientTransport：初始化、单页工具发现、调用一次 `microsoft_docs_search`、关闭。不缓存远程目录，不请求 roots/prompts/resources，不注册远程通知后的新增工具。发现最多 16 个工具、无 cursor，固定工具必须存在且仍声明只读并具有可识别 query 输入与 results 输出合同。其他发现项不进入模型目录。

初始容量由实测校准：单个远程响应累计 131072 字节（SDK 解析前流式计数），发现最多 16 项，搜索结果最多 10 项；标题最多 512 UTF-8 字节、URL 最多 2048 字节、每条摘录最多 4096 UTF-8 字节。整个初始化/发现/调用共用 15000ms deadline，并合并原 attempt 取消和 SDK 请求 signal。禁重定向、认证回退、自动重试、独立 SSE 重连或任意来源请求。必要的 SDK 生命周期请求也须同一固定 endpoint 与资格门。

结果为 `kind:'learn_docs_search'`、`query`、`fetched_at`、`representation:'search_excerpts'`、`items:[{title,url,content}]`；仅接受 HTTPS `learn.microsoft.com` 且无用户信息/非默认端口的来源，不跟随链接。空数组是本次搜索无返回。逐字段和总序列化容量验证失败整体拒绝，不截断。原始远程 schema、描述和重复 text 不持久化到 Run。

## 资格、接受与错误

复用 `executeReadOnlyInvocation`、原 invocation/call key/args hash、工具接受结果和 `tool_calls` 审计，不新增效果账或执行器。

每次出站派发前短事务核验当前 attempt/Run、owner、停止信号、本人的同代次连接及本轮显式查询冻结字段；缺字段或参数不合约均拒绝。网络请求不持数据库锁。结果接受事务再次验证代次，断开/取消先提交时不接受迟到成功。派发资格事务提交后已经开始的网络请求无法撤回；不把断开等同为远端零调用。连接行短期共享锁与 disconnect 删除排序，不持锁等待网络。

合格同 invocation 重放原结果，零上游调用；断开/重连后的执行重放拒绝。公开已接受事实可保留历史并供原上下文只读恢复，不复制飞书私有资料的加密、撤回或披露门；恢复不授予新查询资格。

失败保存到原接受结果与审计：`REMOTE_MCP_TIMEOUT`、`REMOTE_MCP_SERVICE_FAILED`、`REMOTE_MCP_PROTOCOL_ERROR`、`REMOTE_MCP_RESULT_TOO_LARGE`；本地资格或参数仍走既有 denied。超时/失败不报空结果、不用旧结果兜底、不自动换 slot 或重试。沿原失败收尾，不扩展可恢复错误平台。

## 验证和交付

公开协议实验、受控容量/失败注入、真实 PG 网关资格竞争、正式 native 消费者、浏览器连接到真实结果分别记录。关键正例从会话快捷入口发送含中文、空格和标点的查询词，捕获适配器真正发出的 MCP `query` 并与本轮已接纳输入逐码点比较；同时在历史、摘要、受管文件和工具结果放入可区分文本，模型传入替换/追加 `query` 或其他字段必须零出站，空对象调用也只能发冻结值。普通聊天（包括“搜索一下”）、仅启用连接、下一轮普通消息、旧 Run、重放和恢复均不能新增查询资格。另验证空/超长/不一致输入、未允许工具、其他 owner、断开和重连、在途取消/撤权、超时与服务失败、过大清单和正文、非文本或不合法来源；不是源码字符串测试。验证所有权与证据归属见 tasks.md，产品验收留给实施分支，本次仅校验合同。

实现 PR 基于独立 OpenSpec 草稿分支供审查，不合并、不归档、不关闭 #168。产品验收使用任务隔离的正式安装和实际 Web/native 路径；受控模型与真实模型推理、观察探针与原始启动方式分别记录。旧实验安装的历史 schema 差异与本功能隔离，不将修复其迁移作为验收前提，也不操作其配置、容器或凭据。一般部署迁移后不能回退为不认识新 schema 的旧写者，关闭新入口并前向修复；不修改 `.env`、真实凭据或无关安装。
