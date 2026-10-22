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
- [ ] 同一服务端镜像 ROLE=all+PG16+Compose+真实 Web/session，冻结显示及通知/事件链正确（A1/A3、D1/D2/D8）。
- [x] 记录源码/镜像、输入/IDs、调用/receipt/通知/fired、时间窗及证据局限；独立审查，不把未知当成功。
- [ ] OpenSpec 严格校验与 archive，精确收口 head 五门 SUCCESS/CLEAN 后合并并 Closes #29；清理独占资源。

运行记录：[2026-10-21 A3 证据](../../../docs/demo/v0-crash-recovery-evidence-2026-10-21.md)。组合镜像 all 绝对时间正控制完成；原始字面 A1 因引擎中断未在 2026-10-22T01:20Z 后宽限内触发，恢复后诚实 missed。失败与独立新任务见 [A1 恢复记录](../../../docs/demo/v0-a1-recovery-evidence-2026-10-22.md) 和 [#38](https://github.com/BqLee-AI/Along-agent/issues/38)。新任务自然到点为 2026-10-23T01:20Z，不能将其登记或此前正控制冒充完整 v0 通过；本 change 暂不归档、关闭 issue 或清理验收环境。
