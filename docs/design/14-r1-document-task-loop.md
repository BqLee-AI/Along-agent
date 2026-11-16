# 14. R1 项目资料到简报的真实任务闭环

> 状态：Required
> 范围：现有 Web、仓颉 Harness、有限 TS 文件/MCP 工具到真实简报产物的 R1 合同。
> 不包含：功能实现、运行验收记录、通用 MCP 平台、任意宿主路径或外部 exactly-once。
> 阶段：R1；关联 #62。行为以 OpenSpec 为准，字段、接口、所有权和一致性以本设计为准。

> 授权作用域：本文单工作区选择、逐项文档按钮及冲突后重新批准适用于 legacy。新 delegation 的本人登记集合、正常直接编辑、有限输出目录创建、新增影响精确授权及零写冲突边界见 [design/20 §3、§7](20-goal-scoped-delegation.md)；两者共享对象绑定、一次许可、新回读和 unknown 边界，不模拟批准、不开放全盘。server-owned 不属于当前连接合同；设计不等于已验收。

## 1. 结论与范围

复用 #45 的 invocation 身份/结果账及非事务一次许可，#46 的唯一 native 循环、Run 权威、按钮等待和显式恢复，#47 的正式构建及精确消费者门。R1 增加有限 workspace、真实文件工具与 TS MCP、精确内容的文档批准、批准后的同 Run 恢复，以及独立的真实模型和产物验收。

采用服务端登记的专用受控 workspace；Web 从本人可用项选择，不接受任意宿主路径。读取经项目自有、只读的 TS MCP Server；提议批准为本地 PG 操作，真正替换在 TS 以 non_transactional invocation 执行。批准不是文件写入完成，文件写入不是 PG 事务效果。native 依据实际观察决定查哪些资料、如何处理冲突/失败、何时提议、写入及回读。

非目标：MCP 框架/插件注册平台、memory/向量库、任意命令/代码执行、办公生态、后台自治、多 Agent、任意 checkpoint/crash 恢复、通用 external exactly-once、任意宿主路径和个人凭据管理。既有 task 批准/time-core/取消/调度回执合同不改。

## 2. 职责边界与实现真源

| 边界           | 实现真源                                                              | 约束                                                                                                                      |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 可信工作区     | workspaces/service.ts；conversations/schemas.ts、service.ts           | 部署登记、有限相对路径和 owner；新请求选择绑定 hash 与冻结 grant，模型不能自报 root/allowlist                             |
| 工具目录与执行 | tools/catalog.ts、contracts.ts、gateway.ts、invocations.ts            | 五个业务工具、五个 workspace 工具及原事实回取；分类由服务端固定，纯读事务外 MCP、写入一次许可，不能让模型选择执行种类     |
| 唯一循环       | apps/harness/src/session/；packages/contracts/src/harness.ts          | harness/v5（路由默认 off），逐次真实函数配对及模型增量、有界来源投影、typed task/document 决议；TS transport 不规划下一步 |
| 文档授权       | approvals/document-service.ts、document-actions.ts、decision.ts；0016 | 独立批准/决议表、完整冻结内容、唯一 apply；跨模块 ID 经公共用例验证，不新增跨模块强 FK                                    |
| 文件效果       | workspaces/replace.ts；tools/invocations.ts、query.ts                 | 非事务替换、真实 applied/conflict/unknown；unknown 不补报、不重写、不产生可恢复 checkpoint                                |
| 历史与当前资格 | conversations/repository.ts、run-state.ts、harness-authority.ts       | 冻结摘要保留可读；新动作和继续重新核验登记，限定旧 task snapshot1 读取不扩权                                              |
| 外部配置与预算 | conversations/harness-config.ts、harness-model.ts                     | 现行基线部署固定 provider 与预算，Run 预算跨 attempt 累计；拟议本人选择及版本冻结见 design/22                             |
| 展示和证据     | packages/stream-protocol；Web Chat/document-approvals；ci/gates.json  | 保留七事件，不伪造 task 卡片；D8 按实际消费者及本次报告声明，不能替代真实模型或用户材料验收                               |

路径均相对 apps/api/src/modules，除表中明确列出的跨包位置。#45–#47 的底座合同和历史证据保留其适用范围，不重做为 R1 新成果。

## 3. Workspace 来源、Web 选择与权限

### 3.1 登记来源

新增 workspaces 模块，拥有服务端部署登记清单及文件边界。登记项含 workspace_id、展示 label、owner_id、canonical root、有限 readable_paths、writable_paths，以及可选 output_directories；writable_paths 必须是 readable_paths 的子集。输出目录允许在已有合格子目录内创建新文件，不授予读取该目录中未登记的已有文件。路径为相对路径，不接受任意递归 glob。登记由受信部署配置提供，不是模型生成、浏览器目录选择结果、MCP roots/list 或用户原话中的绝对路径。无需另建 workspace 数据库/文件索引。

root 是专用持久目录，明确交付给应用的资料和简报就是本能力操作的真实文件；不是工具回显或运行后丢弃的 mock。若登记的是授权副本，Web 必须展示这是受管副本，不能声称已经修改其他未登记原件。登记配置和文件来源说明属于部署文档，不把个人路径写进仓库。

