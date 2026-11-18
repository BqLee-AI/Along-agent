# 17. R1 会话历史与只读恢复

> 状态：Required；R1 会话历史发现与只读恢复合同。
> 范围：服务端会话发现、可见消息/Run索引、批准与结果读取、Web稳定深链和只读恢复。
> 不包含：#70视觉/全站目标导航、账户机制修改、搜索、第二份任务事实表、自动执行恢复及R2。
> 阶段：R1 日常可用性第三步；行为归 conversations capability，既有执行、授权和身份合同不变。

> profile作用域：历史GET零执行对全部Run不变。手动资料/逐项批准属现行/legacy，离开断流也适用于早期request-bound；新目标/接续与冻结生命周期见 [design/20 §1、§5–§9](20-goal-scoped-delegation.md)（Proposed）。只有server-owned仅断订阅，旧/先前Run不随新部署改义；新界面不消费旧pending、不回填权能或重连自动POST。

## 1. 结论与事实依据

Required：清空临时状态且不保留旧URL，退出后同账户登录，仍能由服务端找到原会话、原话、指定Run、全部可见回复、批准及结果。历史导航不得产生执行或自动业务POST。

历史恢复组合已存消息、Run/attempt 外部事件及所属模块的批准/结果投影，不依赖客户端缓存。`updated_at` 不是持续活动钟；最终 assistant 消息没有可信的 Run 引用，不能猜测归属或再次拼接到 Run 回复。

三个有界集合负责服务端发现、可见消息和 Run 索引；旧事件查询仅增加可选 Run 筛选，任务批准详情提供真实结果引用。Web 经 HTTP 和共享 strict DTO 消费已有事实。仓颉仍是唯一 Harness，TS 仍拥有事实与授权。

实现责任与源码入口（运行证据单独记录）：

| 责任                                              | 位置                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 无尾斜线集合与既有深路由接入                      | `apps/api/src/http/app.ts`、`apps/api/src/modules/conversations/routes.ts`                       |
| owner/parent 作用域、稳定分页与可信原话投影       | `apps/api/src/modules/conversations/history/history-service.ts`、`history/history-repository.ts` |
| 用户原文与新 Run 输入引用、终结消息的既有合并规则 | `apps/api/src/modules/conversations/lifecycle/admission.ts`、`run/run-terminal.ts`               |
| 任务批准详情和决议共用真实结果投影                | `apps/api/src/modules/approvals/reminder/repository.ts`、`reminder/service.ts`、`decision.ts`    |
| 四个查询索引及真实结构核验                        | `infra/migrations/0018_conversation_history.sql`、`scripts/local/baselines/0018.sql`             |

## 2. 所有权与方案取舍

conversations拥有集合、消息/Run关系、owner校验和事件读。approvals拥有批准/决议及对外冻结详情；tools拥有已接受工具/效果证据；结果继续经公共读取组合，conversations不直读其他模块私表。Web不导入API源码，类型以顶层import type使用具体命名类型。

新增 conversations capability 比向 agent-runtime 追加更合适：该切片横跨 business 与 harness，核心是模块已有消息/集合读取，不是执行生命周期变化。引用原 agent-runtime、workspaces 和 identity 不变量即可，不重定义执行、授权或身份，不新建服务/框架。

拒绝仅保存URL/sessionStorage：无法满足服务器发现。拒绝offset和每页重算最新活动排序：新插入/旧运行更新会搬页。拒绝物化历史/新任务表/持久分页会话：增加第二生命周期且无本期证据。选择建立时间keyset；活动时间真实展示但不用于会移动的排序。

## 3. 列表、排序与cursor

### 3.1 HTTP与共享DTO

新增GET /api/v1/conversations、GET /api/v1/conversations/{cid}/messages、GET /api/v1/conversations/{cid}/runs。认证/no-store，GET不需要CSRF。

新集合query严格限定cursor?、limit?；runs另允许run_id?点查，run_id与cursor互斥。limit十进制整数默认20，1–50；超界400，不静默夹取；cursor非空、最多2000字符。重复已知参数、未知参数、非法cursor为400 VALIDATION_ERROR。作用域由服务端actor决定，不接受owner参数。

runs?run_id={rid}返回同一Page形状，成功恰好一项且next_cursor=null；缺失或不属当前会话404，不通过扫描所有分页定位深链。父会话先沿既有403/404边界核验。

packages/contracts/src/conversations.ts定义并导出以下strict schema和对应类型：

