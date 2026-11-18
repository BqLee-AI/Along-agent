# v0 收口计划

> 状态：仅规划；Observed 为本次只读核对结果，Required 沿用现行合同，Proposed 尚待独立契约评审。
> 范围：完整 v0 的 A1–A4、D1–D10/五门、实际部署、证据、独立 review 与 archive。
> 不包含：本轮实施、运行验证、创建 issue/PR、commit/push、读取或修改 .env/凭据、优化 CI、重开 brief、提前解冻 Deferred。
> 阶段标签：v0 完整收口规划；后续实施及对外操作需用户授权。

本计划的实施与验收结果见 [2026-10-23 完整验收记录](../verification/v0-closeout-evidence-2026-10-23.md)。以下保留规划时的现状和取舍，不用后续实现改写规划历史。

## 1. 何时可以宣布 v0 收口

只有以下条件同时成立，才能写“完整 v0 已收口”：

1. **A1–A4 全部有适用证据。** A1 有真实确认、登记、到点 15 分钟内一次站内通知和事件链；A2 同 approval 重复确认只产同 task，真实修改明确目标 pending approval、重回显、旧项 superseded、旧确认被挡；A3 真实强杀/恢复覆盖发送边界，已发未知只核对不重发，实际调用与持久结果分别证明，取消提交后调用为零；A4 不存在/重复本地时刻、first/second、未知时区、规则不可用均符合批准合同。
2. **D1–D10 不降级，五门全部成功。** 固定 Bun 1.4.2、OpenSpec 1.3.1、Oxlint 1.89.0、Oxfmt 0.74.0；保留 static、migration-scan、scheduler-fault、contracts-dual、compose-smoke。每个合并候选使用其精确 head 的结果，不能用旧源码 head 的 CI 代替。
3. **实际部署成立。** 真实 Dockerfile 构建的同一服务端镜像以 ROLE=all、独占 PostgreSQL 16、Compose 运行；受控迁移、session/CSRF、外部真实 Web 与 Next 代理可用，并完成业务链。既有 D7 探针 smoke 和宿主生产构建七步不能互相冒充。
4. **证据可串联且适用。** 输入、approval/task/run/request ID、源码/镜像、环境及实际规则版本、HTTP/SSE、SQL、provider 调用、时间窗口和责任人相互对应；旧证据明确保留或因变更失效，不以“没有日志”证明零调用。
5. **独立审查与归档完成。** 公开合同先独立 PR，review + 五门 SUCCESS + CLEAN 后合入；随后实现、真实验收、独立代码/证据 review，再 archive。只在收口 PR 关闭对应 issue。Proposed、缺证据或未决合同不能写成完成。

依据：PRD04:7–22；安全 spec Requirement 1、4、5；design/13 §3–§4；CONTRIBUTING §5、§8。以上是既有要求的执行映射，不建立新审批体系，不取代用户授权。

### 现状分栏

| 范围      | 已有证明，可按适用性复用                                                       | 仍缺行为                                                                   | 仍缺证据                                                                           | 合同冲突/待决                                                          |
| --------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A1        | #26 真实 SSE→按钮→task→schedule receipt→一次 provider 调用→站内通知/Web→活动账 | 本次未发现需重做主链的依据                                                 | 最终镜像业务与变更影响面；相对表达真实入口、冻结/确认及同 task 次日到点证据，见 §7 | 若以组合证据替代字面场景，须先获合同认可；本地 sent 不是设备送达或已读 |
| A2        | #26 原确认键重放同 task；既有 PG 确认/并发/hash/expiry 回归                    | 明确修改对象、原子替代、生产 superseded 写入与交互                         | 真实旧项→新项→旧确认拒绝→新确认单任务；修改/确认竞争                               | 新入口、错误优先级、幂等及 schema 增量待批准                           |
| A3        | #26 生产撤销回执、取消到原到点+16min、正控制1/取消调用0；既有状态/fencing 回归 | 调用后未提交崩溃的可恢复判定；默认 provider 无独立接收事实                 | 真正强杀、恢复、真实未知回答及跨进程调用累计                                       | 实际调用一次与不确定窗口的能力边界必须先裁决                           |
| A4        | time-core 黄金/DST/反向钟测试存在；SSE 测试覆盖部分输入和 fold                 | 统一失败帧、结构化两候选、真实规则门、完整客户端选择；未知别名不可静默回退 | HTTP/真实 Web 错误链、规则缺失且旧冻结任务不受影响                                 | spec failed 与实现 completed 冲突；规则有效范围及 readyz 冲突          |
| 门禁/部署 | #26 精确源码五门与归档/合并证据；既有 D7 两轮探针门                            | 部署补齐 secret/迁移/Web 前置，不重设计平台                                | 最终服务端镜像 all 的登录后真实业务链                                              | readyz 不能当作全链验收                                                |

## 2. 基线、来源与复用边界

### 2.1 已完成的 #26 不是本轮待办

已存记录：`docs/verification/v0-smoke-evidence-2026-10-21.md` 与 `docs/verification/v0-smoke-evidence-2026-10-21.json`；归档：`openspec/changes/archive/2026-10-21-complete-v0-seven-step-smoke/tasks.md`。运行源码为 `914cca971f03e7a0a813a7aff8890aa36c82951a`，源码 CI 为 run `39567342047`。交接上下文另已确认最终 head `3b2006c8cd8524dcf0d045f6ec71be277cfa3a75` 的 run `39570660987` 五门 SUCCESS、CLEAN，PR28 精确合并为 main `317842f669f606409f5f728e68ecc77b0c58dc3b`。本次没有访问 GitHub 重新核验这些交接事实。