服务启动验证 root 的规范路径、文件系统身份及目录控制权限。Run 接受时在既有 frozen_context 冻结 workspace_id、登记清单摘要及 root 身份；真实路径只留 TS 可信配置，不进入模型/公开 Run DTO。后续每个新动作按当前登记、当前 owner 与原冻结授权的交集校验；配置撤销、root 被替换或登记摘要变化时拒绝继续，不能在 resume 时自动扩权。

同一部署的所有 API 实例使用一致的全量登记及 workspace_id 互斥域。不同 workspace 的 canonical root 不得相同或互为祖先/后代，文件系统 root 身份相同的别名也拒绝；冲突登记不启用，不影响无 workspace 的原业务。部署不通过 bind mount 等别名把同一物理子树登记进不同互斥域；需要共享目录时另行设计，不默许每个 workspace 各自加锁后覆盖同一文件。

### 3.2 Web 与 HTTP

GET /api/v1/workspaces：本人会话认证、只读/no-store，返回 items[{workspace_id,label,readable_paths,writable_paths}]；不返回 root、宿主目录或其他 owner 项。

legacy 的 POST /api/v1/conversations/messages 可携 `workspace_id`，仅显式 execution=harness 可用；Web 选择登记项而非宿主路径。新 delegation 使用可选 `workspace_ids` 收窄本人登记集合，省略则冻结本人有效登记；两个字段互斥，不默认首项。business、未知/他人/撤销项及越界选择按请求合同拒绝；同 owner/key 的既有 Run 先按原请求重放，不重新冻结资源。

RunView 的 legacy `workspace` 与新 delegation `workspaces` 为各自接纳时的安全摘要，不是动态授权。显式集合进入请求幂等绑定；旧请求 hash 材料不因新合同迁写。GET 和同键补读只读，不执行或重新登记。

### 3.3 有限路径与 OS 边界

所有工具路径是 root 内 POSIX 相对路径。拒绝绝对路径、盘符、UNC、反斜杠、NUL、..、非规范分隔、设备文件、目录写入及未登记路径；HTTP URL 解码只由路由处理一次，不反复解码工具 JSON 字符串。目录参数只能指向有限清单中的祖先目录，不能用目录工具发现未登记内容。

安全检查包括：逐段 lstat 拒绝 symlink/reparse 等重定向；realpath 后以路径组件判断仍在 root 内，不能使用 startsWith(root)；只接受普通文件，并拒绝多链接文件以避免硬链接引入未授权内容。Linux 正式路径使用 O_NOFOLLOW 打开最终文件并 fstat 验证实际对象；每次读/替换前重新核验 root、父目录和最终目标。写临时文件只在受控目标父目录，随机独占创建、不跟随现有链接。

这些检查依赖专用 root/目录拓扑不受不可信主体写入。应用所有写者必须经同一 workspaces 公共用例和跨实例的 workspace 写互斥；PG advisory lock 这里只协调应用写者，不使 FS 变成数据库事务，也不限制宿主 root。登记为任意宿主可写目录、允许非协作程序在最终核验与 rename 间换目录/换目标时，此实现不能宣称有原子 CAS/沙箱保证，应拒绝该部署。需要该能力时须另评审基于目录句柄的 OS 级实现，不能用增加一次 realpath 掩盖竞态。

## 4. 五个有限工具及结果合同

全部参数使用 strict zod，服务端忽略不了也不接受 owner/root/allowlist/执行种类等额外字段。工具只能操作当前 Run 已冻结的一个 workspace，因此工具参数不再重复 workspace_id。

| 工具                      | 参数                                   | 接受的领域结果与边界                                                                                                                                                                                 |
| ------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workspace_list            | {path}，根目录用空串                   | 返回真实且已授权的直接子项 path/kind，以及登记文件当前缺失/不可读的明确观察；不把清单登记本身当文件存在，不遍历未授权项                                                                              |
| workspace_grep            | {path,literal}，literal 非空           | 在授权子树普通 UTF-8 文本中做区分大小写的字面量逐行搜索，返回 path、1-based line、原行文本、该文件 version；逐文件失败单独列出，不能把不完整搜索说成无匹配。不引入 shell/regex 执行器                |
| workspace_read            | {path}                                 | 全文读取，返回 path、version、byte_length、精确 content。重复调用同 invocation 重放原快照；真正回读必须新 slot/new invocation。grep/部分读取不能冒充可修改全文基线                                   |
| workspace_propose_replace | {read_invocation_id,old_text,new_text} | 依据同 owner/Run/workspace 的已接受全文读取，生成一次精确字面量替换及冻结批准；old_text 非空且在基线中恰好一次，old_text/new_text 不同；未匹配/多处匹配/基线已变化时返回明确观察，不偷偷 replace-all |
| workspace_apply_replace   | {approval_id}                          | 仅执行本人同 Run 的已批准、冻结文档提议；不接收新的 path/version/content。走 non_transactional 一次许可；返回绑定原批准和 invocation 的 applied、确定的 conflict/未写入观察，或 unknown              |