- ConversationListItem：conversation_id UUID；status=open|closed；title string；title_message_id UUID|null；created_at UTC timestamp；last_activity_at UTC timestamp|null。
- MessageHistoryItem：message_id UUID；role=user|assistant；content原样string；created_at UTC timestamp。
- ConversationRunHistoryItem：run_id/conversation_id UUID；execution=business|harness；status既有RunStatus；created_at、ended_at|null；original为判别联合：available带message={message_id,content,created_at}与source=input_message|idempotency_reference；legacy_unavailable不带伪内容；invalid_reference明确标记完整性异常。
- ConversationListPage、ConversationMessagePage、ConversationRunPage：严格items数组和next_cursor string|null。
- ConversationListQuery、ConversationMessagesQuery、ConversationRunsQuery及内部版本化cursor schema。timestamp按真实PG UTC微秒输出/校验，不通过JS Date往返生成分页键。

不在新DTO中塞无界events、所有工具原文或动作权限。RunView不变，can_resume仍由当前Run读取和原动作服务决定。旧ThreadEventSchema留在stream-protocol；contracts仍只依赖自身与zod，不为共享历史合同扩包图。

### 3.2 排序与字段事实

列表按(conversations.created_at DESC,id DESC)。此字段是初始接纳事务的真实建立时间，当前初始user message/Run与conversation同事务使用DB now()产生；界面明确标为“按建立时间”，不冒充最近活跃排序。消息、Run集合分别按(created_at ASC,id ASC)。UUID用PG uuid比较作为确定tie-break。

last_activity_at取本人本会话可见user/assistant消息created_at与Run created_at/ended_at的最大值，无事实为null；不能取conversations.updated_at、内部snapshot时间或模型叙述。它表示最新已存消息/Run事实时间，不承诺每次状态转移都有独立更新时间。

title从最早的user message取首个非空显示行，展示截取40个Unicode code point并加省略号；仅标题派生，不修改原文，title_message_id指向真实来源。没有用户消息用“会话 <短ID>”，不请求模型、不从assistant反推、不写回title字段。

### 3.3 分页与并发承诺

新集合统一limit+1；有额外一项才返回next_cursor，否则null。cursor沿现有base64url JSON工具，版本化并包含kind、owner作用域、conversation作用域（适用时）、首屏上界tuple及最后返回tuple。每次严格解析并核对作用域；cursor不是授权凭据，所有SQL仍带owner。无TTL、无服务器scan状态。

首屏从同一SQL快照确定最高可见tuple及页数据；后续保持upper，列表用tuple<=upper且tuple<last，升序消息/Run用tuple<=upper且tuple>last。边界时间保留PG微秒，禁止Date毫秒截断。新页不把limit+1的探测项作为最后返回项。

这是读已提交的keyset导航，不是跨HTTP的MVCC快照。状态、原文展示和活动时间可以在刷新后反映新事实，但不改变排序键；本次遍历上界之后的新项由显式刷新取得。若另一事务较早启动却延迟提交，在已越过位置后才出现的记录也需刷新发现；不能宣称一次扫描覆盖未来提交。首屏已提交的既有记录不得因旧Run更新/活动改变重复或遗漏。不增加全局锁、缓存或持久扫描会话来制造更强承诺。

## 4. 原话、回复与Run关联

Run原话优先读取agent_runs.input_message_id，并同时验证message owner、conversation及role=user。字段为空时，仅允许读取仍存在且owner/conversation/run完整匹配、user_message_id唯一无歧义的既有conversation_idempotency引用；历史读取不以expires_at作为删除/写入理由，也不承诺该24h台账永久存在。完全没有引用为legacy_unavailable；非空引用损坏、跨owner/会话或多义为invalid_reference并呈现不完整状态。不得通过相近时间、内容相同、request_id近似或模型回答建立关系，不回填历史冻结字段。

messages集合原样返回全部user/assistant消息，显式排除system。没有Run关联的原话仍可在会话消息档案读到。assistant最终messages没有可信Run引用，不强行补关系；主Run回复采用外部事件。消息档案中的最终assistant文本作为单独标明的“已存消息档案，未声明Run关联”可展开读取，不再次拼入Run回复，也不把其视为又一次助手输出。这样既不丢旧可读内容，也不凭内容去重推断关联。

既有GET /conversations/{cid}?after_seq=&limit=增加可选run_id筛选；缺省保持整个会话，筛选时核验Run属于同owner/会话，缺失或错配404。响应、默认200、最大500及next_after_seq语义完全保持；不加字段破坏现有strict消费者，不扩SSE七词。

