# 08. 调度与投递（Scheduler + worker + Notifier）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：worker 角色、PG lease、触发门禁、outbox、ACK_UNKNOWN、15min missed、重约；§7–§9 定义 A3 一次性许可、独立接收与未知未完成边界
- **不包含**：Notifier 通道选型、Redis 演进、K8s 部署；实现代码、SQL
- **阶段标签**：v0 / P0（单镜像 api|worker|all 角色，compose 冒烟）

## 引用

- B06 §6 R 状态机/门禁/outbox/退避、§9 取消召回重约、§10 口径；B03 §6 部署；B05 阶段 3

## 0. 设计结论

- [Required] 服务端 TS 模块化单体，一个镜像按 `api | worker | all` 角色启动；Postgres 唯一事实源；Redis 延后。
- [Required] 登记成功以回执为准；触发门禁三查不过即拦；超 15min 标 missed 不补发。
- [Required] ACK_UNKNOWN 只核对不重发；取消优先；重约走新 task。

## 1. worker 角色 [Required]

```text
api     接 HTTP/SSE（brief、messages、approvals、tasks、cancel）
worker  扫 outbox → schedule 登记 → 到点 lease 认领 → 门禁 → Notifier.send → 写事件
all     单机 compose 冒烟（api+worker 同进程不同循环）
```

- [Required] 幂等键贯穿 outbox → schedule → send；同一幂等键重试不问用户。
- [Proposed] 30s 扫一次 outbox（起步值，待校准）；版本变/已取消标 SUPERSEDED 不发。

## 2. PG lease + fencing [Required]

```text
lease
  task_id / expected_state_version / lease_owner / lease_expires
  认领：行锁 + 验 state=scheduled + 验 version + 写 lease_owner/expires 同事务
  fencing：expected_state_version 对不上不发
```

- [Required] 崩溃恢复区分确定未调用、已接收、可能已调用；禁止把 lease/fencing 或唯一通知行宣称为任意故障点请求严格一次且必然完成，见 §7–§9。

## 3. 触发门禁三查（到点先查三样）[Required]

1. task 行对得上（id + fire_at_utc + version）。
2. 状态是 scheduled。
3. 登记凭据绑同一 task（schedule_receipt 一致）。

- 查到一半变了先拦、不重查放行，等重新确认。
- 撤销待确认（cancel_pending）的直接拦：“已拦截本次触发，系统排期是否撤掉仍无法确认。”

## 4. outbox 与重试 [Required]

```text
outbox 行
  task_id / expected_state_version / command（含幂等键） / attempt_no
```

- 发送前先持久化一次性许可，再重新验栅栏并调用；许可已提交但无接收事实时只核对，不盲重发（§7）。许可不是送达证明。
- 仅明确拒绝且能证明未接收的通道可按既有 1min/5min、最多三次退避；本地 inapp 的异常/无回答不属于可重发拒绝。
- ACK_UNKNOWN 按 30s/2min/5min 核对，次数达 3 后保持 3、每 5min 继续核对至宽限；无事实不伪造成功。超原到点 15min 不发新请求；有效历史接收的核对不算补发。

## 5. 15min 与重约 [Required]

- 到点 15min 内私密触发一次（起步值，待校准）；超时记 missed，不补发。
- 一键重约开新 task，`recreated_from` 指旧 task；内容当候选、时间重给，不继承旧确认。

## 6. 诚实口径 [Required]

- 确认时显示（起步文案）：“提醒已保存在云端；到点会在调度器成功运行时尝试通知。关机、休眠或队列拥堵可能错过，不保证准时响。”
- `schedule_receipt / provider_receipt_id` 只证明接口收了，不证明用户看见。

## 7. 一次性调用许可与未知边界 [Required]

用户选择安全优先：可能已调用时允许待核对或超窗未完成，不承诺任意崩溃空隙均严格一次且完成。已接收项只核对后完成，取消提交后实际调用仍必须为零。