### 4.1 精确内容与有界输出

version 为完整原始文件字节的 SHA-256；mtime 不能代替内容版本。对文件使用严格 UTF-8 解码并保持 BOM、CRLF/LF、空格和未修改区段；拒绝无效 UTF-8/孤立 surrogate 输入，不静默替换字符。只支持当前阶段的文本文件，不声称 Office/二进制兼容。

替换通过基线原字节的前缀＋UTF-8 new_text＋后缀构造完整目标字节，逐字节保留未命中的内容；批准冻结的是这个完整目标，不是一个可在将来不同文本上重新匹配的指令。全文版本变化时不自动 rebase；重新读取和新批准才可产生新动作。内容不变但 inode/父目录不符合受控打开规则同样不能继续。

不随意发明新的页数/文件大小阈值。工具输出必须同时满足当前 accepted_result 安全上限240000字节、wire 1MiB、快照64个工具引用及可序列化模型上下文边界；文档批准完整预览/确认请求还要满足现有HTTP body 131072字节。首次读/提议前按实际序列化材料检查；超界明确返回有界错误，不静默截断、不部分写入。list/grep 超界时返回明确的“范围过大，缩小目录/搜索词”观察，不假报穷尽搜索。未来若要支持更大文档再独立设计分段合同，不在这里增加平台。

### 4.2 可恢复观察与终止错误

新增有区分的 workspace 结果 payload（具体 schema 由 tools/workspaces 公共 DTO 定义），包括 list/search/read、document_approval、applied，以及 operation_error/conflict。可恢复的已授权文件缺失、读取失败、字面量不匹配和版本冲突，用 status=ok 的“操作未完成”领域观察表达，包含稳定原因及必要的目标引用；它不是写入成功，resultKind 仍为一般已接受观察。native 将它交给下一轮模型，由模型改变位置/查证/重新读取，而不是 TS 指定下一工具。

越界/owner/Run/冻结授权失败仍为 denied，终止该运行；不可安全继续的执行故障仍 failed；非事务效果无法确认仍 unknown。不要为了让模型继续而吞掉权限错误或 unknown。TS 的 done 守卫必须理解 applied/回读证据，不能把“status=ok 的冲突观察”当交付成功。

### 4.3 MCP 只读调用不占用长事务

workspace_list/grep/read 分类为 read_only：短事务验证 attempt→Run→invocation 资格，completed 直接返回原快照；reserved 的真实 MCP 调用在事务外执行并接入本 attempt 的取消 signal。任何阶段都不持 Run/attempt/invocation 锁等待 Server。

调用返回后以相同锁序短事务裁决：已 completed 则返回首次接受的原快照，不比较或覆写为后一次读取；仍 reserved 且资格有效才接受结果并追加审计。取消、撤权或旧 attempt 失效先提交时，不接受迟到数据推进 Run，也不披露被撤权内容。首次接受前同引用可能冗余读取，但只接受一个不可变结果；接受后重交零 MCP 调用。纯读没有外部修改效果，不走写效果 unknown 许可；真正 apply 仍走 non_transactional。

## 5. 文档批准：授权与写入分离

### 5.1 所有权与最小持久化

approvals 新增专用 document_approvals，而不是修改旧 approvals 的 create_task/cancel_task 形状。它保存文档授权事实，不保存第二份工具执行结果账：

- id、owner_id、conversation_id、run_id；
- workspace_id/冻结登记摘要、relative_path、base_read_invocation_id、base_version；
- exact_new_content、new_version（完整目标字节摘要）；
- 冻结 presentation_version/presentation_hash；
- state=pending|approved|rejected；
- apply_invocation_id，可空、一次绑定后不可改变，且非空唯一；
- replaces_approval_id，可空，引用同目标的明确零写 conflict 前驱，非空唯一且创建后不可改变。

不新增 TTL/后台审批清理、通用 policy engine、task/time 字段或文件事实数据库。基线全文来自既有已接受 read 结果，批准行只持有必要的冻结目标内容；拒绝和批准决议不可反转。当前只允许本 Run 内的提议；Run 终态/取消后按钮不能授权新文件动作。

workspace_propose_replace 是 local invocation：先按 tools 规则锁 attempt→Run→invocation，再校验基线引用；创建 document_approval、接受提议结果及追加审计同 client 事务提交。文件当前版本核验不是 PG 原子条件，创建后仍可能改变，所以 apply 必须再核验。跨模块调用 approvals 公共用例，不导入其 repository。

### 5.2 预览与按钮 API

新增独立路由 /api/v1/document-approvals/{id} 及 actions/confirm、actions/reject，继续 session/CSRF、owner、strict body、统一 body 上限及 request_id。

GET 返回 kind=document_replace、state、原 Run、相对目标、基线/目标版本及冻结预览。预览展示替换前后差异和完整目标内容；不能用摘要或模型叙述代替实际将写内容。服务端可由基线读取＋冻结目标生成 diff，不另存 diff 事实。

