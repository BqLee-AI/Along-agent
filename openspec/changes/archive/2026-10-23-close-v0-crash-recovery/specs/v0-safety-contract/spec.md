## MODIFIED Requirements

### Requirement 5: 取消计时与回执门

系统 SHALL 以 `cancel_pending` 提交事务落定为取消已提交计时点；无 `schedule_receipt` 不标 `scheduled`，无撤销回执不标 `cancelled`。崩溃恢复按 `docs/design/08-scheduler-and-delivery.md` §7–§9 区分确定未调用、独立接收与未知；可能已调用而无接收事实时只核对，不承诺任务必完成，不盲重发。具有有效接收事实的项恢复只核对收尾。

#### Scenario 5.1 取消竞争两终局

- WHEN 取消与到点并发
- THEN 或 `cancelled` 后无 `fired`，或 `fired` 后取消 `409`，无中间态；取消已提交后触发数为 0（映射 F2）

#### Scenario 5.2 已接收后 kill 只核对完成

- WHEN 本地接收事实已独立提交而 worker 结果尚未提交，worker 被真实 SIGKILL 后 resume，task 的 owner/版本/冻结时刻仍匹配且未取消
- THEN 只核对该事实并原子收尾，同 task 跨重启实际 provider 调用累计 1，接收事实 1、通知 1、fired 1；不得再次调用；回执不表示用户收到或看过（映射 F1/A3、D8/D10）

#### Scenario 5.3 许可后无事实可保持未完成

- WHEN 一次性调用许可已提交，worker 在调用前或接收事务提交前被真实 SIGKILL，恢复无法找到匹配接收事实
- THEN 只核对而不重新调用，不伪造通知或 fired；允许待核对及超窗 missed/未完成；实际调用累计可为 0 或 1，但不得增至 2；不宣称任意崩溃点必完成（映射 A3、D9/D10）

## ADDED Requirements

### Requirement: 本地发送许可与独立接收

系统 SHALL 遵循 `docs/design/08-scheduler-and-delivery.md` §7–§9，以持久一次性许可区分可发送与可能已发送；仅当前成功领取许可的执行可在重新通过 task/outbox 栅栏后调用；notifications 模块独立提交接收事实并通过公开 service 核对。取消提交后不得调用。未知不重发，唯一通知行不替代实际调用证据。

#### Scenario: 确定未许可的崩溃可正常恢复

- WHEN claim 已提交而调用许可未提交，worker 被真实 SIGKILL 后恢复，task 仍符合版本/时刻/登记回执及发送宽限
- THEN 可领取一次许可并正常发送；并发恢复最终实际调用 1、接收事实 1、通知 1、fired 1，许可事务失败不残留半结果（映射 A3、D3/D4）

#### Scenario: 接收匹配和独立提交

- WHEN 接收事实已提交后回答丢失或 worker 结果事务回滚，或核对输入带错 owner/task/版本/冻结时刻/发送键
- THEN 匹配事实跨连接和重启存活，通知由接收端独立提交、worker只核对幂等收尾，错绑定不获成功也不触发；不因外层 task 锁、FK 或池饥饿形成接收锁环，不新增跨模块写事务（映射 A3、D1/D3/D9）

#### Scenario: 许可不越过取消

- WHEN 一次性许可提交后取消先提交，或取消与调用串行竞争
- THEN 调用前重新栅栏拦住已取消项，取消提交后实际调用 0；无撤销回执仍 pending，历史接收事实不授权取消后调用或 fired（映射 A3、D9）

#### Scenario: 核对宽限与终态重启

- WHEN 有效接收事实在截止前已提交但恢复核对迟于 fire+15min，或无事实项已超窗，或终态后重启
- THEN 已接收项可只核对完成历史结果，无事实项不补发并诚实保留未完成，终态不重复调用/通知/fired；升级旧不确定 send 不得直接重放（映射 A3、D5/D9/D10）
