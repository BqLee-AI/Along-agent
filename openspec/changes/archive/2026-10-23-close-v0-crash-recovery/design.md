# A3 崩溃恢复设计

## 1. 决策与边界

用户已明确选择“安全优先，允许不确定未完成”。一次性调用许可与函数调用不是原子操作。许可提交后进程死亡且没有接收事实时，不能推断从未调用，也不能靠重试消除未知。该项只核对或超窗未完成，不伪称通知成功；具有已提交接收事实的项可以只核对后完成通知/fired。取消提交后实际调用必须仍为零。

设计真源：`docs/design/08-scheduler-and-delivery.md` §7–§9。现有 Requirement 5 的取消竞争与回执门保留；Scenario 5.2 的无条件“kill 后一条通知/fired”明确改成有接收事实的恢复场景，并为许可空隙增加独立验收。此为用户批准的保证修订，不用唯一通知行掩盖重复实际调用。

## 2. 最小生产机制

### 2.1 一次性许可

沿用 outbox 与既有 `acked_unknown`，不加 task 状态/事件。claim 只产生可领取的 dispatched send，不授权调用。发送先独立事务按 task→outbox 顺序锁定，核对 owner/task/command、冻结 fire_at、expected version、schedule receipt、当前 scheduled 和宽限；随后把该 send 改为 acked_unknown，保存首次核对时间，提交。仅成功完成此状态转换的当前执行栈获得一次调用许可；并发输家及重启扫描不得依据 acked_unknown 重新获得许可。

许可提交后立即另开发送事务，重新按相同次序锁定并核对完整栅栏。只有许可仍匹配、task 仍可触发时才调用 provider。事务在实际调用全程持 task 锁，使取消只能在调用前提交并阻断，或等待已开始的调用事务结束。取消在两事务之间提交时，第二次栅栏必须拦住调用。仅 lease/内存 token 不构成恢复许可。

provider 抛错或回答无法证明结果时保留已经提交的未知许可，不能回到 dispatched。只有显式拒绝且有可信“未接收”证明才能按既有退避重获新许可；当前本地 inapp 不引入这种拒绝重试分支。原有通用“拒绝就重试”不得作用于无法判明接收结果的本地调用。

### 2.2 独立本地接收事实

复用 notifications 为本地持久接收与站内记录，新增 nullable `fire_at_utc/expected_state_version`，与 owner/task/send key 完整绑定；旧记录不回填成接收证明。生产provider在独立连接/事务插入 sent 行，成功后返回 `inapp:<notification-id>`。同键冲突只在完整绑定、status/sent_at均匹配时返回原回执，不覆盖错误绑定或旧无元数据记录。worker结果事务回滚不抹去这行。

为保留既有task FK且避免锁环，发送路径所有task锁统一为 FOR NO KEY UPDATE，不得被helper升级为FOR UPDATE。PostgreSQL16双连接机制探测已观察：FOR UPDATE使独立FK INSERT超时57014；FOR NO KEY UPDATE允许该INSERT独立提交，同时仍使取消UPDATE超时，释放锁后取消才提交。此仅为锁机制实证，不是A3实装或真实强杀验收。task ID/冻结键不可变；实施须完整核对锁调用点并在真实任务FK/取消路径再验。

接收连接使用worker专属同DSN小pool（max=1），不与被等待task锁的请求耗尽的外层pool争抢；由worker启动/关闭，API-only不建，无新env。跨模块引用仅owner/task/send key，notifications经任务公开只读service取得冻结展示/绑定，不直读私有repository；调用关系保持无环。接收事务只写notifications、不反向更新task/outbox，不新增跨模块写事务。

### 2.3 收尾与核对

通知由接收端独立提交；收到匹配回执后，worker仅将task→fired、唯一fired事件、当前send结果在自身事务原子提交，不再插/改通知。该事务失败后通知接收事实保留，恢复只经notifications公开service查询并幂等收尾，不调用provider。页面可先看到sent站内记录、后看到fired；并非设备送达或用户阅读证明。移除旧worker事务内插通知路径。

