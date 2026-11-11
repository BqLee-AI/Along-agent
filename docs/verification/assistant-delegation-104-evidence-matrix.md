# #104 第 3 节证据矩阵

记录适用证据和仍缺的整体验收；历史切片的通过只属于其记录的版本和环境，不自动升级为本次 head 或原安装的证明。集成负责人负责本次映射；各历史样本的实际责任人与版本以链接记录为准。

| 项目                            | 可复用证据                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 本次仍缺或不能推断                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 资格、owner、来源及资料注入 | [#90 用户预期](https://github.com/BqLee-AI/Along-agent/issues/90#issuecomment-6594229549) 独立确认只摘要不执行与按资料建提醒两项；[PR 114](https://github.com/BqLee-AI/Along-agent/pull/114) 记录对应真实 Web/provider/native/TS/PG 正反例，适用其已接纳版本，包含另一次资料创建在接受后协议失败的独立记录。[PR 130](https://github.com/BqLee-AI/Along-agent/pull/130) 和 [PR 134](https://github.com/BqLee-AI/Along-agent/pull/134) 分别记录受护原安装编辑及隔离创建。 | #90 是阶段样本和用户确认，不声称逐样本事前盲审或新版混合目标；其余 profile、owner、资源资格及跨能力证据须按各自版本核对，不据此勾选整项。                       |
| 3.2 时间和投影                  | [共享任务记录](../../openspec/changes/refactor-assistant-capability-authorization/tasks.md) 的 #116 小节记录严格 elapsed、真实锚和原安装自然通知；#90 小节记录墙上时间与 DST 修复。隔离 PG 中 `elapsed-zone-followup.test.ts` 的真实 TS gateway 以合成可信上下文验证规则不可用时显式时区拒绝且零 task/event/outbox、可用的 UTC 分支及锚加 180 秒。                                                                                                                      | 该测试不含 Web/native/provider，其他 TZDB 故障、全部新旧投影边缘和混合目标仍须分别举证。                                                                        |
| 3.3 原子性、去重与接续          | 共享任务记录的 #90、#118 小节有 PG 原子性、来源与取消接续的阶段证据；[PR 136](https://github.com/BqLee-AI/Along-agent/pull/136) 记录并发恢复、许可竞争与真实 PG/native。[#137 记录](legacy-forward-release-137.md) 补充真实旧写者的 task 与 document 等待迁移、目标 native 受控恢复；document 样本的两个恢复调用真实重叠，仅一个接纳并产生一条成功文件应用账。正式数据库组件在 DDL 后注入失败并前向重试，所测旧事实不变。                                               | 隔离样本不证明原安装、所有旧 grant 或故障模式下的效果；DDL 后注入并非进程强杀或完整受管升级。                                                                   |
| 3.4 文件、停止与回执            | [PR 130](https://github.com/BqLee-AI/Along-agent/pull/130)、[PR 134](https://github.com/BqLee-AI/Along-agent/pull/134) 区分实际文件、独立回读、冲突、unknown 与模型部分结果；[PR 136](https://github.com/BqLee-AI/Along-agent/pull/136) 有隔离失锁、停止、迟到效果与真实 provider 样本。[#137 记录](legacy-forward-release-137.md) 补充隔离旧写者文档批准迁移、目标 native 写入和 MCP 回读。                                                                            | 原安装旧文件/批准恢复及本次原安装完整写护栏未验证；隔离受控模型不是真实 provider。snapshot 1 不包含 document 批准，不是文档验收门槛。                           |
| 3.5 原安装真实混合目标          | #116 记录原安装单个 elapsed 提醒及自然站内通知；PR 130 记录原安装受护文件编辑；PR 134 和 PR 136 记录隔离真实 provider 创建及断订阅执行。[#137 记录](legacy-forward-release-137.md) 对隔离 DB 角色、触发器、worker、driver 和文件只读护栏做正反实测。                                                                                                                                                                                                                    | 各样本不是同一原安装、同一目标、同一最终制品的文件、任务与自然通知完整旅程；隔离候选仍不能保护全部原有 Run 和有效派发，未向原账户发送可能写入的 provider 请求。 |
| 3.6 合同、五门及整体收口        | 共享任务记录及各阶段 PR 保存历史代码、合同和对应 CI；[#137 记录](legacy-forward-release-137.md) 保留本次协议和隔离迁移证据。                                                                                                                                                                                                                                                                                                                                            | 本次最终 head 的五门、真实模型整体评估和所有跨模块缺口须分别核实；不以旧 head CI 或上述局部通过勾选整体验收，不归档 change。                                    |

## 2026-11-11 独立整体验收：范围和前置

- 基线为 main `85026e3238eb864d60aba58cb831dd616b03b146`；以下历史结果仅适用于各自注明的版本和环境。3.1–3.6 均保留未勾选，直到对应合同的证据和限制逐项核实。
- 3.1：分别核对新旧 profile、owner、来源、资源集合、登记外和链接拒绝；对照独立人工审定的预期与真实模型的摘要注入负例、按资料创建正例，保留失败样本。
- 3.2：核对可信锚加 180 秒、无时区不追问、规则故障下真实 UTC 与明确本地时区的区别，以及墙上时间、DST、过窗、新旧冻结和今日投影；区分真实旅程与隔离故障注入。
- 3.3：核对事务各故障点的回滚、入站及调用重放和异参、并发取消与唯一接续、同文新委托及已接受效果不重做；同一调用重放不代表自然语言语义去重。
- 3.4：核对一次许可、响应丢失、独立新回读、确定零写后的修正、unknown、失联、停止和预算，以及取消优先和真实回执；区分进程级故障、受控响应与真实 provider。
- 3.5：同一原安装、原账户和配套制品中完成真实混合目标，分别记录文件、任务、排期和自然通知的原始事实及各目标状态；旧版单项旅程、隔离账户快照和受控模型不替代此项。
- 3.6：按行为合同及实际代码、API、schema、PRD、规则和同版本五门检查收口；真实模型评估需独立人工审定预期，记录完成、错误效果和非必要打断。第 3 节未完成前不归档、不关闭 #104/#105。

### 原安装放行条件

原账户可能写入的 provider 请求、受管升级和任何原安装写护栏操作，均不能仅凭上述历史实验放行。先在任务自有隔离数据上，以实际有效预约和派发逐项验证所有写工具的数据库及文件效果，同时限制到唯一标识的任务自有目标；正反例须覆盖 scheduler、后台恢复、其他连接、在途效果及真实挂载。候选必须能限制实际效果，工具名称过滤或仅测试无效参数不够。`local:upgrade` 最后启动 API、worker 和 Web，护栏须在任何写者启动前生效；完整等待清点可能创建连接内临时视图，不能把它称为纯只读聚合。

升级前须在受管锁下重新清点旧等待、停旧写者并备份；不兼容等待只能由有权用户明确处置。原批准、历史提醒和其他非任务数据不得自行消费、停止或清理。历史只读聚合是在运行中取得的快照，不证明完整资格或停写后的状态。

真实样本应预先确定唯一测试材料、允许效果、到点时间和等待窗口，并为 completed、partial、blocked、unknown 分别保存实际结果；执行者拟定的预期与独立人工 gold 分开。若护栏、旧等待资格或人工预期不具备，不发送可能写入的原账户请求，也不把隔离样本称作原安装验收。

### 可复用的具体样本

- **人工预期和资料注入**：[#90 的九项预期](https://github.com/BqLee-AI/Along-agent/issues/90#issuecomment-6594229549)由用户实际确认，其中第 4、5 项分别要求仅摘要时不创建或设置、明确按资料创建时不执行无关指令。[PR 114](https://github.com/BqLee-AI/Along-agent/pull/114)记录对应旧版本真实 Web/provider/native/TS/PG 正反例，也记录另一次资料创建在任务接受后协议失败并保留 partial；具体用户确认不是逐样本事前盲审，不证明当前制品或后续混合样本。
- **180 秒与自然通知**：[PR 117](https://github.com/BqLee-AI/Along-agent/pull/117)记录原安装上真实 Web/provider 的三分钟样本，按请求锚加 180 秒创建并自然产生站内 `sent`。它属于当时的实现版本，不代表本次最终制品或设备送达；相同 PR 将过窗、规则故障及来源造假限定为隔离 PG/正式消费者证据。[#137 记录](legacy-forward-release-137.md)记录 `cd6af58d` 隔离 PG 的真实 TS gateway 规则故障补验，不含 Web/native/provider。
- **文件创建和冲突**：[PR 134](https://github.com/BqLee-AI/Along-agent/pull/134)记录隔离账户、隔离 PG 和自建目录的真实 provider 样本：确定撞名零写，后续别名创建并新全文回读，最终 `done/completed`；此前真实样本中存在 cancelled、预算或上下文耗尽的 partial，不能用后一次成功抹去。该旅程并非原安装。
- **文件编辑**：[PR 130 的受护样本](https://github.com/BqLee-AI/Along-agent/pull/130#issuecomment-6735080813)记录真实 provider、native、MCP 写入和新全文读取；其临时触发器仅限制工具调用，不是数据库、其他连接、scheduler 或文件系统的完整护栏。旧记录所称 `74f49735…` 原安装归属已由 [#137 记录](legacy-forward-release-137.md)更正，不能用于本次指定安装身份。
- **连接与停止**：[PR 136](https://github.com/BqLee-AI/Along-agent/pull/136)的 `cd4d3a2` 真实 provider 样本使用原账户的隔离数据库快照和带临时护栏的 API，刷新后采样只见 GET、同一 Run 最终 `done`、一个 attempt、真实文件创建及独立回读。最终 Web 终态未观察；停止与失锁 Web 样本使用受控模型，不是原安装实库。
- **历史恢复**：[#137](legacy-forward-release-137.md) 的真实旧写者、目标 native 和隔离 PG 样本覆盖旧 task/document 等待、迁移及受控模型恢复；并发 document 恢复只有一个接纳和一个成功应用调用并回读。不是原账户、真实 provider 或所有故障下物理恰好一次的证明。
- **主线五门**：main `85026e3238eb864d60aba58cb831dd616b03b146` 的 [CI 43006148854](https://github.com/BqLee-AI/Along-agent/actions/runs/43006148854) 的 `static`、`migration-scan`、`scheduler-fault`、`contracts-dual` 和 `compose-smoke` 均为 success；这不是当前文档改动的 CI，也不替代真实模型和原安装验收。

原始材料核对：#90 私有验收索引将摘要与按资料创建分别指向 R04、R05 的原始页面快照；只读检查的快照时间分别为 2026-11-03 03:58:03 UTC 和 04:00:49 UTC，页面文本均包含目标完成标识，R05 还包含创建标识。页面文本本身不能证明零设置、零创建或数据库状态，以上效果结论仍依赖阶段验收记录及其数据库证据；原始页面含私有内容，不纳入仓库。九项预期的公开审定记录早于上述页面快照；确认是一次九项选择，不是用户逐样本亲笔标注。

同键异参的 `apps/api/test/integration/timezone-preferences.test.ts` 覆盖预约冲突和调用拒绝，并核对原偏好不变；本地只审读源码，但下述 PR CI 的 PG integration 原始输出记录此用例通过。#90 私有原始证据中的数据库事实摘要记录两条来源独立的任务各有一条 created 事件和一条 schedule 命令，并记录原有任务、事件、outbox、批准、Run、调用和通知保持；这是当时的聚合记录，本次没有重新读取原库逐行核验，也不代表当前版本的真实旅程。

### 最终源码的隔离补验

main `85026e3` 与 PR 138 的最终 head `d077786` 具有相同 Git tree `3aa026fe9143c695d04b55c72ce158494d810cbd`；`cd6af58d` 至 main 的 `apps`、`packages`、`infra`、`scripts` 无差异。这支持复用这些目录内未变代码的历史证据，不改变历史构件、模型或安装的限定。

以 `85026e3` 导出的源码在 Linux x86_64、Bun 1.4.2、任务自有 PostgreSQL 16.15 和合成账户执行以下隔离检查；复用既有 native，未在本轮重建。模型传输为受控 fixture，不是真实 provider。原始日志保留了命令和输出，首次 3.1、3.4 分别因缺少测试专用认证配置而失败；补入合成测试值后两组重跑通过，环境失败不算行为 Red。

- **3.1**：`delegated-workspace-admission`、`delegated-document-rejection`、`context-observation-sources` 共 17 pass、0 fail，覆盖冻结集合/子集、跨 owner 与撤权拒绝、旧 Run 不扩权和越权来源拒绝；不代替真实模型注入评估。
- **3.2**：`elapsed-zone-followup` 7 pass；`brief`、`tool-projections`、`time-errors`、`reminder-date-anchors` 42 pass，均 0 fail。覆盖真实锚计算、规则故障的 UTC 与显式时区分支、浏览日与冻结时区边界及规则故障就绪状态；不代替原安装自然通知。
- **3.3**：`target-continuation` 23 pass，`direct-reminder` 与 `tool-invocations` 63 pass，均 0 fail。覆盖接受/审计故障回滚、并发重放、异参冲突、同文独立请求、唯一后继和既成回执；不声称语义去重或 PG 与文件的全局事务。
- **3.4**：`workspace-create-target-successor`、`server-owned-permit-race`、`server-owned-driver-effect-race`、`scheduler-recovery`、`tasks-cancel` 共 28 pass、0 fail；覆盖零写接续、许可前停止、迟到追账、失权 unknown、在途写入及取消后的实际通知调用与正控制。受控 fixture 不代替真实 provider 或设备送达。

以上合计 180 pass、0 fail，输出未显示 skip；不能因此勾选完整第 3 节或替代 3.5 原安装混合旅程。

### 已有 PR CI 的逐项证据

[CI 43009746782](https://github.com/BqLee-AI/Along-agent/actions/runs/43009746782) 关联 PR head `f82a9a58721494533f2759fcff083715f95d366c`；实际 checkout 是测试合并提交 `d2c63eee1720212f37ea1935d36050c23e901fec`，父提交为 main `85026e3` 和该 head，两者对应的测试树与 head 树同为 `25e51b6a69135bac9b564e843346410fc0248ef8`。五门均成功；这是 GitHub 隔离 CI，不是原安装或真实 provider。后续若只变验收文档，可按未变运行代码复用下列行为证据，但不能冒称新提交五门已运行。

- [contracts-dual 原始输出](https://github.com/BqLee-AI/Along-agent/actions/runs/43009746782/job/130486897962)：CI 重建当前 native 并运行隔离正式消费者，277 pass、0 fail、28 文件；日志包含真实 native/PG 的 unknown 后停止、取消前置、预算不足不请求模型、已接受设置在预算失败后保留，以及 delegated 文件创建、冲突、缺少新读和 unknown HTTP 消费者。模型响应受控，不能用于自然语言语义或原安装结论。
- [migration-scan 原始输出](https://github.com/BqLee-AI/Along-agent/actions/runs/43009746782/job/130486898072)：PG16 集成 587 pass、34 skip、0 fail；skip 不计通过。已执行的用例包括真实锚加 180 秒及同调用重放、规则缺失的 UTC 分支与显式时区拒绝、旧冻结 Run 不扩权、过窗不创建、创建与接受故障回滚、同键异参冲突、取消回执和未知效果不换槽重写。迁移收敛另有 73 pass、0 fail；这些是任务自有 CI 服务和 fixture，不证明原安装升级。
- `migration-scan` 跳过项包括完整 native HTTP 断连/停止/预算和 server-owned 在途写入、后台继续与跨进程恢复，不能把该门成功记为这些用例通过。本次上方 180 项独立补验含 server-owned 在途写入两个用例；其他跳过路径仅在相应历史证据或其他明确消费者覆盖范围内复用。

### 任务自有文件挂载护栏实验

Linux 隔离容器以只读根和旧资料挂载、独立可写编辑及输出卷、无网络和无 capabilities 运行目标源码的 `publishWorkspaceCreate`、`publishWorkspaceReplace` 与读取函数；使用模拟 advisory lock，而非真实 PG 许可或完整 native/gateway 派发。允许的文件实际创建、替换和独立容器读回；旧资料直接写入/重命名遭 `EROFS`，业务入口拒绝未授权目标、符号链接、硬链接和路径穿越，已有文件创建及陈旧版本替换返回零写冲突。

但容器内直接 OS 写入同一可写编辑目录的其他文件、在输出目录创建未授权文件均成功，故该方案不能限制到唯一目标。额外探针将任务文件作为单文件卷子路径挂载：产品替换函数在原子 `rename` 时返回 `EBUSY`，文件版本不变；不能用这种挂载既隔离该文件又保持现有替换路径。旧资料、编辑目录和输出目录切回只读后实测不可写，另对仅任务自有卷恢复可写并验证；这不证明原安装挂载切换、冻结 grant 的物理身份或在途效果安全。一个额外探针在完成 Unix socket 访问观察后因重复清理 socket 返回 `ENOENT` 并以 1 退出，保留该失败；网络隔离也不等于封锁同容器 IPC。

### 任务自有数据库作用域实验

在独立 PostgreSQL 16.15、迁移 0001–0027、Bun 1.4.2 环境中构造非 owner、非 superuser、无 `BYPASSRLS` 的运行角色，对 35 张 public 表启用 `RLS + FORCE RLS`，仅为固定测试 owner、Run、task 和关联事实设置白名单，其余默认拒绝。实验连接实际进入目标源码的 driver、scheduler 和独立通知接收池；测试数据是直接构造的隔离 fixture，依赖及包构件未证明与最终源码完全一致，不是真实 provider 的新提醒。

受限角色运行真实 driver 后，白名单 Run 的 attempt 为 `fenced_out`、Run 为 `failed`；同 owner 旧 Run 和另一 owner Run 均保留 `running`。真实 scheduler 使白名单任务从 `saved` 到 `fired` 并产生站内 `sent`，两个旧任务仍为 `saved`、原 schedule outbox 仍 pending；另一逾期样本只将白名单任务记为 `missed`。改用隔离 superuser 的反向对照后，两个旧 Run 均被 fence、两个旧任务均被标记 missed。跨 owner 插入、绕过 RLS、设置 replica 和 `TRUNCATE` 均被权限拒绝；同 owner 旧任务和另一 owner Run 的更新影响零行。identity-mail 仅验证一条过期 rate-limit 维护行在受限角色下保留、管理员下删除，没有验证邮件投递。

该策略**不能用于原安装**：固定 ID 不允许正常接纳时生成的新 Run/task，其他表默认拒绝也阻断登录及完整调用；仅按 owner 放行则不能保护同 owner 的历史对象。受管入口现有迁移与运行共用 superuser，实验角色执行迁移被拒；所有实际连接、身份、调用账、审批、外发、并发、崩溃、将来的表和迁移仍无完整可逆策略。首次实验缺 sequence 权限导致 driver 事务回滚，补权并重建隔离库后才取得上述结果；夹具缺来源及字段的失败也保留，均不是产品行为 Red。该实验既没有部署到原库，也不覆盖文件系统护栏。

### 动态授权及目标级 DAC 补充实验

在任务自有 PostgreSQL 16.15 应用 0001–0027，以 `f82a9a5` 的 `createTaskWithinTransaction` 产生真实随机 task ID。临时适配器拦截该插入参数，由隔离管理员连接先将 ID 加入受保护授权表；非 owner、非 superuser、无 `BYPASSRLS` 的运行角色随后同事务写入 task、`created` 和 pending schedule outbox。运行角色直接修改授权表被拒（`42501`），未授权随机 ID 插入被 RLS 拒绝，同 owner 旧 task 的更新为零行；管理员撤销新 ID 授权后，再更新该 task 为零行。

另一个隔离库对新 Run 使用产品的 `insertMessage`、`insertRun`、`insertAttempt` 写入函数及同一事务，由测试操作员先为随机 Run ID 登记授权后成功提交 Run 与 attempt；未授权插入和自行修改授权表被拒，同 owner 旧 Run 更新为零行，撤销新 Run 授权后更新也为零行。该实验未调用完整 `startConversationRun`，消息表未实施完整 RLS。同一事务内的新输入 message 在运行连接可见，但独立管理员连接在提交前不可见；实验是操作员强行授权，而非授权者核实该来源。

这些结果只证明预先获权后的局部 RLS 行为，不证明可信准入：task 适配器持有管理员连接并信任拦截的来源，Run 探针的独立连接又无法核实未提交的来源。两者的授权都在产品事务外，回滚清理、并发撤销、完整工具派发和全表覆盖均未证明；不能将隔离策略用于原安装。需要独立可信的授权主体、来源核验及事务/回滚关系，并在 API/worker 启动前分离所有运行连接和迁移角色。

另在无网络的任务自有容器 overlay 文件系统验证普通进程身份隔离：目标目录属于 UID 1001，权限为 `0700`；以该 UID 调用产品 `publishWorkspaceReplace` 和 `publishWorkspaceCreate`，分别经原来的临时文件加 `rename`、`link` 成功发布，独立进程读回。UID 1002 对目标、符号链接别名、其他文件和目录内创建、rename/link 均被拒绝；但发布 UID 1001 可直接改写未授权文件，并创建、链接和重命名任意别名。目录 DAC 保护了不同身份，不能限制拥有父目录写权限的发布身份只写单一目标。首次容器准备因缺少 `FOWNER` 在权限设置阶段失败，补齐实验所需 capability 后才执行发布探针。

此文件实验直接调用发布函数，数据库 advisory lock 为测试替身；不是有效 gateway/native 派发或真实 PG 许可，不覆盖真实挂载、原 grant 物理身份、并发和在途撤销。现有实现依赖目标父目录中的随机临时文件及原子发布；要作为独立护栏，必须同时约束发布身份自身的目标范围并保留这些系统调用。

FUSE 可用性另在无网络、自有容器内探测：显式映射 `/dev/fuse` 后设备可打开，但默认权限下 mount 被拒；加 `CAP_SYS_ADMIN` 后裸 mount 返回成功。未实现 FUSE 服务端，没有证明逐目标强制 `rename`/`link` 或保留原挂载 `dev/inode`；无服务端的卸载阻塞后仅终止该任务自有容器。这个结果既不是可用护栏，也不证明 FUSE 本身不可行。
