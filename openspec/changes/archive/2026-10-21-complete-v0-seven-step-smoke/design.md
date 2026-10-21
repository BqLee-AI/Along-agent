# Design：既有任务详情承载站内通知

## 结论与规划基线

本 change 只新增通知读取合同；七步与取消安全要求引用既有合同，不另定义取消状态机。字段与接口真源见 `docs/design/03-v0-vertical-slice.md` §3.1–§3.2、`docs/api/tasks/tasks_routes.md` §2.1；本文件解释实现边界，不表示代码已实现或验收通过。

Observed（规划研究基线 `e98f29f`，非实现实时状态）：`tasks/service.ts#getTaskDetail` 只返回任务字段；通知已持久化而 Web 无通知面。`registry.ts` 用内存 Set，取消 worker 仅检查它，无生产回执来源。这个缺口解释下述读取增量与实际撤销要求；实施及验收事实保存在 tasks 和独立运行记录中。

## 通知读取与 DTO

Required：沿用 `GET /api/v1/tasks/{id}` 的成功 envelope，在 `data` 增加必有的 `notifications` 数组，空态为 `[]`。每项仅为现有通知 `id/title/body/status/sent_at` 的投影；类型、空值与实际 `pending|sent|failed` 状态域以 design/03 §3.1 为准。`sent_at` 只序列化存储时间，不补造；标题/正文取已存文本，不根据当前 task/UTC/浏览器时区重建。

建议读取链：

```text
真实 session → tasks 详情校验 task/owner
             → notifications 公开 service(ownerId, taskId)
               → notifications 自有 repository：同时限定 owner_id、task_id
             → tasks 组装详情 DTO → 既有 HTTP → Web 任务详情
```

只有 ID 跨模块传递，通知查询由通知模块拥有。tasks 不引用通知 repository/schema、不直接查询通知表，Web 不引用 API 源码或访问 PG；复用现有 tasks→notifications/service 合法边，不增加跨模块事务或读取豁免。不新增表、迁移、索引、路由、分页或任务列表字段；既有 task 索引足以支撑本次单任务查询，不在无规模证据时引入缓存。

不存在/非 UUID `404`、跨 owner `403`、未认证 `401` 沿用详情；不会泄漏通知或回成功空态。通知查询失败沿详情错误路径失败，不能 catch 后回 `[]`。读取不调用 provider、不重试、不标已读，不写任何业务对象。worker 新提交通知后，下一次成功详情读取即可包含该记录；不新增推送或实时订阅保证，也不承诺详情内 task 与通知具有额外的跨模块原子快照。

Web 任务详情增加小型站内通知区域，原样呈现记录或明确空态；`sent` 仅是站内记录状态，不翻译为设备送达或用户已读。不把 `fired` 文案冒充通知正文，事件账与通知各自展示、分别取证。

## 取消回执与证据：落实而非改约

Required：沿用 `openspec/specs/v0-safety-contract/spec.md` Requirement 5、design/07 §3。取消提交计时点仍是 `cancel_pending` 事务落定；实际完成本地队列撤销、核对 fencing 后持久化本地撤销回执，再进入 `cancelled` 并同事务写事件。复用 outbox 现有回执字段及 cancelled 事件，不修改旧迁移，不新增内存事实源；API/worker 拆进程或重启后须能读到持久事实。没有真实回执仍停 pending，不能在正式进程调用测试回执注入器或直接改状态以通过 smoke。

取消后 provider 实际调用数按 design/07 §3 单独观察，计数点是 `deliverInApp` 内调用实际 provider 的瞬间；零通知/零 fired 不等价于零调用。优先受控单 worker 的非暂停 debug logpoint，以同进程正向任务的一次调用作正控制；若无法可靠捕获，只增加不含提醒内容、token 或 secret 的最小调用证据及定向测试，不建设遥测框架。不确定调用先后按既有违规待复核口径处理，不降低标准。

## 取舍、交付与验证边界

不选择独立 `/notifications` API：当前需求只是按任务核对已存记录，增加路由、全局列表与读状态会扩大公开合同。不选择 tasks 直接读通知表：会绕过既有 notifications 所有权。选择服务调用与必有数组，代价是详情多一次只读查询，无新持久状态；通知仍是内部表，只经任务详情投影。

先独立 spec PR 合并，之后才实现 DTO/service/Web 与真实取消回执、定向测试；再依 `docs/demo/v0-slice-smoke.md` 真实执行七步并按 closeout plan 留证，最后 archive。spec PR、实现 PR 与收口分别 review，均保留既有五门；spec 批准与 CI 绿不等于真实 smoke 已执行。

七步包含正向真实到点与另建任务取消，证据须跨过取消任务原到点及宽限窗口；完整 A2 替代确认、A3 kill/resume、A4 时间错误/规则缺失冲突本次不修、不改约、不标通过。D1/D2/D8/D10 与 A1 的通知新增场景见本 change 的 safety delta；D9 与取消沿用已有要求。具体可审查验收与 archive 顺序见 tasks，不在 spec 中重复业务模型。