JSON 的 `stages.confirmation`、`stages.fired_notice`、`stages.cancel`、`provider_observer`、`verification_limit` 和 `independent_evidence_review` 是后续复核入口。既有独立代码与运行证据审查均已存在，不要求主线程为了本计划重新执行同一 agent 验证。旧专属服务、浏览器和 PG 容器卷已清理，不能假定仍有服务可复用。

旧 `v0-smoke-closeout-plan.md` 的缺口表是其规划基线快照，不作当前实现清单。当前 `cancel-phase.ts#cancelOne` 已调用生产 `revokeLocalTaskQueue`、`completeCancelFromReceipt`；通知 service 已有 `getTaskNotifications`；#26 的两项修复不能重新列作待实现。

### 2.2 本次实际追踪的调用链

- 对话：`Chat.tsx#send` → Next 同源 `/api/v1/conversations/messages` → `conversations/routes.ts#handleConversationRoute` → `service.ts#startConversationRun/executeRun/runTurn` → `tools/gateway.ts#runProposeTask` → `time-core.classifyEntry/normalize` → `approvals/create.ts#createTaskApproval` → PG。
- 确认：`ApprovalActions.tsx#call` → `approvals/routes.ts` → `confirm.ts#confirmApproval` → approval 行锁、hash/seen、task/created/outbox/consumed 单事务。
- 调度：`main.ts` → `worker/loop.ts:51–56` 的 cancel→schedule→claim→send→ack→missed；`send.ts:225–244` 持 task 锁后调用 `sendOne`；`send.ts:125–136` 进入 `deliverInApp`；`notifications/service.ts:71–112` 实际调用 provider 后写通知；随后 fired/outbox 结果提交。
- 时间：生产 gateway 直接使用 `FIXTURE_V1`（`gateway.ts:205–259`）；`conversations/lifecycle/service.ts#startPayload` 同样直接报告该常量；`http/app.ts:70–85` 的 readyz 只看版本字符串。

本次无可用语言服务器，符号和行号由只读文件及文本搜索定位，不声称完成语言服务器引用分析。引用行号是本次源码快照，实施时以符号及实际 diff 重新定位。

## 3. A2：显式修改一个 pending approval，而不是自动覆盖会话

### 3.1 Observed：有拒绝旧项的消费者，没有生产替代的生产者

`create.ts:74–118#createTaskApproval` 仅 INSERT pending，不写 supersedes，也不修改旧项。`repository.ts:110–118#findSuccessorId` 能反查后继，`confirm.ts:83–201#confirmApproval` 能将 superseded 映射为 `409 APPROVAL_SUPERSEDED`；`errors.ts:99–100` 已有 `details.successor_approval_id`。但已有 superseded 集成用例是预置旧状态和后继，不证明用户能完成修改。

现有详情只有确认/拒绝（`ApprovalActions.tsx`）；对话 schema 有 `card_ref`，实际创建链没有据它选择旧 approval 或实现替代。`supersedes_approval_id` 是 schema 已有字段（迁移0003:26），不能把它描述成缺字段，也不能把“同会话又说一个提醒”视作授权修改上一条。

### 3.2 Proposed：推荐一个明确的修改 action

推荐从 pending approval 详情提供“修改这条提议”入口，提交完整的新内容，成功后跳到新 approval 详情重新确认。**不是修改 task，也不是确认动作。** 已 consumed 的项继续使用现有取消/新建任务流程，不将其悄悄变成改期。

推荐候选公开入口为 `POST /api/v1/approvals/{id}/actions/revise`，而不是依赖会话自然语言猜目标。候选 body 复用既有命名 `raw_text`、`confirmed_timezone`、`fold_choice`、`idempotency_key`；响应返回新 pending approval 的标识及必要回显材料，详情仍是读取真源。路由名、字段集合、响应 envelope、时间错误详情均为 **Proposed**，须独立 spec/design/API 批准，不能直接据本计划实施。新增端点需同步现有“12业务端点”清单。

选择该方案，是因为目标 ID、权限、幂等与原子替代可全部由 approvals 用例拥有；不需让 conversation 的跨阶段 run/checkpoint 事务承担替代原子性。另一候选是在既有 messages body 加显式旧 approval ID，但那需要同时处理 request hash、run 重放及创建与 checkpoint 中间失败，不是本次首选。不得两种入口同时各建一套规则。

解析继续调用现有 `classifyEntry/normalize`，使用 A4 统一后的规则上下文，不复制正则、不硬编码另一份 fixture。候选相对时间锚点推荐取修改请求首次服务端接收时刻并在幂等记录冻结；不能让重试跨天改义。该锚点与原会话冻结锚点的区别须在契约中明确。

### 3.3 approvals 是唯一替代所有者

一次成功修改应在 approvals 自有事务中完成：

1. 验认证、CSRF、请求结构；目标必须是本人可修改的 `create_task` approval。先做 owner 判定，错误不得泄漏他人后继或改写他人状态。
2. 以明确 owner/操作/键定位持久幂等记录；同键同请求重放同一新 approval；同键不同请求返回现有 `409 STATE_CONFLICT` 语义。键的跨目标复用规则在契约中固定，不能误重放另一条提议。
3. 锁旧 approval，与 confirm/reject 使用同一行锁串行化；锁后再次按 DB 当前时间检查 pending、expires_at、fire_at_utc。不能仅依靠锁前过期检查，等待锁期间仍可能到期。
4. 完整校验新内容与时间；无法归一或仍有歧义则不作废旧项，不创建新项。
5. 生成新 ID、新冻结快照、新 hash/回显，INSERT 新 pending，其 `supersedes_approval_id=旧id`；旧项只改 state=superseded；幂等结果与替代同事务提交。失败全部回滚，不留下无后继的 superseded 或双 pending 替代项。
6. 修改不建 task、created 事件、schedule/send outbox 或通知。新项只有经过现有按钮确认才产生 task。