confirm body={presentation_hash,seen_content,idempotency_key}：seen_content 是本版本冻结预览正文，哈希绑定 workspace/相对目标/base_version/new_version/确切目标内容及模板版本；服务端重建并比对，失败 PRESENTATION_MISMATCH，不授权也不写文件。这里不借用 task 的展示编码规则；文档空白是内容，不做排版归一。成功只将 pending→approved，返回批准事实；重复按钮回原决议，不写文件、不新建 task/执行调用。reject body={idempotency_key,reason?}，pending→rejected，批准后不允许用 reject 伪撤销已授权或在途写入。

确认/拒绝的持久幂等只在本操作内绑定 owner、目标、规范请求摘要和裁决；同键异目标/异内容409。实现沿现有持久动作请求关系模式，具体窄表 document_approval_decisions 保存上述绑定，不做通用 action 日志或新的效果账。锁顺序为 attempt→Run→提议 invocation（需要时）→document_approval→决议记录；confirm/reject 不在持有 approval 锁后反向申请 Run 锁。

### 5.3 同一批准只允许一个写调用

workspace_apply_replace 预约时须确认该 approval 属于当前 Run 且已批准，将 apply_invocation_id 与原 invocation 原子绑定；同批准另一个 invocation 一律拒绝，不能通过新 slot 绕开 unknown/重放。预约回答丢失仍以原 slot 定位。非事务 dispatch 在一次许可事务内再次验证当前资格、approved 状态及该绑定，之后才提交 reserved→unknown。

这需要给既有 non_transactional coordinator 增加一个可信、窄的事务内 dispatch 校验挂点，调用 approvals 公共授权核验函数；不是新协调器，也不移动已完成的 #45 语义。应用文件锁在动作执行阶段持有，不能让 confirm 在长时间文件操作中维持 PG 事务。

批准 state=approved 仅表示允许这个冻结动作，不表示执行过。实际执行/接受结果唯一真源仍是 tool_invocations；页面必须同时区分“已批准，尚未执行”“已写入并回读”“效果未知”。

### 5.4 版本冲突后的新批准

旧 apply 已接受可信的 workspace_conflict、明确证明写前核验失败且零 rename 后，模型可以重新全文读取、重新提议并等待新的批准。新提议使用该 conflict 之后的新 invocation 全文结果，并属于同 owner/conversation/Run/workspace/规范相对目标；TS 在原本地提议事务中定位尚无后继的冲突链尾，自动设置 replaces_approval_id，不接受模型自报替代关系。唯一约束防止同一前驱分叉。

旧批准仍是 approved，原 accepted_result 和审计不变；新批准不是旧批准的撤销、改写或成功回执。同目标尚有未尝试的 approved、reserved 或 unknown 动作时，不允许另起无前驱提议绕过它。只有上述确定零写 conflict 可以被后继覆盖；未知、通用失败或仅仅当前 hash 相同均不能建立替代边。

## 6. 文件替换、取消和 unknown

### 6.1 有证据的正常执行

只有明确取得既有 reserved→unknown COMMIT 回答的执行栈可进入动作。TS 获取跨实例 workspace 写互斥，重新验证受控 root/父目录/目标，用实际打开文件全文 hash 比较 base_version。冲突或确定写前失败返回绑定 invocationId/argsHash 的确定领域证据，零 rename，不改基线文件。可恢复 conflict 用明确的 conflict 结果，不能被通用 NotAppliedEvidence 抹成无信息失败。

匹配时：在同父目录独占创建临时文件，写入冻结的完整目标字节，保持原普通文件权限，fsync 临时文件；持锁复核目标仍为基线对象/版本，再以同文件系统 rename 替换，fsync 父目录；重新安全打开目标全文回读，验证字节恰等 exact_new_content/new_version。成功的 EffectEvidence 在当前执行栈绑定 invocationId/argsHash、目标/版本和安全 evidence_ref，随后由既有协调器接受并追加审计。PG 接受提交与 FS rename 不原子。

服务端回读证据不能代替 Harness 回读：native 必须用新的 workspace_read invocation 核对保存后的实际内容。done 守卫要求本 Run 每个 approved 文档提议满足其一：原绑定 apply 已接受 applied，且之后的新 read 核对该保存版本；或原绑定 apply 已接受明确零写 conflict，并沿 §5.4 的唯一替代链到达真正 approved、applied 且独立回读的后继。链中被覆盖的动作都须有明确零写 conflict，不能跳过 pending/rejected、未尝试或 unknown。

因此 A 冲突→新读→批准 B→B 写入→新读可以完成；B 未批准、未执行、被拒绝或未知则不能完成。页面与最终答复保留“原修改因冲突未写入，重新批准的修改已保存和核对”的真实区分，不能声称 A 成功。回读发现新的受控修改时，必须继续查证或明确失败，不假报内容仍保存。

### 6.2 不确定窗口

rename 前且可信执行器能证明零写：接受明确未生效观察/失败；不能把任意异常都断言为未写。rename 可能发生之后、fsync/回读失败、动作响应丢失、PG 接受 COMMIT 不确定或进程退出：没有可验证且绑定本 invocation 的结果则 unknown。重交只回 unknown/已接受结果，绝不重做文件替换。

