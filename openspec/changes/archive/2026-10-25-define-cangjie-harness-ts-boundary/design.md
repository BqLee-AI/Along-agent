# 仓颉 Harness 与 TS 可信运行边界

## 1. 结论、证据与范围

仓颉是唯一通用 Harness，TS 是身份/权限、工具、批准、业务和持久事实权威。选择每个有效 attempt 一个同容器原生子进程，以双向 UTF-8 NDJSON 交互；不新增常驻 RPC 服务、远程 bearer 或第二套 TS Agent。

Observed：`startConversationRun` 已持久化消息/Run/attempt/入站幂等；`runTurn/executeRun` 是确定性分支，不是真模型循环。批准后会结束 Run，尚无同 Run 等待恢复；`finish` 的消息/attempt/Run 写入不共事务。#45 已提供稳定 Run/slot 预约、冻结上下文、不可变接受结果及本地批准/结果/审计事务。工具的当前 allowlist 仍来自可信同进程上下文。Web 仅消费 POST 流。上述为 planner 静态观察，不是本阶段运行验收。

Required：复用 #45，而非另造结果账；仓颉组织下一步，TS 裁决允许和已发生事实。仅交付有限批准等待后的显式恢复，不承诺任意崩溃无人值守恢复。真实 provider、模型质量与 R1 产物总体验收不在本阶段证据内；正式原生核心不能是 echo、固定回放或由 fixture/TS 组织步骤的替身。

候选比较：HTTP 常驻服务增加服务身份、监听与远程绑定；FFI 增加 ABI/内存/异常边界。单机生产容器及现有 Bun 子进程能力下，管道绑定足够且概念最少。分机部署或实际管道能力不满足要求时再重开，不先建通用 RPC。

## 2. 入口、兼容与可信来源

现有 `POST /api/v1/conversations/messages` strict body 新增可选 `execution: 'business' | 'harness'`，省略等价 business。Web 显示“提醒/任务查询”和“Agent（仓颉）”显式选择，默认原业务。已有数据库 mode=chat/task 仍是用途标签，不承担运行时选择；harness 本阶段 mode=chat。

business 保留明确的提醒/取消提议及任务读取业务，重命名为业务执行用例，不持模型循环/计划，不作为 native 或 provider 故障回退。harness 必须经过正式原生核心，缺配置/产物明确不可用。公网请求不能指定 fixture、provider、二进制路径、owner、allowlist 或 attempt。

Run 创建后 execution 不可切换。入站幂等仍使用原 `(owner_id,idempotency_key)` 账：省略/显式 business 保留原 hash 材料以兼容历史；harness 在同一材料前使用明确 `harness/v1` 域分隔。因此同键换执行类型冲突，不成为另一幂等命名空间。

TS 从实际 session/Actor 开始接受 Run，按服务端固定 revision/产品策略保存最大工具范围、预算、首次接收时间/时区/fold/规则版本。仓颉只取得描述，不决定权限。每次工具和状态提交恢复 owner→conversation→Run→attempt，工具范围不超过冻结范围及当前服务端授权；用户停用/明确撤销资格拒绝新动作。普通登录 session 轮换不自行改写已接纳 Run，用户发起 cancel/resume 仍需当前有效 session/CSRF。

## 3. 原生进程、模型传输与 wire 合同

正式工程位于 `apps/harness/`，不放永久 spike。固定 Linux x86_64/glibc，通过 root scripts 显式准备、构建，镜像打包本次产物及实际运行库闭包。不得消费旧二进制、describe.skip 或以另一语言程序代替。