事务持有时间内使用校验后的不可变输入；外部规则可用性失败不得提交半个替代。confirm 当前先在事务外 `persistExpiredIfDue`（`confirm.ts:96–101`），再在行锁后依据状态处理；A2 要新增锁等待到期回归，按其影响最小修正共享状态检查，不能新路径一套时间规则、confirm 另一套。

### 3.4 竞争与错误矩阵

| 情形                                           | 推荐结果与不能发生的事                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| 修改先锁定并提交，旧 confirm 随后执行          | 旧 confirm 为409 APPROVAL_SUPERSEDED，带既有 successor；旧项无 task，新项仍待按钮确认 |
| confirm 先提交                                 | 修改为409 STATE_CONFLICT，并指向已消费语义；不创建替代 approval，不自动取消 task      |
| 两次不同修改竞争同一旧项                       | 只允许一个成功后继；落后者409 SUPERSEDED/CONFLICT，不能 LIMIT 1 随机选后继            |
| 同修改键重试、响应丢失或进程重启               | 返回同一结果；新项后来已消费/过期也不能再造后继                                       |
| 已 rejected/consumed、cancel_task 或非 pending | 明确409；cancel_task 是否可修改不纳入本次推荐范围，不假装支持                         |
| 旧项有效期或目标已过                           | 410 APPROVAL_EXPIRED，无替代；锁后到期同样处理                                        |
| 不存在/非法 ID、他人、未认证、CSRF不符         | 沿用404/403/401/403边界；无业务副作用                                                 |
| 已 superseded 的旧项用原确认键或新确认键确认   | 都为409 APPROVAL_SUPERSEDED；不能因幂等键复用绕过状态校验                             |
| 新项确认仍携旧hash/旧所见内容                  | 409 PRESENTATION_MISMATCH，零task                                                     |
| 同会话另外新建提醒                             | 正常独立 pending；不触碰本次旧项或后继链                                              |

以上细化的优先级仍需进入独立合同；已 consumed 重复确认回原 task 的冻结语义保持不变。

### 3.5 Schema 结论与迁移

已有 state、supersedes_approval_id、快照/hash 足够表达替代，不增加双向 superseded_by 列，不重复存可反查关系。现迁移0003没有 `UNIQUE(supersedes_approval_id)`；`findSuccessorId` 的 LIMIT 1 不是唯一性保证。推荐新增非空后继关联唯一约束，并为新增 action 增加 approvals 所有的最小持久幂等映射：owner/操作键、目标、规范请求摘要、新 approval ID/冻结结果及约定保留期。确切表列名在 schema PR 冻结，不借用 outbox 保存无副作用修改，也不跨模块写 conversation_idempotency。

因此：**已有业务字段足够，完整并发/重启幂等落地仍建议新增迁移。** 只新增迁移，不改0003或0011；先只读检查既有非空后继重复及 owner 关联，若存在不一致先停迁移，不自动删业务行。新迁移编号由实际合入顺序分配，本计划不预占编号。

验收至少经真实详情入口完成一次修改、旧错误、新回显/确认和重复；PG 回归覆盖两类竞争、rollback、进程重启后重放、过期及跨owner。仅把旧项预置成 superseded 的测试继续保留，但不能代替生产替代证据。

## 4. A3：先修可恢复事实，再演练实际强杀

### 4.1 Observed：必须覆盖的调用后事务窗口

`runClaimPhase` 已在前一事务写 lease 和唯一 send outbox，status=dispatched（`claim.ts`）。`runSendPhase` 随后另开事务（`send.ts:225–244`），锁 task/outbox，`sendOne` 调 `deliverInApp`。后者先发布调用诊断，再 `await effective(notice)`，之后才 INSERT notifications（`notifications/service.ts:71–112`）。fired、outbox dispatched/acked_unknown 结果都在同一外层事务内写；`withTransaction` 直到回调返回才 COMMIT（`db/transaction.ts:18–35`）。

所以在**实际 provider 已被调用、该事务尚未提交**时强杀：

- 早先 claim 已提交的 send 行和 lease 不会因本次事务消失；
- 本次 notifications、fired、outbox结果以及即使已执行但未提交的 acked_unknown 都会回滚；
- `listDueSendRows` 仍选 dispatched；runSend 没有要求本进程重新获得 lease 才处理该 send 行；行锁释放后可再次调用 provider；
- **[INFERENCE] 当前恢复存在第二次实际调用路径。** 本次未运行强杀，不伪称已观察到双调用，但该路径已足以阻止把 A3 写成通过。

`localInAppProvider`（service.ts:62–64）不落任何独立事实，只返回 delivered=true/answered=true；外层通知唯一约束只保证行不重复，而且 provider 在冲突检查之前已调用。它证明正常站内记录路径，不证明独立接收端耐崩溃、不证明“发了没回”可恢复，更不能证明外部分布式 exactly-once。

现有 `scheduler-fault.test.ts:71–99` 的F1没有杀进程；`211–280` 的未知回答用例是在 provider 正常返回后 commit，再手改 notification 为sent并验证旧版本 fencing。它们有回归价值，但都不是上述崩溃窗口。`worker/loop.ts` 恢复靠PG扫描，不使用 agent run 的 `resume_from`；故障手册这段应纠正。

### 4.2 Proposed：最小推荐能力及必须裁决的边界

不推荐直接加一段 kill 脚本就关 A3，也不推荐把 delivered=true/answered=false 改叫未知：`notifier-core#outcomeOf` 明确优先 delivered，真实未知回答必须是无法确认接收结果。