按event_seq升序合并同Run所有attempt的message.delta；seq是全局不透明游标，允许间隙，按seq去重。页满仍可读下一页；恰好页满可能需要一次空GET证明到达当前末尾，客户端不得把next_after_seq当has_more。新UI提供明确“继续读取”及未读完状态，不因只取首200/500条声称完整。事件页失败不推进cursor。无可见回复与读取失败分开；不得合成模型回答或恢复快照。

## 5. 批准与结果

遍历已读外部事件中的全部approval_required，按批准种类+ID去重并保留首次事件位置；不能只留最后一个。每个结果读取独立反馈loading/ready/error，未读完事件时明确批准索引仍未完整。

task批准详情新增result={task_id:UUID|null,successor_approval_id:UUID|null}。使用approvals现有readApprovalDecision/getApprovalDetail公共只读投影：consumed create_task指真实consumed_task_id，consumed cancel_task指真实target_task_id；superseded指真实后继，其余null。consumed无真实结果为完整性错误而非空成功。状态和结果须基于一致读取/同一有效时间投影，避免一个字段expired另一个pending。不会为取得task_id再POST confirm。Web可GET原task详情，明确读取错误，不把task调度状态当资料Run状态。

将task批准详情的公开schema归packages/contracts/src/approvals.ts；统一API与Web重复定义。原字段与语义不删，新增结果由同批消费者接纳；既有Confirm/Reject/Revise的strict请求和结果不变。

document继续GET原document-approvals详情，使用既有DocumentApprovalDetailSchema与effect。approved≠applied≠verified；可信conflict/unknown/failed各保留。继续复用document-service→tools/query的公共证据投影，不调用ToolGateway的invoke/replay审计路径，不读当前文件证明旧调用成功，不新建工具调用。前驱/后继批准链接保留既有关系。

不新增通用结果表、无界聚合接口或第二份资料任务事实源。多个GET不是原子总快照：各自最新已存事实正常，UI只能对成功读取的部分作结论。

## 6. 访问、撤权与只读边界

会话详情与新子集合沿既有父conversation边界：他人403，不存在/非法路径ID404；Run详情/点查仍404隐藏他人或错配Run。所有集合SQL带owner及父归属条件；不得仅依cursor过滤。未登录401，认证依赖错误不改401。

历史按当前认证owner读冻结摘要、原话、可见回复、冻结批准及已接受效果；当前workspace登记被撤销/改变不抹除这些事实。不得返回root、root_identity、registration_digest、provider body、密钥、内部snapshot或system。

可读不等于可动：新confirm/reject/resume/工具动作继续走原精确grant和当前登记校验；撤权时can_resume=false。旧Run缺安全workspace摘要时不从当前登记补造。取消仍沿既有独立合同，不能因资料撤权而禁止安全停止或伪撤销已发生效果。

所有历史读不得创建message/Run/attempt、批准/决议、工具invocation/audit、模型/MCP调用或文件写入，不做后台恢复、不调用模型生成标题。已有业务执行和身份session审计不属于新增历史事实；零副作用证明使用静止的隔离历史，不能把另一个正在运行的Run自然推进误归因于GET。

## 7. Web路由与登录衔接

继续使用/conversations：无query展示服务端历史和显式新对话入口；有conversation_id展示会话及分页Run；再有run_id直达指定Run。旧conversationHref生成的query深链保持不变，不引入必须迁移的path路由。conversation-only地址也能读，不要求先有选中Run才refresh。

新HistoryList/HistoryDetail组件在conversations目录组织，复用已有apiGet/readEnvelope/readRun/mergeThreadEvents、批准页与documentEffectLabel，不另起状态框架。导航使用Link/URL，由Next searchParams与key切换目标；back恢复URL身份，首次新发成功后仍可用replace建立原Run地址，但浏览历史选择不能全部replace吞掉back。

mount、列表选择、Run选择、刷新、back、读取更多及登录返回仅GET。只有明确点击发送/确认/拒绝/取消/继续才使用既有POST；不能在effect、read finally或网络恢复回调中调用动作。刷新目标变化时取消旧GET或按请求身份丢弃迟到响应，各资源拥有独立cursor，避免原会话尾游标带入新目标。

独立批准详情链接仍以新标签打开，避免查看预览中断主动SSE。当前选中的 Harness 提醒等待点也可在对话中完整审阅并点击“确认创建并继续”或“确认取消并继续”；这是一次明确授权的动作链，不是历史读取或批准后后台自动执行。确认成功立即显示真实任务引用，不再显示待确认动作；继续失败沿原同键恢复。business 提醒快捷入口没有可恢复等待点，仍使用独立批准页；文档批准仍独立审阅与显式继续。恢复历史自身不建立SSE、不自动resume；离开主动流仍沿原断连取消合同。