工具链冻结为官方 [SDK LTS 1.0.5](https://cangjie-lang.cn/download/1.0.5) 与 [stdx 1.0.5.1](https://gitcode.com/Cangjie/cangjie_stdx/releases/tag/v1.0.5.1)。SDK SHA256 为 `bacad84df8e0281c5395bab4c40e481e3ea6cc712eed5c953903b0d561a14562`，已与官网发行元数据匹配；stdx SHA256 为 `6e301e63ae9ab74ca17d360400eaa0c525b9f48e5d08077f05ce4f704be7c277`，是官方 release 下载后的本地计算值，未宣称独立发行者 checksum。实现保存公共下载地址/版本/hash 的 artifact 锁；cjpm.lock 不代替二进制 path 依赖完整性锁。

真实 probe 已在 WSL Ubuntu24.04/glibc2.39 用 cjc/cjpm 1.0.5 编译 ELF，并验证中文/转义、分片/合并 JSON 行、flush、EOF、顺序 cancel 及等待输入时 SIGTERM。`oven/bun:1.4.2`（实测 Debian13.6/glibc2.41）实际运行 hello/JSON 程序通过；裸 runtime 内 fresh 编译实际报缺 `ar`，因此采用独立 builder，显式安装 binutils 及实际所需 GCC/C++/libc 开发依赖后 `cjpm build --skip-script`。runtime 只复制正式产物、SDK runtime/所需 stdx 动态库及适用许可/notice，不复制整 SDK。正式 builder fresh 成功仍属于实现验收，不能将本 probe 的运行兼容写成已构建生产镜像。

以上只是技术能力证据，不证明真实 Run/模型中取消、生产有界 parser、TLS、Web/TS/PG 或 R1。SDK/stdx 使用 Apache-2.0 with Runtime Library Exception，分发保留其适用及第三方 notices。

TS spawn 固定应用产物，shell=false；每个子进程闭包绑定可信 Run/attempt，不从消息选择绑定。显式最小环境仅传必要运行库配置，不继承 DATABASE_URL、cookie、Better Auth secret。stdout 只输出协议，stderr 不输出模型密钥、原始请求/响应或完整推理链。

协议为 `harness/v1`，一行一个 strict JSON 对象；双方校验协议/类型/字段，拒绝未知字段与不兼容版本。TS 发送前及接收累计时实施 1MiB UTF-8 frame 上限，拒绝残缺 EOF/畸形 UTF-8/JSON/超限，不先无界缓存；native 验证帧边界/结构并逐响应 flush。该上限覆盖 #45 既有安全结果上限，bootstrap/模型上下文也受限，超限明确失败而非悄悄丢内容。模型/pipe 等待不持数据库事务。

| 方向    | 帧       | 语义                                                                                 |
| ------- | -------- | ------------------------------------------------------------------------------------ |
| TS→仓颉 | start    | protocol、用户输入及消息引用、已授权工具描述、预算/版本、有限恢复上下文与批准决议    |
| TS→仓颉 | reply    | 当前 pipe request_ref 的结果或脱敏错误；不是新的执行资格                             |
| TS→仓颉 | cancel   | 已提交的取消观察；进程监督可终止进程                                                 |
| 仓颉→TS | model    | request_ref、本轮上下文和模型请求；不包含自选端点/凭据                               |
| 仓颉→TS | reserve  | request_ref、call_key、tool_id、args，独立持久取得 #45 invocation_id                 |
| 仓颉→TS | invoke   | request_ref、invocation_id、tool_id、args；没有 owner/allowlist/run/attempt 授权字段 |
| 仓颉→TS | snapshot | request_ref、版本化有限上下文引用、usage、next_call_no；不提供 event_seq             |
| 仓颉→TS | suspend  | request_ref、已提交 checkpoint_ref、invocation_id、approval_id                       |
| 仓颉→TS | answer   | request_ref、可见 delta；由 TS 资格检查和持久投影后 ack                              |
| 仓颉→TS | finish   | request_ref、outcome/usage；请求终结，最终事实由 TS 核对及提交                       |

request_ref 仅关联本 pipe 回答，不作持久身份/授权。native 按当前请求等待 ack，避免无界输出队列。逻辑 call_key 来自 native 单调计数 `harness/N`，同一未完成动作重交不换 slot；provider tool-call id、request_ref、attempt 或 hash 均不能代替 #45 身份。

wire 采用平铺 discriminated union：每帧必含 `protocol`、`type`；仓颉请求含本 pipe 唯一 `request_ref`，reply 用 `reply_to` 关联且恰含 `value` 或 `{error:{code,message}}` 之一。示例：`{protocol:'harness/v1',type:'reserve',request_ref:'r1',call_key:'harness/1',tool_id:'list_tasks',args:{}}`。start 不含 TS 凭据；其预算/工具描述不是可回传升级的权限。双方 schema 及 native parser 消费相同版本，通过真实交互验证，不用源码文案断言代替兼容性。

仓颉生产代码构造上下文、消费模型响应/解析工具提议、纳入真实工具观察、决定继续/等待/停止并执行预算。TS model transport 只做固定服务端配置的网络传输及协议转换，不挑选工具、不循环或自行推进 Run。生产提供显式配置的 OpenAI-compatible chat-completions 传输能力；这是兼容协议选择，不指定实际供应商。端点/模型/凭据的最终变量名随实现运行说明公开，缺配置在新 Run/开 SSE 前类型化不可用，不回退 fixture。密钥只由 TS 传输层持有。

本阶段每个模型轮次最多一个工具提议，拒绝不支持的并行提议，不能悄悄漏执行。累计模型 usage 可得则计入，未知保持未知，不编造费用或用字符估算冒充真实 usage。迭代预算由仓颉强制；报告已超预算后不再安排模型/工具，保留已发生事实。不可证明的累计 token 费用上限不作保证。

CI 只在服务端依赖注入点替换模型传输响应；相同正式 native 仍执行上述完整核心。fixture 不经公网字段或默认环境启用，不自行 reserve/invoke/suspend 或提供预先编排的 Run 状态。

## 4. Run 权威、锁序与状态原子性

复用现有 Run 状态 `running → suspended_approval → running → done|failed|cancelled`；attempt 使用 `running → done|failed|fenced_out`。挂起结束 attempt，但 Run 不终结。有效 resume 新建递增 attempt_no，旧 pipe 永不重新取得执行权；不借现存 lease 字段声称已有通用租约系统。

工具与运行写者保持 `attempt → Run → invocation` 锁序。状态提交在锁内核验绑定、最新 attempt、预期 Run 状态及引用，不能先持 invocation 再反向锁 Run。resume 定位旧等待 attempt 后若已被新 attempt 取代，返回原恢复事实/冲突，不再分配；cancel 对最新 attempt 的定位必须处理与 resume 竞争，不能因先读到旧 id 而取消失效。具体取消重定位不能重做任何工具效果。

finish 将 assistant 消息、终态 checkpoint、attempt/Run 状态同事务提交，只有一次终结。未完成工具、unknown/failed 或悬空批准不能伪装 done；状态/事件落库故障全回滚。accept 工具效果后到终结之间的故障不能删除或重做已接受事实。

cancel 先在 TS 原子提交 cancelled、撤销资格和唯一 thread.cancelled，再通知/收回 native 并取消在途模型传输。不能靠 kill 顺序决定权限。取消先提交则新动作拒绝；工具先提交则事实保留。Run 取消不撤回已消费批准产生的任务，也不自行改变独立按钮确认合同。

浏览器运行中真实断连按既有规则请求取消；服务端挂起后的正常 res.end 不触发取消。显式停止接口是可靠的用户入口，Next 代理必须传递真实 abort，不能假定浏览器关流已到 TS。

## 5. 批准等待与显式恢复

native 收到真实 approval_pending 后提交包含原 invocation/approval 的有限 snapshot，再请求 suspend。TS 验证批准来自当前 Run 的已接受调用，原子提交等待引用、Run suspended 及 attempt done 后 ack，native 才退出。本段 SSE 只发已有 approval_required，不发 thread.completed。

新增 owner-scoped：

- `GET /api/v1/conversations/{cid}/runs/{rid}`：Run execution/status、当前 attempt、有效等待 checkpoint/批准引用及可继续状态；不返回权限/凭据或内部模型推理。
- `POST .../actions/cancel`：strict `{ idempotency_key, reason? }`，复用认证、CSRF、原始 body 上限与 request_id；重复取消回原裁决，不重复终态。
- `POST .../actions/resume`：strict `{ checkpoint_id, idempotency_key }`，仅继续最后一个已持久批准等待点；流及补读与消息入口同合同。

approve/reject/revise 原按钮接口和冻结 hash/seen_content 事务不改。approvals 提供公共决议读取 DTO：approval_id/status、真实 task_id 或 successor_id；不得从冻结结果猜当前状态。pending 拒绝继续；consumed 交付实际业务结果；rejected/expired/superseded 交给 native 停止该未授权动作，不自动跟 successor 或重提同义效果。

用户确认可能先于 suspend，恢复必须读真实决议而不依赖一次通知。Web 批准动作后带原 Run 等待引用显式 resume；失败/刷新可通过 Run 读接口继续，不重做确认。不存在后台隐式唤醒/outbox 自动恢复承诺。

同等待点最多一次有效恢复，DB 唯一约束守护；同键回答丢失重交定位原新 attempt，同等待点新键不能再启动第二进程。取消/终态/旧 checkpoint、他人引用及 business Run 不可恢复。恢复不重放旧 thread.started/delta，不新造逻辑 Run；原 approval_pending 接受结果仍不可变，决议是另一条真实观察。

## 6. 持久化、快照与投影

新增下一号迁移，不改旧迁移：

- agent_runs 冻结 execution（历史默认 business）、服务端工具范围和启动上下文，保存有限等待引用；harness 新事实受状态/引用一致性约束，旧 business 不伪造快照。
- run_checkpoints 增加内部 harness_snapshot kind，沿用只追加和 attempt 内 seq；记录版本、消息/工具结果引用、简短计划、累计 usage、next_call_no 和等待引用。快照不作授权，不保存密钥、完整推理链或原始工具参数副本。重建的消息/结果引用必须属于 owner/Run，预算及 call_no 不倒退。
- 恢复幂等定位复用既有机制或最小新增持久关系；同等待 checkpoint 唯一有效恢复，不另造工具结果表。执行类型/冻结授权不能在恢复时升级。

内部 snapshot 与外部七事件明确过滤；listRunEvents/listConversationEvents 不能将 snapshot 交给 ThreadEventSchema。global event_seq 是不透明游标，内部行造成间隙合法；对同 conversation 的对外追加须序列化分配/提交可见游标，不能让未提交小 seq 在客户端读大 seq 后被永久遗漏。

GET/同入站键只补读已存外部事件，不分配 attempt/启动进程/执行工具。running 同键仍409；suspended 同键可回已存前缀而不恢复。业务旧事件/幂等 hash 保持兼容，不把普通 checkpoint 当执行恢复点。

## 7. 工具与模块所有权

TS 根据可信绑定构造内部 ToolContext；对外 frame 不收该对象。工具预约/提交直接复用 #45，读取历史接受结果仍过当前权限；未知效果只核对或停下，不因恢复新造 slot。

网关取消候选/列表读取由 tasks 公共 query-client 用例负责，简报投影归 brief，偏好归 identity。必须保留原字段、过滤、排序、limit、card_id/标题等语义；不能直接用内部开新连接、形状不同的 HTTP service 替换。共享 query client 保持本地批准/结果/审计受控原子事务，D1 静态导入规则不等于 SQL 所有权证明。

confirm 创建/取消事务、time-core、scheduler/notifier/worker、task_events/outbox/真实回执门不改。删除混合运行权威入口及通用 TS loop/预算估算；保留的确定性业务明确命名且不互相接管同一 Run。

## 8. 错误、部署与验收

保留 400 VALIDATION_ERROR、401/403/404、409 STATE_CONFLICT、429 BUDGET_EXCEEDED、typed 时间错误、TOOL_DENIED 和 TOOL_EFFECT_UNKNOWN。新增 Harness 依赖不可用归 503 HARNESS_UNAVAILABLE；协议/进程异常归 HARNESS_PROTOCOL_ERROR/HARNESS_EXITED，脱敏且无原始 stderr/provider body。开流前 JSON envelope，开流后唯一 thread.failed；不可覆盖已提交 cancelled/suspended/终态。任意 PG/编程异常不伪造已持久 tool failed。

部署先停旧写者、应用新迁移，再用本次构建 native/运行库切新进程；历史 business 仍可读且不推造恢复点。新事实接纳后只前滚，不恢复旧混合运行写者。不启动旧用户数据库验收，不写 .env；新增配置只在运行说明告知。

验收：新隔离 PG16、原迁移、真实签名会话/CSRF、当前 native 产物与真实 Web/HTTP/pipe。逐项执行 tasks I1–I6；先观察目标缺失/缺陷 Red，再 Green，编译/环境失败不算 Red。真实事务屏障而非 sleep 猜竞态；效果接受后/快照前、取消/终结/恢复竞争、旧 attempt、同 slot 与丢回答均检查状态及真实效果。

#47 后续在同一 root test:contracts 和 contracts-dual 中加入固定工具链构建及隔离 PG 服务；正式生产者/消费者成功与拒绝合同及必要步骤删除变红齐全后，才提升 D8 对本 Run/工具/有限等待恢复范围的状态。真实 provider/模型质量/所有连接器/任意崩溃恢复继续明确未覆盖，不以 job 名或 fixture 宣称完整 R1。