本阶段不建立 sidecar 文件回执、文件系统数据库或 background reconciler；不提供凭当前文件内容自动将 unknown 改为成功的能力。即使新读取 hash==new_version，也只证明当前产物，不能证明哪个 invocation 写过。原 Run 诚实失败/未知；人工或独立只读检查可了解产物，但不制造原动作回执、不成为任意恢复入口。

### 6.3 取消线性化

非事务一次许可提交是本动作的 dispatch/开始边界。取消先提交则无法取得新许可；许可先提交的在途动作可能已发生或完成，取消不伪撤销它。取消提交后不得开始新的模型轮、预约、MCP 调用或文件写动作；TS abort/关闭在途连接，但不能承诺 kill 回滚已经发生的 rename。迟到的可信效果仍可被 #45 结果账保存，不能改 Run cancelled、披露已撤权内容或启动下一步。

## 7. Native、bootstrap、快照与七词 Web

### 7.1 必须演进的合同

TS contracts、native parser、start/reply 构造和正式消费者整体使用 harness/v5（路由默认 off），不保留 v4 并跑或旧二进制回退。task/document 的显式决议 union 沿用原合同，snapshot仍为version2；保留模型增量和对应的串行后续拉取，v5 保留 v4 的额度计量、原观察视图与流式失败的累计记账，见 [design/18](18-r2a-harness-context.md)。

start.approval 变为有明确 kind 的 union：

- task：保留 approval_id、原五状态、task_id、successor_id；consumed 必须有真实 task_id，既有语义不变；
- document：approval_id、status=pending|approved|rejected、apply_invocation_id（可空），approved 只授权后续 workspace_apply_replace，不附虚假 task_id/已写入标记。

start 增加可空 workspace 安全上下文，只含 workspace_id、展示名称、有限相对读写范围，不传 root。snapshot 新版本只记录消息/已接受工具引用、next_call_no、usage、waiting 的 invocation/approval 引用；批准 kind 由 tools 公共的已接受提议引用及固定 tool_id 核验，不让 native 声明的 kind 决定查哪张表。

不需要为 tool_invocations 另增一套状态/结果表。其 approval_id 当前没有 FK，可继续表示对应冻结批准；tools 按不可变 tool_id/版本识别 task/document receipt，分别调用 approvals 公共冻结读取。旧 receipt 原样读取；新增 document receipt 有明确判别字段。readRunInvocationStates 向 conversations 返回 typed approval reference，authority/run-state 不直接读取 tools 私表。tool_calls.approval_id 现有 task FK 不改：文档调用该列为空，其 document 批准可由 invocation 引用定位，不能把文档 ID 填入原 FK。既有 outcome_kind=approval_pending 继续表示需要等待，不能据此假定一定是 task。

### 7.2 批准后恢复

native 收到 document_approval 的真实接受结果后，沿原 snapshot→suspend 流程挂起同 Run。TS 验证原提议 invocation/批准、记录等待并 ack。确认可以先于挂起；resume 从所属 approvals 公共决议读取当前状态，不依赖通知，不修改提议接受结果。

pending：409、不启动；approved：同 Run 唯一新 attempt，native 纳入授权观察，自行选择原批准的 apply 工具，随后回读；rejected：终止原动作、不重提同义修改。原 task consumed/rejected/expired/superseded 行为保持。每次新提议仍需要其自己的批准；审批通过不扩大工具/文件范围。

RunView.waiting 可为文档等待增加明确的 approval_kind=document 字段，既有 task 响应形状保持；更新所有 Web/schema 消费者。七词不增加，文档仅发既有 approval_required，使用约定 card_id=document-approval:<id> 和冻结 presentation_hash 跳转独立文档批准页；不发要求 wall_time 的 card.proposed，不填假时间字段。刷新通过原 Run 和事件补读定位原批准；确认/拒绝后回原会话显式继续，不发新消息/新 Run。

### 7.3 unknown 的正常终结

现有 native 会把非 ok invocation 放进 toolRefs 后 checkpoint；这对生产 unknown 不成立。修改为：收到 unknown 后不把未接受引用加入可恢复 snapshot，不发送新的 snapshot/suspend，直接 finish(failed,TOOL_EFFECT_UNKNOWN)。TS failed 终结保留真实 unknown invocation、已接受输出和唯一失败事件；不要求 unknown 伪装 completed。model/reserve 守卫继续阻止后续动作。普通 checkpoint、failed Run 和 unknown 不可 resume，GET 只读。该修改不扩大 #47 的 unknown 证明范围，后续须新增实际产品消费者证明。

### 7.4 简短计划与预算

native 在工具提议同时存在 model content 时，可通过原 answer 通道持久展示该轮简短可见计划/进度，再执行工具；内容是模型给用户的简短计划，不是隐藏思维链。native 纳入真实结果后可调整计划，不新增 plan 表/规划器。受控模型测试只证明结果反馈机制，真实模型验收另看实际选择差异，不能要求固定措辞或唯一工具顺序。