推荐先在现有站内通知模块内建立**可按发送键核对、独立于 worker 结果事务存活的本地接收事实**，并为 worker 保存可恢复的发送尝试/不确定状态。只服务当前本地 inapp，不引入 Redis、外部推送供应商或通用 provider 平台。其最小约束是：

1. 调用许可/尝试绑定 owner、task、冻结 fire_at、state_version、send key；恢复必须区分“明确尚未允许调用”和“可能已经调用”，不能把后者重新当 dispatched待发。
2. 本地接收完成后有独立提交的 intake/receipt，可按同键查询；worker 收尾事务回滚不抹去该事实。核对入口归 notifications 公共 service，不继续让 tasks/ack 直读新通知存储。
3. 对实际已发但回答丢失的项，恢复只做查询/收尾；无证据不写fired，也不调用send“试一下”。核对保持30s/2min/5min与持久待对账语义，具体持久表示先审合同，不给 task_events 增加新词。
4. D9 仍以实际调用瞬间计数。保留调用时任务栅栏和取消串行关系；不能简单拆掉 task锁。取消先提交→后续调用0；调用已发生/在途时不能先成功提交取消再让该调用继续发生。
5. 原 FOR UPDATE 与独立通知 INSERT 的 FK KEY SHARE 冲突。PostgreSQL 16 双连接实证表明，FOR NO KEY UPDATE 允许该 FK 接收提交，仍阻止取消 UPDATE；因此采用兼容 task 锁，复用 notifications 加 fire/version 绑定，通知由接收端独立提交，task/fired/outbox 由 worker 独立收尾，不新增接收表或跨模块写事务。检查发送 helper 不升级锁，专用接收 pool 避免外层连接耗尽，完整绑定核对及迁移以 A3 契约为准。

**必须明确的能力上限：** 持久发前标记与真实函数调用不可能天然原子。标记提交后、调用前死亡，恢复可能只知道“可能调用”；没有独立事实时，自动重发可能双调，不重发可能零调。独立接收回执也不能倒推出“从未调用过”。