1. claim 提交的 dispatched send 仅为候选。调用前独立事务按 task→outbox 锁序核对 owner/task/command、冻结 fire_at、expected version、scheduled、schedule receipt 与发送宽限，将 send 比较更新为 acked_unknown 并提交首次核对时间。只有成功转换的当前执行取得一次许可；重启、并发输家不能从 acked_unknown 重获调用权。
2. 获许可后重新开事务、按相同锁序重新核对完整栅栏及实际当前时刻；调用全程持 task 锁。两事务间取消先提交即拦截；已在调用则取消等待该锁，不能先提交取消再让旧调用发生。保留既有撤销回执门。
3. provider 异常、进程死亡、回答丢失不得撤销已提交许可或回到 dispatched。许可后无接收事实，实际调用可能为 0 或 1，只核对，不写伪通知/fired。没有许可的候选可恢复为一次正常发送。

## 8. 独立本地接收与 worker 收尾 [Required]

复用 notifications 为本地接收事实与站内记录，按 send key 唯一，新增 nullable `fire_at_utc/expected_state_version` 完整绑定 owner/task/fire/version（字段见 commitments schema）。生产本地 provider 在**独立连接/独立事务**插入 sent 通知并返回 `inapp:<notification-id>`，worker 结果回滚不删除它。旧无绑定通知不回填成新协议接收证明，唯一行不能替代实际调用计数。

- 所有发送路径持有的 task 行锁使用 `FOR NO KEY UPDATE`，不可被内部 helper 升级为 `FOR UPDATE`。它仍串行阻止取消/其他状态写入，但允许独立接收插入既有 task FK 的 KEY SHARE 检查；保留 FK，不新增接收表。task ID/冻结键不得更新。
- worker 生命周期拥有同 DSN 的专用接收小 pool（max=1），不与可能被等待 task 锁的请求耗尽的外层 pool 争连接；API-only 不建该 pool，无新环境变量，退出时关闭。provider 不反向锁 task/outbox，不在接收事务更新任务。
- 跨模块引用传 owner/task/send key，notifications 经任务公开只读 service 取得冻结展示/绑定，不直读 tasks 私有 repository；公共调用关系保持无环。notifications 自己提交通知，worker 自己提交 task fired、唯一 fired 事件、send 结果，不新增跨模块写事务。旧 worker 事务内插通知路径移除。
- task 模块只经 notifications 公开 service 核对完整 receipt。匹配后仅原子收尾 task/fired/outbox，不再次调用或重写通知。接收与 fired 不原子，故页面可能先见 sent 记录、后见 fired；这表示真实已存站内记录，不是设备送达或读回执。
- 旧 owner/task/fire/version、错 key、已取消或终态不能借 receipt 越过栅栏。若接收后 worker 死亡、取消先于 fired 收尾提交，可保留取消前的历史通知，但不得取消后再调用或追加 fired；不能删除历史记录伪造零调用。
- missed 在同 task 锁内先核对有效 receipt：已接收则仅完成历史收尾；无事实且超窗则 missed/failed_deadline，原因保留为不确定未完成。终态后迟到接收仅保留真实记录，不复活旧任务、不补发、不伪造 fired。

## 9. 迁移、故障与验收 [Required]

新增下一序号迁移为 notifications 增加接收绑定列及完整性约束；停旧 worker 后，该迁移将旧库 scheduled task 的活动 send（pending/dispatched/acked_unknown）统一置 acked_unknown，保留 ack_check_no、设置首次递延核对与 `legacy_send_uncertain`，不补造 receipt。迁移账本确保只执行一次；新代码先迁移再启动，缺列不退回旧发送。旧 worker 不得与新协议并跑。空库与升级库均验，不修改旧迁移或要求操作者手改业务行。

真实 Web/SSE/按钮建立故障任务；SQL只读。真实 SIGKILL 覆盖许可前、许可提交/调用前、provider 入口/接收提交前、接收提交/回答前、worker 结果提交前、终态后；checkpoint 到达、实际调用、receipt、通知、fired 分别取证。回答丢失在生产接收已提交后中断回答，不用假返回或填表模拟。

- 已接收恢复：跨进程实际调用累计 1、receipt 1、通知 1、fired 1；无许可恢复正常一次；许可后无事实允许调用 0/1、未知或超窗未完成，但不允许第二次调用。
- 取消：从 cancel_pending COMMIT 覆盖原 fire+15min 后至少两个实际 worker tick；取消后实际调用 0，同期正控制 1。心跳不替代 tick，零通知不替代零调用。
- 真实同镜像 ROLE=all+PG16+Compose+外部 Web/session 是独立部署验收；故障拆 api/worker 角色不是 all 业务验收。每个结果关联 source/image/输入/ID/时间窗，未观察到的像素或边界不宣称已验。