ack 阶段通过公开 service 查询 receipt，不直读 notifications 存储来猜测接收。只在同 owner/task/fire/version、task 仍 scheduled、receipt 匹配且未取消时收尾；旧版本、旧时刻、错 owner、错命令或取消后的事实不能触发状态迁移。取消优先：原调用可能在取消提交前已接收，其历史 receipt 不意味着取消后允许再触发；不把已有事实删除来伪造零调用。

无 receipt 时按既有 30s/2min/5min 核对；核对次数用尽保持计数3、每5min递延，不得误标为接收失败或允许重发。继续以既有 acked_unknown 表达未知，不添加事件词。missed 阶段在同 task 锁内先核对 receipt：有效已接收项仅完成历史收尾，无事实且超原 fire+15min 则 missed/failed_deadline，保留不确定未完成原因。事实若在 missed 终态后才出现，仅保留独立事实供核对，不复活旧任务、不补发、不伪造 fired。

## 3. 竞争与原子性

- 并发 worker：领取 outbox 的状态比较是唯一调用许可门；重复 ack、过期 lease 和重启不能再次调用。
- 许可事务失败：没有许可也没有调用，完整回滚；可重新扫描。
- 许可提交后、provider 前强杀：无 receipt，调用累计可为 0；恢复仅核对，允许最终 missed。
- provider 已进入、接收事务未提交强杀：调用累计 1、无 receipt，恢复仅核对；不能伪造成功。
- receipt 已提交、返回丢失或 worker 结果事务回滚：调用累计 1，恢复通知 1/fired 1。
- 终态后重启：不再次调用，不重复事件/通知。
- 取消与许可/调用并发：保留 task→outbox 锁顺序；取消先提交则实际调用 0，许可不越过取消。没有撤销回执仍不能 cancelled。
- 规则不可用：既有冻结任务发送、核对与取消不依赖新 normalize/readiness 门，协同 A4。

## 4. 真实验收与证据

生产 Web/SSE/按钮创建每个任务，保留输入、approval/task、fire、send key、receipt、状态版本和镜像/source关联；SQL只读，不改到点、不灌 lease/receipt/通知。独占 PG16、实际服务端镜像 ROLE=api/worker，可故障拆角色观察；最终同镜像 ROLE=all+Compose+真实 Web另验。

用真正 SIGKILL，分别在无许可、许可提交/调用前、provider 入口/接收提交前、接收提交/回答前、worker 结果提交前、终态后故障。检查点必须证明具体阶段；暂停点不等于正常连续运行证据。真实 provider 入口计数与 receipt/通知/fired 分开采集；每组有正控制，重启累计，不用进程心跳代替 tick。回答丢失使用生产接收事务已提交后中断回答的实际窗口，不用假 `delivered/answered` 返回值或 SQL 填回执。

有 receipt 的项：实际调用累计 1、receipt 1、通知 1、fired 1；确定无许可项恢复后正常调用 1；许可后无 receipt 项调用可为 0 或 1，不重发、无伪通知/fired，允许未知/超窗未完成。取消项从 cancel_pending COMMIT 到原到点+15min 后至少两个实际 worker tick，实际调用 0；观察器同期正控制调用 1。旧 #26 证据仅适用于未变范围，新的发送/核对路径必须重新证明取消边界。

## 5. 迁移与交付

新增下一序号迁移为notifications添加完整接收绑定两列及同空/同非空、正版本约束；旧行列为空，不回填receipt，不改旧迁移。停旧worker后，该迁移将旧库scheduled task的活动send（pending/dispatched/acked_unknown）统一置acked_unknown，保留ack_check_no，设置首次递延核对及legacy_send_uncertain；迁移账本确保只执行一次。新代码先迁移再启动，缺列不退回旧发送，旧worker不得并跑。缺事实允许missed，不要求操作者手改状态；验空库与旧dispatched/acked_unknown升级库。

先独立契约 review、精确 head 五门 SUCCESS/CLEAN 合并；再实现回归、真实强杀/取消、同镜像部署、独立证据审查、archive。实现不得以“单元测试绿”代替上述真实边界。