当前生产 maxIterations=8 对参考验收链可能不足：list、grep、一次失败读取、两份证据读取、目标全文读取、提议、apply、回读、最终回答已经需要10个模型轮。服务端沿现有 HarnessServices 预算项提供足以容纳完整参考任务的显式运行配置并在 Run 冻结；默认值由该真实流程校准，不把8当 R1 已足够，也不在 Web 接受任意提权预算。测试用较小预算验证停止。累计迭代跨批准继续、不重置；usage 缺失永久未知，不估算 token/费用。

## 8. TS MCP 选择与真实消费者

推荐官方 SDK v2 的 @modelcontextprotocol/client 和 @modelcontextprotocol/server，通过 stdio 连接一个项目自有、只读的 TS workspace Server。官方 README 明示 v2 已稳定、支持 Bun，并使用分包及 Standard Schema；不根据旧资料再把 v2 写成 alpha。参考：https://github.com/modelcontextprotocol/typescript-sdk；client stdio/listTools/callTool/close：https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md。

Server 只提供 list_files/search_files/read_file，调用同 workspaces 所有的路径/文本规则；不提供任意 read、write、shell、采样、模型调用、动态 roots 或自发现插件。工具描述及模型允许名由可信 TS 固定清单发布；MCP listTools 只核对这三个实际服务能力，不能因 Server 宣告新能力就扩权。

client 归 tools 的 mcp-workspace adapter；Server entry 放 apps/api 内，使用编译后的固定入口和固定 Bun 可执行路径启动，不运行 npx/下载命令。可按 attempt 懒启动，关闭/取消时 finally 关闭 Client/transport。子进程只取得选中 workspace 的受控只读配置和必要运行环境，不继承 DATABASE_URL、模型 key、认证 secret。stdout 只 JSON-RPC，不把日志或宿主 root 混进模型观察。

workspace_list/grep/read 走真实 initialize→listTools→callTool，返回实际文件内容后严格解析、范围过滤并接受到既有 invocation 结果账；直接读函数用于 Server handler，不给 gateway 保留绕过 MCP 的生产 fallback。MCP 只读失败可作为领域读取失败反馈模型；畸形协议/不可信结果不能伪装有效读取。

不要求使用第三方通用 filesystem Server：它常携带更广写工具、路径策略或额外配置，反而扩大当前信任面。这里自有的只是三个具体工具 handler 和少量边界适配，JSON-RPC/协商/transport 使用成熟 SDK，不自研 MCP 协议。初始依赖候选为正式发布的 @modelcontextprotocol/client 与 @modelcontextprotocol/server 2.4.0，实施时在单一 bun.lock 锁定并保留适用许可；实际安装、Bun 兼容与镜像验证通过才可采用，不凭版本声明声称已经接通。client 的发布元数据见 https://registry.npmjs.org/@modelcontextprotocol/client/2.4.0 。现有 Zod3 业务 schema 不整体升级，仅在 MCP 边界适配 SDK 所需 schema，并通过 Bun1.4.2/正式镜像验证。

真实证明必须是 Web→TS→native 选择→gateway→实际 SDK Client/TS Server→临时持久真实文件→模型观察→下一步/回读；从结果和文件状态关联 Run/invocation。单独 initialize/listTools、Server 手工 echo、mock callTool 或日志里写了 MCP 均不构成用户验收。移除 callTool/替换真实结果时，同消费者必须失败。

## 9. 模型配置与运行前提

现行基线复用 loadHarnessServices/createHarnessModelTransport 和部署级 HARNESS_MODEL 配置。拟议本人接入及逐 Run 选择见 [design/22](22-model-provider-settings.md)；保留单工具提议、真实 usage、abort 和仓颉唯一循环，native/MCP 不获得 Key，TS 不增加规划/Agent 循环。

模型消息使用标准 assistant `tool_calls` 与配对 `tool_call_id` 的 `role=tool` 结果，由 native 构造；不能把工具提议写成普通 assistant 文本，让模型照抄而不实际调用。transport 请求 `parallel_tool_calls:false`，native 也要求逐次等待真实观察；供应商仍返回多个调用时拒绝整个响应，不丢弃调用或在 TS 拆出第二个循环。

固定启动模型仅为现行基线；拟议切换后新 Run 绑定本人配置版本，旧部署须由管理员明确指定目标用户导入，不能共享或自动启用；旧 Run 按 design/22 安全处置。缺实际运行依赖仍明确失败，无 fixture fallback。

真实模型验收需要获授权且具备 function calling 能力的兼容服务，以及确有需要时的安全凭据引用；由用户/部署负责人提供，Agent 不代选/购买/写 .env。部署、SDK、Docker、PG、隔离测试资料都属于实现任务可解决的工程前提，不推给用户。

## 10. 模块、迁移与交付切片