#68的safeReturnTo/pageReturnTo/protectedLoginHref/requireClientSession原样复用。仅HTTP401引导登录，返回原站内历史query后重新GET；403/503/流内业务401不当会话过期。不新增登录字段或auth handler。显式退出仍只发原sign-out，成功后必须清除本应用历史内存/动作重试状态再导航；不存历史或请求body作为重登前提。现有401已清run-resume/run-cancel/document-decision重试键，退出成功也应做同样应用键清理，保留无关storage。登录成功不能复活旧动作key或自动POST。

## 8. 空、错误和部分失败

新集合空为200 items=[]/next_cursor=null，仅表示成功读取的该集合当前无项。401/403/404/400按既有envelope；pool不可用沿503 NOT_READY。实际DB查询异常沿当前路由脱敏500 INTERNAL_ERROR，不为了新历史统一把任意错误改成“空”或伪503；已存在的typed依赖503保持。前端保留HTTP类别和request_id供状态反馈，不只剩一个丢失类别的Error字符串。

不引入200 PARTIAL伪成功。多个独立GET部分成功由UI显式呈现：原文已读、回复未读完、某批准/结果失败；成功部分保留，失败部分有只读GET重试，整页不显示“完整恢复”。第一页失败不是空历史，后续页失败保留原cursor与数据；未找到与没有回复不是同义词。legacy_unavailable与invalid_reference分别说明，不要求后台修复或猜测。

## 9. 数据、索引与兼容发布

不新增表或原话/assistant 关系列，不修改旧迁移、不重写旧冻结事实。`0018_conversation_history.sql` 仅增加四个非唯一普通 B-tree 索引：

- conversations(owner_id,created_at DESC,id DESC)：列表keyset。
- messages(owner_id,conversation_id,created_at,id) WHERE role IN ('user','assistant')：本人可见消息分页/首条原文。
- agent_runs(owner_id,conversation_id,created_at,id)：本人会话Run索引。
- conversation_idempotency(run_id)：旧 Run 缺少 input_message_id 时，按 run_id 查全既有幂等引用；非唯一索引保留多引用事实，随后仍检查全部引用的 owner/会话作用域及原话歧义，不预先过滤坏引用或更改读取合同。

last_activity为已有有界owner会话事实的派生查询，不预建搜索索引。列表用单SQL/明确只读投影取得每页标题/活动，避免为每行多次往返；既有event_seq、attempt/run索引先复用，不预建event JSON或FTS索引。没有实测性能预算，不虚构p95保证。

索引只在 `0018_conversation_history.sql` 中创建，旧 baseline 对象保留。`scripts/check-migrations.mjs` 仅窄范围允许该文件；`scripts/local/baselines/0018.sql` 沿用已有 SQL verifier，经 pg_catalog 核对四个真实索引的表、键、非唯一属性、方向、空值顺序、谓词及有效/就绪/存活状态，不以只核列/约束的 JSON 增量冒充索引核验。既有表驱动 PG smoke 扩展 run_id 索引缺失、错键、错误唯一性、错表、无效及未就绪场景，要求拒绝且不修复索引、不改变已有事实。原已运行的三索引升级与 47 场景验收只证明旧状态，不能作为新增第四索引的验收；四索引状态须另记真实 PG16 EXPLAIN 与生命周期运行证据，不改写 #67/#68 的历史记录。

停旧写者，经既有显式local:upgrade升级并部署同批API/Web/contracts。新集合属添加，旧events/RunView/SSE不变，task批准详情增加结果字段且同步消费者；不改Harness协议。迁移失败沿既有停写和显式修复流程，不自动重试业务POST。回退应用须遵守#67版本分类，不能盲目降版或删新迁移/卷/owner来通过启动。

## 10. 证明与交付边界

合同PR先评审并OpenSpec严格校验，不能勾选实现或真实验收。实现按新公开行为Red→Green，复用已有充分覆盖，不把源码字符串断言或mock回显当行为测试。

新增重点：owner隔离；same timestamp/微秒/tie/cursor错域；超过所有页上限；状态更新不搬页；晚提交按刷新语义发现；多Run与原话引用/legacy；system/snapshot过滤；全部批准及consumed task结果；部分失败游标不推进；旧深链和401安全返回无POST；撤权历史读/动作拒绝。

