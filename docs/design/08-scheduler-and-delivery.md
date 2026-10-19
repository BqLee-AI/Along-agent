# 08. 调度与投递（Scheduler + worker + Notifier）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：worker 角色、PG lease、触发门禁三查、outbox、重试语义、ACK_UNKNOWN 只核对、15min missed、重约 recreated_from
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

- [Proposed] Spike S2 门（与 P1 并行，P2 末结案）：kill -9 后 resume 副作用恰好一次。

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

- 验版本 → 发请求 → 记结果；发了没回记 ACK_UNKNOWN，只核对不重发（30s/2min/5min 各核一次，起步值待校准，还未知转持久对账）。
- 最多 3 次退避（首次后 1min、再 5min，起步值待校准），同一幂等键；目标时间已过记永久终态；task 已取消标 cancelled（取消是终态不是故障）。
- 离原定不足 15min 不试，记 FAILED_DEADLINE_WINDOW，请新建。

## 5. 15min 与重约 [Required]

- 到点 15min 内私密触发一次（起步值，待校准）；超时记 missed，不补发。
- 一键重约开新 task，`recreated_from` 指旧 task；内容当候选、时间重给，不继承旧确认。

## 6. 诚实口径 [Required]

- 确认时显示（起步文案）：“提醒已保存在云端；到点会在调度器成功运行时尝试通知。关机、休眠或队列拥堵可能错过，不保证准时响。”
- `schedule_receipt / provider_receipt_id` 只证明接口收了，不证明用户看见。