| 所有者           | 责任与主要文件                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workspaces       | 登记、路径/文本/版本规则、有限 list/search/read、受控替换；modules/workspaces/service.ts、replace.ts、routes.ts、mcp-server.ts；不拥有模型循环或工具结果账                                      |
| tools            | 静态五旧＋五新定义、strict 输入/结果、MCP adapter、既有 reservation/local/non_transactional coordinator、typed 批准引用/接受结果/审计；修改 contracts/schemas/result-schema/gateway/invocations |
| approvals        | document_approvals、按钮决议/冻结预览、一次 apply 绑定及公共授权/决议读取；新增窄文档用例文件，保留旧 task create/confirm/revise                                                                |
| conversations    | 选择/hash/Run 冻结/资格/等待/终态及公开只读结果；service/schemas/contracts/run-state/tool-binding/harness-authority/config                                                                      |
| contracts/native | harness/v5（含只读路由帧，路由默认 off）、typed 决议、workspace 安全上下文、真实增量输出/有界观察消费/unknown 正常失败；packages/contracts/src/harness.ts、apps/harness/src/session/            |
| Web              | 现有 Chat 的 workspace 选择、文档批准链接/原 Run 继续、实际结果展示；新增文档批准页及 HTTP DTO，不能引用 API 源码                                                                               |
| integration/CI   | 原根入口和五门；添加正式文件/MCP 产品消费者及负例，按实际证据扩 D8，不另建 job 平台                                                                                                             |

0016 新增 document 批准/决议关系、模块内引用、必要索引和不可变约束。Run workspace 冻结引用放既有 frozen_context，既有 waiting UUID 列复用。不能修改0014/0015、伪回填旧 workspace/文件结果或改写 completed invocation。跨模块确认/结果/决议引用通过公共用例验证，不增加跨模块强 FK；D1 绿色不代替 SQL 所有权/锁序审查。

部署先停旧写者，保留旧数据只读，应用新增迁移，发布同批 TS/native/Web。历史 task v1 checkpoint/receipt 的只读解析保留；历史已等待 task 通过明确的版本化快照读取迁移为等价新 bootstrap，仍只恢复原 Run/预算/工具范围，不能给历史 Run 加 workspace。那是历史事实读取，不是保留旧执行器。新事实接纳后不降回不认识 document 结果的旧写者；故障停写并前滚。workspace 无效不阻断无 workspace 的原业务/healthz/D7，readiness 不扩成必须持有模型凭据的全站门。

实现分为独立可评审切片：①可信登记/公开选择与有限安全只读＋SDK真实探针；②文档冻结批准/决议/单 apply 绑定及数据迁移；③工具端到端接入、正式原生协议、同 Run 文档恢复与 unknown 正常终结；④受控 FS 写入/真实 read-back/done 守卫；⑤Web 全链与生产镜像/MCP 打包；⑥原根合同扩展、真实 provider 变体任务验收与证据收口。每片先保护对应可观察合同；SDK 未知先实际探针，不能拿编译失败冒充业务 Red。完整 R1 以真实产物和变体验收取证，接口/基础能力不能单独宣称用户任务完成。

## 11. 用户能力验收与证明边界

规范定义必须达到的行为；运行证据须来自对应正式构建及真实环境，分别记录在验证记录或 PR 中。开放式模型任务不锁死唯一工具顺序或中文措辞，受控合同不能替代真实任务验收。

| R1 原标准                                                   | 唯一主责/协作                                               | 具体可观察检查                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通过现有 Web、真仓颉、真模型、真 TS 工具、真产物            | conversations/Web 集成负责人；native、tools、验收负责人协作 | 在真实会话/CSRF 下从 Web 选择 workspace 发起任务；关联本次 conversation/Run/attempt/invocation；正式 native 请求获授权真实 endpoint；最终真实文件字节与独立回读一致。受控模型合同报告单列，不冒充此项                                  |
| 资料位置、冲突日期、读失败改变选择；无硬编码序列/隐藏 Agent | native 主责，workspaces/tools 提供观察                      | 参考资料含相互矛盾日期与明确来源，模型须查原始证据；再分别改变目录位置、最新证据日期、一个已授权文件读失败。保存真实模型请求中的已纳入观察与后续不同检索/查证选择；只允许用户可见短计划，不收集隐藏推理链；TS 只执行单步工具/transport |
| 列目录/grep/读取/修改/回读真实且有限                        | workspaces 主责，tools/MCP 协作                             | 每个工具读取/操作实际文件；不存在、无匹配、多匹配、搜索不完整均返回明确观察；修改基线取已接受全文；写后 native 使用新 invocation read，不能以 replay/参数回显通过                                                                      |
| 简短可变计划、多轮结果反馈                                  | native 主责，Web 展示                                       | Web 可见模型短计划/调整，下一轮请求包含真实工具结果；对冲突与失败变体发生可解释行动变化，而非后端固定顺序或固定答案                                                                                                                    |
| 文档回读正确、无关内容保留                                  | workspaces 写入主责，conversations done 守卫                | 目标包含独立前后段、中文、空白、BOM/CRLF代表项；审批预览、保存字节、服务端检查、新 native read一致；未改区段逐字节相等。只有 hash 相同而无绑定动作回执的 unknown 必须仍未知                                                            |
| 越界被拒                                                    | workspaces 主责，identity/conversations/tools 协作          | 绝对路径/..、相邻 root 前缀、未登记文件、符号链接内外跳转、硬链接、撤销登记、他人 workspace/批准、旧 attempt；以范围外字节未披露、实际外部文件未改变为断言，不只看403                                                                  |
| 预算停止、取消后不新增步骤                                  | native预算主责；conversations取消主责                       | 小迭代预算在下一轮前停止；已得 usage 超限不再工具；批准继续不重置计数；实际 model/MCP/FS 动作计数证明取消先提交后无新 dispatch。许可先提交按既成/未知保留，不虚称回滚                                                                  |
| 至少一条真实 TS MCP 调用                                    | tools/MCP主责                                               | 正式 Client/TS Server initialize/listTools/callTool，返回实际文件数据被 native 消费并影响后续请求；实际改变源文件会改变消费者结果；移除调用或结果纳入，同一个正式消费者失败                                                            |
| 必要批准回同 Run；不宣称任意恢复                            | approvals授权主责；conversations/native恢复协作             | 提议→真实冻结预览→确认/拒绝→原 Run 唯一 attempt+1；pending拒绝、早确认/并发/丢回答/换键不重复；approved不等于写入，拒绝不绕过。未知直接正常失败、无 unknown checkpoint，普通/终态恢复拒绝                                              |
| 冲突处理绑定 observed version、exact content、approval      | approvals主责，workspaces执行                               | 分别在 read后、批准前、批准后改变文件；原 apply只报冲突/零写，不对新内容重匹配。新修改需新读/新批准；同批准换 invocation 不可第二写                                                                                                    |
| 稳定模型配置、缺前置真实失败                                | conversations model transport主责                           | 现行基线使用固定部署模型；拟议本人选择、不可变绑定和旧部署显式导入见 design/22。缺依赖明确失败；不启动 fixture/TS Agent                                                                                                                |