真实浏览器+PG16：经正式账户路径准备任务，清空临时状态且不留旧URL，退出重登由列表找回；逐项对照原文、所有回复、Run/attempt、批准/真实结果。以隔离静止历史记录GET前后Run/attempt/decision/invocation/audit、模型/MCP计数和文件hash/写证据不变；不把只看HTTP200当零效果证明。复用已有native/unknown/撤权合同，保持五个CI门；真实模型/完整#66证明不因历史通过而扩大。

实现、浏览器/PG验收及独立审查后，才另行archive并关闭#69；#66与#70仍各自承担整体验收和任务体验。

### 10.1 实施顺序与受影响消费者

1. 先评审独立 OpenSpec-only 合同与本文档；同步 API、schema、PRD 和索引，不把 Proposed 当作实施授权。新增 conversations capability 不改执行/授权/身份主规格。
2. 以消费者可见行为取得有效 Red，再交付共享 strict query/DTO、三个分页集合、旧事件的 Run 筛选与真实提醒结果读取；必要索引和升级核验同批交付。
3. 同一完整实现切片接通 Web 历史列表、会话、指定 Run、所有批准和结果；保留旧深链及既有动作，仅在明确用户操作时执行原 POST。
4. 真实浏览器与隔离 PG16 对照六项验收，复用有效底座证据，只补新消费者和跨边界缺口；最后独立审查、归档与收口，不提前关闭 #66。

具体消费者：

- API：`apps/api/src/modules/conversations/{routes,service,repository,schemas}.ts`；提醒结果由 `approvals/{service,routes,schemas,decision}.ts` 所属公共读取承接，不跨模块查私表。
- 共享合同：`packages/contracts/src/conversations.ts`、`approvals.ts` 及 `index.ts` 和行为测试。保留 `ThreadEventSchema`、`RunViewSchema`、`DocumentApprovalDetailSchema` 和既有动作请求/响应合同；提醒详情使用共享 schema，不留 alias shim。
- Web：`apps/web/src/app/conversations/{page,Chat,HistoryList,HistoryDetail,HistoryResource,ApprovalHistory}.tsx`、`lib/conversation-run.ts`、API 错误处理及具体命名类型；批准/文档详情复用原页面并保留返回会话位置。`account-navigation`/AccountForm 复用安全重登，仅清理本应用重试键，不更改认证机制。
- 验证：检查 `apps/api/test/helpers/harness-consumer.ts` 的 local/HTTP 两个消费者、相关 conversations/approvals 集成和 Web 行为覆盖。新增历史消费者必须读全所有页，不把既有小夹具首批读取扩大为完整历史证明；如纳入 enforced D8，同步既有 `ci/gates.json` 和报告入口，不另建 CI 框架。
- 交付文档：本文及 conversation/approval API、conversation schema、PRD 和文档索引。实现时才在迁移目录索引和使用指南登记真实入口；不把计划序号或命令写成已可运行。

### 10.2 #69 六项验收映射

| 验收                           | 方案落点与需要观察的结果                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| AC1 清空临时状态后重新发现     | §3、§7：同账户正式登录后从服务端列表进入原会话/指定 Run，不依赖保存 URL 或手工 ID                         |
| AC2 原话、回复、批准及结果完整 | §4–§5：多 Run/attempt、跨全部集合和事件页、全部批准、真实 task 与 document effect；旧数据缺关联如实说明   |
| AC3 隔离、内部过滤和失败语义   | §6、§8：owner 强制过滤、system/snapshot 不公开，空/无权/不存在/依赖故障及局部失败可区分                   |
| AC4 恢复严格只读               | §6–§8：mount/back/分页/登录返回只 GET；静止历史的 Run/attempt/决议/调用/文件证据不增加，断网不补业务 POST |
| AC5 旧深链与撤权边界           | §4、§6–§7：旧事件、Run 和冻结批准可读；当前撤权不恢复新动作资格，不从新登记补造旧摘要                     |
| AC6 真实浏览器与 PG16          | §9–§10：覆盖升级与真实历史路径，复用确定性 native/授权/unknown 证据，保留五门并如实记录未覆盖项           |

行为真源见 [conversations 规格](../../openspec/specs/conversations/spec.md)，完整交付清单见[会话历史归档](../../openspec/changes/archive/2026-10-28-close-r1-conversation-history/tasks.md)。[2026-10-28 验证记录](../verification/conversation-history-verification-2026-10-28.md)分列六项真实验收、四索引与单次聚合补证、静态审阅及适用版本，不将历史切片扩大为 #66 全路径验收。
