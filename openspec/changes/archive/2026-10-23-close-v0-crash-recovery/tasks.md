# Tasks

## 契约

- [x] 核对发送事务、默认 provider、取消与现有 kill 场景，记录用户选定的安全优先保证。
- [x] 起草 design/PRD/schema 与 OpenSpec delta，分开定义确定未调用、独立接收、未知未完成。
- [x] 独立契约审查；精确 head 五门 SUCCESS、CLEAN 后合并契约 PR（Refs #29）。

## 实现

- [x] 持久一次性许可、二次栅栏、并发/重启不再调用；迁移旧不确定 send，不静默重放。
- [x] notifications 复用通知持久接收/公开核对 service，接收绑定列迁移、专用连接生命周期；兼容 task FK 的 NO KEY UPDATE 锁，取消仍串行。
- [x] 通知由接收端独立提交，worker 仅 task/fired/outbox 原子幂等收尾；无事实只核对，超窗诚实 missed，已接收晚核对不补发，不新增跨模块写事务。
- [x] 保留取消回执/行锁、owner/version/fire/command fencing；删除 obsolete 发送与跨模块直接查询路径。
- [x] 更新受影响回归，证明回滚、错绑定、许可空隙、并发与 pool 饥饿边界（A3、D3–D5/D9/D10）；全量类型/测试与五门不降级。

## 真实验收与收口

- [x] 真正 SIGKILL 覆盖许可前、许可后、接收前、接收后回答丢失、结果提交前及终态后；实际调用分开计数（A3）。
- [x] 真实取消竞争与原到点+15min 后两个实际 tick，取消后调用 0、正控制 1（A3/D9）。
- [x] 同一服务端镜像 ROLE=all+PG16+Compose+真实 Web/session，冻结显示及通知/事件链正确（A1/A3、D1/D2/D8）。
- [x] 记录源码/镜像、输入/IDs、调用/receipt/通知/fired、时间窗及证据局限；独立审查，不把未知当成功。
- [x] OpenSpec 严格校验与 archive；清理本轮独占运行资源，验收数据卷保留备查。

收口合并门：精确收口 head 的五项 required checks 必须全部 SUCCESS、合并状态 CLEAN 后才允许 squash 合并，并在收口 PR 中 Closes #29 / Closes #38。归档及本清单不替代该门。

运行记录：[2026-10-21 A3 证据](../../../../docs/verification/v0-crash-recovery-evidence-2026-10-21.md)、[A1 失败与部署恢复](../../../../docs/verification/v0-a1-recovery-evidence-2026-10-22.md) 和 [2026-10-23 完整验收记录](../../../../docs/verification/v0-closeout-evidence-2026-10-23.md)。原始 A1 保持失败/missed；独立新字面任务自然次日到点，实际调用/通知/fired 各 1，宽限后两个成功轮次及后置只读样本成立，真实任务详情与活动页一致。不用新任务覆盖旧失败，不将旧镜像强杀证据重标为本轮镜像实跑。
