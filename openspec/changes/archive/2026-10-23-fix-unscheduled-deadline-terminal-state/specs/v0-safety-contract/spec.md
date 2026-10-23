## ADDED Requirements

### Requirement: 未排期过窗必须终结

系统 SHALL 按 `docs/design/08-scheduler-and-delivery.md` §4–§5、§8 的取消优先与回执边界，在任务锁及同一事务内将超过触发时间 15min 的 saved/pending_schedule 任务转为 missed，追加唯一对应事件并终结排期队列；不改变冻结时间、不补发、不伪造 scheduled/sent 或回执。恢复扫描 SHALL 包含旧 worker 已终结 schedule 命令但仍残留的未排期活跃任务。

#### Scenario: 首次调度已过窗

- WHEN 用户已确认任务但从未完成排期，worker 首次处理时已超过触发时间 15min
- THEN saved 或 pending_schedule 转为 missed，schedule 命令终结、事件只有 created/missed，schedule receipt 和通知均不存在，provider 实际调用为零（A1/A3、D5/D9）

#### Scenario: 旧命令终结后恢复及重复处理

- WHEN 未排期任务已过窗且 schedule 命令已被旧 worker 标为 failed_deadline，或多个 worker 重复/并发处理同一过窗任务
- THEN 仍能恢复到 missed，每任务仅一条 missed 事件、状态版本仅递增一次，不重开旧命令、不调用 provider（A1/A3、D5）

#### Scenario: 取消先提交及已排期接收边界

- WHEN 取消先于 missed 转移提交，或已排期任务存在需要核对的真实接收/未知发送结果
- THEN 未排期终结不覆盖 cancel_pending/cancelled；取消仍需真实撤销回执，已排期沿用原接收核对和未知不盲重发规则，不借此新增 fired 或调用（A3、D9）