### 11.1 确定性门与真实任务评估

受控模型响应验证权限、精确字节、版本冲突、批准、累计预算、取消、unknown及结果反馈合同；它只替换 model transport，不替换正式 native/MCP/FS。未知 SDK 先实际探针，随后纳入长期真实消费者。

原 bun run test:contracts 保留既有15消费者并加入本地/签名HTTP文件场景；case ID、实际报告唯一通过、必要步骤负例沿 #47 机制追加，不修改旧证据定义、不新增独立CI平台。实际 unknown 产品场景须证明正常 TOOL_EFFECT_UNKNOWN、无后续模型/新slot/二次写，不能再仅引用 #47 测试专用对端子合同。

真实模型评估在独立获授权环境运行，参考任务及三类变体均记录实际结果；不依赖个人生产数据库，不自动购买调用或继承开发者凭据。失败就记录失败及原因，不用受控fixture补齐。

### 11.2 验证责任与证据要求

合同设计须通过独立审查、`openspec validate define-r1-document-task-loop --strict`、仓库文档/格式检查及既有合并门；PR 记录实际执行和未跑项，不把设计校验当作功能验收。

实现集成负责人统一执行 `bun run verify`、`bun run test:contracts`、`bun run test:integration` 及受影响的 scheduler/迁移/空环境门，当前 required checks 为 checks、database、integration（design/13 §4）；同时负责补齐上述矩阵的真实 Web/模型/文件/MCP 证据。模块负责人已完成的有效验证直接复用，只补集成缺口；记录本次构建版本、关联 ID、文件前后/回读版本和实际调用结果。

A1–A4 是原任务/时间/调度用户标准，本次只要求其原合同回归，不把文档批准硬说成 A2 task 成功，也不把有限文件 unknown 说成已经证明任意 A3 恢复。D8/D10承载本次新增 R1 验收，其他 D 项按具体风险回归。

### 11.3 真正的用户侧前置

真实材料验收需要：①对目标项目资料和简报具有权限的实际输入，以及由用户/部署负责人确认其受管原件/副本语义；②获授权的兼容模型服务配置，确需鉴权时经已有安全渠道提供 secret 引用。无需用户帮助实现 SDK/文件锁/容器/迁移，也不应要求用户先建设记忆平台或选整套办公生态。

只有完整用户矩阵与既有安全回归取得真实证据，才能在收口 PR archive 并 Closes #62；非收口改动只 Refs #62，不提前归档或关闭。

## 12. R2-A 观察投影与原事实回取（#83）

[Required] [design/18 §4–§8](18-r2a-harness-context.md) 定义本闭环的容量管理；R1 五工具及本篇完整基线/精确批准/唯一 apply/新全文回读合同不弱化。来源读取返回原接受版本而非当前文件，context_slice 不可作为全文替换 read_invocation_id，也不能满足 apply 后新的 workspace_read；旧冲突、失败、zero_write 和 unknown 不因投影改成成功。

read_run_observation 是静态网关工具，不是 MCP Server 的第四个文件操作，不增加任意文件访问或通用 registry。low/medium/high 仍仅模型元数据，执行资格来自冻结 allowlist、strict schema、当前 Run/attempt/owner/精确登记、批准与 permit。v5/snapshot2 不改批准预览、HTTP body 门或七词；合同校验不替代真实任务。