合同保证选择为**安全优先，允许不确定未完成**：许可后无接收事实不盲重发，可保留待核对或超窗未完成；已接收项只核对完成，D9实际调用零不变。这是用户明确选定的A3保证修订，需同步安全spec及PRD，不是把请求一次偷偷改成通知行一次，也不是已满足A3；实现、真实强杀/取消及镜像部署仍需分别证明。决策记录见 [#29](https://github.com/BqLee-AI/Along-agent/issues/29#issuecomment-6312744098)。

不选择“有唯一通知行即可”的方案；不选择仅靠内存Set、lease、调用前写DB或接收端幂等就承诺请求严格一次；不为演练临时创建一个与生产不一致的假provider。

### 4.3 真实未知回答如何产生

当前默认provider立即成功，既无实际通信也无独立接收存储，不能用拔网线产生它没有的未知回答。必须先有上节批准并落地的真实本地接收能力，再演练：实际本地接收事实提交后，阻断worker取得结果，在收尾事务提交前强杀worker；恢复按真实键核对该接收事实。

若没有现成可稳定到达该点的调试能力，允许在**已实现的真实接收提交与结果返回之间**加一个按本次task/key限定、默认关闭的最小单次暂停/退出检查点，标为Proposed；它只能控制时序，不能伪造 delivered/answered/receipt、写业务终态或替换provider。不新增公开测试API、不做通用故障注入框架。执行者必须证明接收事实先提交、worker确实未收到/提交结果，不能只拍到“开始调用”。若未来实际采用本地传输，可在真实接收后丢弃响应；不能为证明一个不存在的网络链路搭假成功服务器。

### 4.4 独占进程/PG/调用计数演练表

生产业务仍经真实API/Web创建与确认；SQL只读，不修改到点、lease、ack状态或通知。优先使用本次独占Linux容器内worker执行真正SIGKILL；Windows强制终止须明确记录平台方式，不声称执行了不存在的kill -9。API与worker可暂用同一服务端镜像的独立角色，以保留API观察；这不是替代最终all验收。

| 检查点                             | 到达证据与动作                                     | 成功判据                                                                          | 变红/缺证据                                                   |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| scheduled后、尚未claim             | 真实登记回执、调用0；强杀自有worker后重启          | 自然到点后累计调用1、通知1、fired1，未超过15min                                   | 无进程终止证明或靠SQL催到点=缺证据；重复调用/漏执行=红        |
| claim已提交、调用前                | 独立PG可见lease和send命令；准确检查点强杀          | 恢复遵循批准许可语义，无并发重复；明确未发场景应自然完成一次                      | 只有phase函数重复执行不算强杀；租约事实不等于调用所有权证明   |
| 实际provider已调用、结果事务未提交 | 外部调用观察已确认并落存；确认无结果提交，然后强杀 | 恢复不第二次调用；按真实接收/不确定事实核对，已接收者最终单通知/单fired           | 事务回滚后重新send使累计2立即红；仅DB通知1不能救回            |
| 真实接收已提交、回答丢失           | 独立接收事实+结果阻断/强杀证据                     | 跨恢复累计调用仍1，核对后单通知/单fired；未知期间无send                           | 返回answered=false正常commit、SQL置sent或假回执均不算真实证据 |
| fired/通知结果已提交后             | 独立PG读到终态，强杀再恢复                         | 原task调用/通知/fired均仍1                                                        | 恢复新调用即红                                                |
| 已提交取消后恢复                   | 若新发送机制影响取消，复用#26方法重做该影响面      | 实际调用0、真实撤销回执、无活跃非cancel余单、无breach，跨原到点+15min再两有效tick | 顺序不清按违规待复核；只看零fired或心跳不算tick               |

调用观察复用既有 `along.notifications.provider-call` 边界，跨worker死亡的累计记录必须保存在不随worker死亡的受控收集端。关键检查点须等收集端确认已落存再杀；不能用被杀进程内数组或缓冲日志证明总数。记录PID/启动身份/本次task/key/序号/时间，不含正文、身份、凭据。重启可有明确预期的worker停机段，但收集端应连续，恢复前后各有正控制；每个任务单独计数，不能把新进程从0算起。

所有等待用真实时钟，恢复安排在15min窗口内；租约过期等自然发生。超窗只有missed，不把missed当正常恰好一次通过。旧#26取消证据对未变路径继续有效；若send/ack/接收事实或锁次序变化，就只补受影响的取消安全窗口，不无差别重跑整个七步。

## 5. A4：统一失败语义与实际可用规则，不建设全球tzdb

### 5.1 已核实的逐项现状

| 项目          | Observed                                                                                           | Required/缺口                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 不存在时刻    | normalize返回NONEXISTENT；DST测试覆盖2026/2027春季；gateway转clarify，conversation completeClarify | 安全spec Scenario1.2要求thread.failed、422语义，不能以completed通过                  |
| 重复时刻未选  | normalize带first/second、偏移与UTC；gateway仅把候选拼入文本                                        | 流错误需保留结构化candidates，不能只断言中文含“第一次”                               |
| first/second  | API schema接受fold_choice；PG测试验证两偏移，second可确认；Chat不提交fold且无选择控件              | 真实客户端需让用户明确选择后再生成/确认，不靠前端算UTC                               |
| 未知时区/别名 | normalize未知zone报UNKNOWN；entry中stray别名主要在未确认tz时检查                                   | 已有confirmed timezone时，未知“某某时间”可能被忽略并沿用旧tz；需错误而非静默fallback |
| 规则缺失      | normalize可识别部分坏ruleset；gateway总传FIXTURE_V1；readyz只看字符串                              | 缺alias/ruleset/内容时readyz503，入口在调用normalize前拒绝，不降级                   |
| DB不可达      | API文档§6要求readyz非就绪；实现未查DB                                                              | 不能pool存在或版本非空即200；用最小真实DB探测，不扩大成全系统健康框架                |

关键依据：`normalize.ts:42–112`；`entry.ts:106–124`；`gateway.ts:205–259`；`conversations/lifecycle/service.ts:421–469、runTurn`；`conversations/routes.ts:80–108`；`conversations-sse.test.ts:158–280`；`Chat.tsx#applyEvent/send`；`http/app.ts:70–85`。API conversations §2表已经写时间错误thread.failed，但§4又写completed，本身也需同步。

### 5.2 推荐最小统一方案

推荐恢复冻结spec，而不是为保留现实现把错误改成成功：普通信息缺失/模糊表达仍走现有澄清；NONEXISTENT、AMBIGUOUS、UNKNOWN_TIMEZONE按typed错误进入thread.failed，error.http_status=422，唯一终结，无approval。TZDB_UNAVAILABLE为503语义。`stream-protocol/thread-events.ts:73–88` 已允许error.code/http_status/details，不需为两候选再发明事件类型。

HTTP与SSE分开：

- SSE已建立仍是HTTP200，错误在frame表达422/503，不能事后把HTTP状态改422；可先发必要澄清delta，但终结只能failed，不再completed。
- readiness可在新请求开始前判定的缺规则，推荐在创建run/会话及发送SSE头之前返回503 envelope；鉴权/CSRF仍先按现有边界处理。已开始流后发现不可用则thread.failed503。
- 时间错误“无业务写入”指无approval/task/outbox/notification；允许既有conversation/message/run/checkpoint/tool_calls审计。预检规则不可用的拒绝应连新run也不创建。不能把保留失败审计误报为不存不排违规。

Web遇AMBIGUOUS错误显示服务端给的两候选和偏移，提供first/second操作；保留原输入、明确日期/时区与本次选择，再以新幂等键提交同一意图。新请求不得重用未选fold的幂等键，也不能丢失“纽约时间”而回到/me的Shanghai。客户端只读候选，不自行换算，不从“第一次/第二次”自由文字猜fold。

### 5.3 规则来源和边界

当前真实来源是仓库静态 `packages/time-core/src/fixtures/fixture-v1.ts:5–32`，标识FIXTURE_V1/fixture-v1：Asia/Shanghai固定+08、Pacific/Kiritimati固定+14、America/New_York仅2026/2027四次转换；别名来自 `entry.ts:27–36#ALIAS_TABLE_V1`。本次没有发现完整IANA发布物来源、校验清单或支持年份声明。normalize会把最后偏移继续用于任意年份，不能因此宣称2030纽约夏令时正确。

推荐复用当前不可变规则表示，补一个API应用拥有的、同时供readyz和所有新归一入口使用的规则上下文：实际内容、alias版本、ruleset/tzdb标识、支持zone/有效区间及可用性。环境TZDB_VERSION必须与实际加载内容一致，不再只是任意非空字符串；time-core仍是零I/O纯函数，不能去读env/时钟/网络。

最小内容检查应能区分：整个包/alias缺失或结构损坏；声明支持的zone缺规则；真实未知或本版本不认识的zone；超出已承诺规则区间。推荐本轮先批准可举证的有限时区/年份范围，不接全IANA库。纽约2026/2027可作为现有证据起点；两个固定偏移zone同样不能虚称历史全部正确。超界不得沿末偏移静默归一，推荐TZDB_UNAVAILABLE语义，但该范围与错误细化须先spec/design批准，不能由本计划定为已冻结。

readyz检查实际规则/alias/标识以及DB可达；缺环境版本仍保持既有D1/D7的503。入口消费同一个检查结论，不在handler和gateway各写一个健康判断。规则缺失只阻止新归一，不阻断已冻结task正常执行、详情读取或取消；不通过重算旧task验证新规则。

### 5.4 A4验收场景

1. 2027-03-14 02:30纽约：HTTP200 SSE、唯一failed422 NONEXISTENT，无approval/task/outbox。
2. 2026-11-01 01:30纽约、none：failed422 AMBIGUOUS；两候选分别05:30Z/-14400与06:30Z/-18000；真实Web可选first/second，新pending冻结fold/偏移，确认仍走现有三件套。
3. 非法规范ID、未知中文别名分别在无已确认时区和已有Shanghai时测试；均不能悄悄排到Shanghai。
4. 受控部署分别缺version、缺/损坏实际规则、缺alias、版本内容不匹配：readyz503；新归一拒绝、无新承诺；已有冻结task按原规则结果自然执行。故障必须真的改变部署输入/装载来源，不手改业务表或只给mock空对象就声称真实演练。
5. 支持区间边缘及越界输入：按批准范围处理，不静默外推；DB断开时readyz503但healthz仍200。

DST本地时刻不必等到真实DST日；使用明确未来绝对输入即可验证归一，不能通过确认已过期approval伪造成功。

## 6. 建议 issue/PR/OpenSpec 分组和实施顺序

以下只是建议，不实际创建；实际编号与change名在获授权后确定。每个公开合同增量都执行“独立契约PR→review+五门+CLEAN→实现→真实验收→archive”，不把本计划当批准。

| 阶段              | 具体行动与独立交付价值                                                                                             | 所有权/唯一验收负责人                                                                                      | 成功、变红、缺证据门槛                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P0 规划入库       | 主线程核对关键源码/合同依据，保存本文并同步 Demo 索引；建立现状/证据映射，不改历史记录结论                         | 主线程负责核对与保存；本轮仅规划不增设独立文档审批门                                                       | 成功=关键依据可追溯、未把#26重开、未伪称实施；错误标完成=红；无法溯源项明确保留为缺证据                        |
| P1 三个合同主题   | A2显式修改；A3崩溃事实/不确定窗口；A4失败语义/规则/readiness。优先裁决A3可实现边界；各自独立spec PR，不夹代码/迁移 | 各领域合同负责人；主线程协调唯一最终验收结论                                                               | 成功=关键选择明确且合同合入；实现先行/降低D9=红；A3未决=完整v0阻塞，但其他独立主题可继续                       |
| P2 A4基础与A2替代 | A4先提供共享规则上下文；A2落实原子替代、持久幂等、详情交互及新增迁移。两条分别带有效回归                           | A4负责time-core/规则装载/http/conversation错误；A2负责approvals及其Web详情；每条指定一位验收负责人         | 成功=生产入口可达、行为与已批合同一致；跨owner/无确认建task/错误终结冲突=红；只有测试无真实入口证据=未完成验收 |
| P3 A3恢复实现     | 按批准选择补接收/尝试事实、查询恢复和最小检查点；更新故障手册，保留取消锁与回执门                                  | tasks scheduler负责人统一send/claim/ack/cancel；notifications负责人提供公共接收/核对能力；A3验收负责人唯一 | 成功=调用后回滚不盲重发，独立事实可查；计数重复、取消破零、未知伪fired=红；不确定边界未决=不收口               |
| P4 真实演练与部署 | 独占资源实杀恢复；最终镜像all+Compose+真实Web/session；按变更影响补#26证据                                         | 由主线程指定一位整体验收执行者；独立证据reviewer不自审自己的结论                                           | 成功=A1–A4证据齐、部署链可串；任一硬约束破坏=红；观察器断档/没杀进程/仅readyz=缺证据                           |
| P5 归档合并       | 完成代码与证据独立审查，按change归档、索引及结论同步；最终head五门+CLEAN后结束对应issue                            | 主线程唯一负责完整v0宣布；不把AI review称平台强制/人工批准                                                 | 成功=每项有适用证据与明确归档；未决项仍在却写全v0通过=红                                                       |

本轮规划由主线程核对关键依据后保存，不要求再创建独立文档审查会话或取得新增批准。后续公开合同 PR、最终实现与运行证据的既有独立 review、五门及 CLEAN 要求保持不变。

推荐最小组织为三个领域issue（各含契约PR及实现/验收收口PR），部署/总证据尽量归入相关收口工作，不为每个测试或文档再建issue。若部署准备确需独立源码变更且不属于三主题，可另开一个聚焦部署的issue，不顺便建设平台。

并行边界：P1的三个合同草案可并行；合同未合入不得对应实现。A2与A4独立模块可并行，但A2的规则接入依赖A4接口，不能复制实现；Chat由A4单一所有者，A2优先只动approval详情。A3的send/ack/cancel/notifications由一位集成负责人串行整合；不要让多人同时改同一scheduler仓储或预占同一迁移号。真实故障场景在各自独占资源内串行，避免相互修改时钟/进程/DB；主线程在所有改动落定后统一验证，避免多agent同时跑重检查。

## 7. 单镜像 all + Compose + Web 的实际验收前置

现Dockerfile使用固定Bun并只build API（`infra/docker/Dockerfile`）；Compose只有PG与ROLE=all API，未提供Web、自动迁移或BETTER_AUTH_SECRET传入（`infra/compose/compose.yaml`）。因此不需要为“单镜像”把Web塞进API镜像；保持服务端一个镜像三角色，Web以独立生产构建连接该API即可。

后续执行者应：

1. 记录本次源码、镜像ID/摘要、Bun/PG/规则实际版本、受控资源名、所有者与ROLE。新建专属Compose项目/卷/数据库与合成用户，不复用用户库、不杀未知进程；对端口/已有资源先确认所有权。
2. 通过受控进程环境或经批准的Compose运行参数注入数据库与同一session secret；不读写.env，不把secret/cookie/CSRF/DSN写入文档、HAR、截图或版本控制。若需补Compose变量传递，属于后续部署改动，不在本轮偷偷实施。
3. 在全新库用现有 `scripts/db/apply.sh` 顺序应用当时全部迁移；它不是可对已有库反复安全执行的runner，不虚构db:migrate命令。Windows所需POSIX shell/psql须在执行前就绪；不以重置用户库解决工具缺失。
4. 使用现有 `bun run --filter @along/api seed:session` 创建真实合成session；其CLI会打印cookie/CSRF，只在私密执行界面临时取用。Web同主机正确设置session，/me取得真实CSRF，确认Next代理指向镜像API，不是遗留宿主API；不使用dev auth代替。
5. 保留原D7两轮全新卷“缺/有版本”探针smoke；另在具备真实规则、迁移和身份的镜像all环境验收简报只读→SSE→按钮确认→真实近未来到点通知→活动链，并运行A2新交互及A4错误/选择。已批准的#26说明可复用，但最终部署不是宿主旧运行的同义词。
6. 强杀可先在同镜像api/worker分角色环境精确取证，最终all仍须正常业务验收，必要时补all进程整体重启；不因为拆角色便宣称满足all部署条件。
7. 业务写入只经真实入口；真实等待不用改fire_at/lease/系统钟。故障测试库与业务演练库分开。仅清理本次拥有资源；执行记录保留资源清理结果，不假称旧服务尚存。

### A1 相对表达与真实到点证据的精确边界

A1 的冻结场景是：在已确认时区下输入“明天9:20提醒我喝水”，冻结回显、按钮确认、建单次 task、取得登记回执，并在该 task 的实际到点后15分钟内产生恰好一次站内通知及完整事件链。#26 已有近未来绝对输入的真实主链可复用，不因本轮规划失效；它没有实际执行“明天9:20”这一完整字面场景，不能据此改写历史记录。

完整收口应明确区分三层证据：

1. **实际相对输入与冻结。** 通过真实 Web/session/Next/SSE 输入“明天9:20提醒我喝水”，记录服务端首次接收时刻及其已确认时区，核对回显确为该时区的次日09:20；保存实际输入、SSE、approval 冻结字段/hash、首次按钮请求/响应、task及schedule receipt，并串联同一approval/task。不能只直接调用time-core或预置approval证明生产入口处理了“明天”。
2. **可复用的计算与边界回归。** 复用既有、确实覆盖相对表达与锚点的表达集/入口回归，以及time-core黄金、DST、反向钟和冻结展示回归；各自只证明其实际断言的解析、归一或冻结行为。黄金绝对时间用例、#26绝对输入链都不能被描述为相对表达生产场景的实测。受后续改动影响的回归才需更新/重验，不要求重复有效且未受影响的agent验证。
3. **同一相对表达任务的真实到点链。** 按冻结A1字面场景宣布完整通过时，还需让上述同一task在真实次日09:20自然到点，核实15分钟内provider累计调用1、通知1、fired1及真实Web可见，并保持既有后续观察要求。可以安排受控服务持续运行、到点后取证，不要求执行者全程交互等待；但不能改钟、改fire_at、换另一条近未来task或只看schedule receipt替代。若尚未取得这一段，报告应写“相对表达/确认登记已实测；该相对任务的真实到点结果尚缺”，不能写字面场景全程通过。

若后续希望以“实际相对输入冻结证据 + 未受影响黄金回归 + #26/最终镜像近未来绝对输入到点链”的组合证据代替同一相对task的次日实际到点，须先明确取得现行验收合同对该等价方式的认可；本计划不自行作此替换，也不降低冻结A1。与此同时，不重复实施brief或重做已有效的#26主链；最终镜像因A3发送链变更所需的到点正向验收，另按变更影响取证。

## 8. 回归复用、增量测试与不可替代的真实证据

### 可复用的既有测试

- `approvals-confirm.test.ts`：重复/并发单task、hash/seen错、到期、预置superseded、reject状态；`approvals-read.test.ts`：owner与冻结投影。
- `conversations-sse.test.ts:158–280`：不存在/重复输入、first/second、second确认；时间错误completed断言须随合同修正，不能删除用例或只改标题。
- `scheduler-fault.test.ts`：phase重放、取消正控制/调用零、旧版本send/ack拦截、lease到期、超窗；保留其状态回归意义，纠正“已实杀”描述。
- `scheduler-schedule.test.ts`、`tasks-cancel.test.ts`、`tasks-read.test.ts`：调度、真实生产撤销函数、回滚/重放、通知详情owner/状态/null/读无副作用。
- time-core `golden/dst/reverse-clock/entry-fixes/expressions`；Web `presentation.test.ts` 冻结变异；既有依赖、SQL、文案与格式门。

### 新行为应有的有效回归

A2补真实revise用例、唯一后继、修改vsconfirm/reject竞争、锁等待后过期、同键异body、重启后重放、旧hash新项、新旧确认键及非目标同会话不变；替代事务中间失败必须整体回滚。不要用源码含某SQL字符串证明原子性。

A3补独立接收提交/worker结果回滚后恢复、未知只lookup不send、许可窗口、错误/超窗、版本栅栏与取消竞争，断言真实provider调用次数；单元/PG可用故障时序控制，但明确不是生产实杀记录。新机制触及D9时必须让错误实现变红，不能把D9改成数fired。

A4补结构化错误code/http_status/details、两候选顺序/偏移/UTC、唯一终结、GET重放一致、无承诺业务写入；未知别名在已有tz时不fallback；装载缺失/损坏/不匹配、边界年份及DB readiness；Web测试行为而非固定整句中文，显示文案改动不应脆弱变红。

### D1–D10 继续如何证明

D1保留time-core零出边、反向钟及缺规则readyz；D2保留Web禁止时间计算的原AST边界与冻结UTC变异；D3/D4保留既有task触发点/重约唯一，A2后继唯一是其领域新增约束，不冒充D4；D5/D6保留事件/revision/checkpoint/tool_calls只追加；D7保留两轮新卷真实镜像探针；D8保留进程内与HTTP双跑，新增公开行为补对应HTTP/进程内场景而不是扩空壳测试；D9按实际调用且分不清顺序按违规；D10保留诚实口径扫描。

`apps/api/test/contracts.test.ts` 的双跑具体只测healthz，不能用其绿声称新revise/SSE业务均双跑过；相关业务测试需按实际边界补覆盖，不削弱现门。迁移仍只新增。

未来主线程统一运行适用根scripts：`bun run verify`、`bun run test:integration`、`bun run test:scheduler`、`bun run test:contracts`、`bun run build`及OpenSpec严格校验；根入口含构建前置，DB skip不算通过。每个PR五门要求不变；具体本地运行按改动选择，不把重跑所有历史agent当新增门。

**测试不能替代：** 实际OS强杀和重启、调用后未提交窗口、真实本地接收后回答不可得、跨进程连续调用累计、最终镜像all+真实session/Next/Web业务链、规则部署输入真的缺失且旧冻结task仍可执行。以上必须留真实运行证据。

## 9. 证据口径与已知取证局限

每个新增场景保存：执行/复核负责人，源码/镜像、环境所有权、ROLE/PID/启动标识、服务端/PG时间基准、实际ruleset/tzdb/alias与支持范围、脱敏输入和关联ID、预期/实际、HTTP/SSE/SQL/调用记录位置、开始/终止窗口、未执行项及原因。JSON保存可复核原始数据，中文报告解释结论，不以报告中的“通过”替代原始证据。

旧#26的三项局限明确如下：

- **首次确认body未留。** 既有首次200、真实task跳转、同键重放和SQL唯一事实可继续支持原主链/幂等结论；重放在consumed分支先于hash/seen检查，不能补成首次校验抓包。它不使已独立审查的#26作废，但不能拿来覆盖新A2首次修改/新确认的响应和所见绑定。新的A2及镜像链应提前安排不被导航驱逐的取证，保存实际请求/首次响应；失败仍如实标缺证据，不伪造或无限重跑旧链。
- **SSE中文乱码。** 旧事件类型、seq、ID及唯一终结证据仍有效；不能证明中文原文保真。A4新错误两候选要保存正确UTF-8结构化帧并与DOM核对；若新证据仍损坏，相关文本/候选展示判定缺证据，不能用旧乱码掩盖。
- **没有像素级判读。** 旧DOM、真实按钮操作、网络/API/SQL支持功能可见性，但不证明视觉像素质量。A1–A4没有新增像素审美门，故不要求为旧图重跑视觉agent；新选择/修改交互仍必须真实可操作。若出现遮挡/无法点击或DOM与页面不符，需就实际问题取得可用视觉/人工证据，不先声称看过图。

不把AI审查称人工批准；不把已清理的本地截图引用假装可公开永久下载。涉及本次新增关键结论的证据必须实际可供指定reviewer读取。

## 10. 收口阻断、授权与Deferred

任一以下情况阻断完整收口：未确认即建task；替代非原子/错误owner/多个后继；调用后回滚恢复再次send；取消提交后实际调用大于0或顺序不清；无真实回执进入scheduled/cancelled/fired；时间错误仍与已批spec冲突；规则不可用仍新排期；部署只验readyz；关键观察断档；A3不确定窗口未裁决。业务变红保留现场证据并停止相应验收，缺证据明确标缺，不能把两者写成通过。

本轮只交规划，主线程保存正文与索引不代表授权实施。后续代码、运行服务/演练、建issue/PR、commit/push及对外合并均按用户后续授权和既有仓库流程执行；不建立另一套审批体系，也不把本表变成额外授权门槛。

Deferred仍按PRD04原阻塞阶段：目标市场阻塞P5计费/组织，不阻塞P1；仓颉第二实现阻塞P3排期，不进入v0；外部推送阻塞P5触达扩展；LLM供应商阻塞成本核算、不阻塞P1功能；计费阻塞P5；每日重复语义留P2+/v1。鉴权与Web框架已冻结，不重新列为未决。Redis不进入验收依赖；不重开brief、不优化CI、不扩成全球tzdb、通用混沌/遥测/E2E平台。A2/A3/A4本计划中的收口缺口不是Deferred，不能靠改名延后宣告v0完成。

### Planner 只读研究阶段的操作边界

以下仅描述本文起草依据形成时的 Planner 研究阶段：未编辑仓库或暂存文档；未运行build、lint、tests、formatters、OpenSpec命令、安装或服务；未强杀进程、连接PG或做浏览器验收；未操作Git/GitHub、创建issue/PR、commit/push；未读取.env或凭据。研究结论仅来自静态代码/合同/测试及仓库已存证据，不声称已实施或已验收。

主线程随后负责核对关键依据、将正式规划保存为 `docs/plans/v0-closeout-plan.md`、同步索引，并可按本次文档交付要求进行定向格式校验。这些后续保存/校验不属于上述 Planner 阶段的“未执行”声明；实际执行及结果由主线程在交付记录中如实报告，不在文稿中预写为通过。
