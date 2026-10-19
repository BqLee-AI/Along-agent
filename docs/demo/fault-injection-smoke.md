# 故障注入冒烟

> 状态：v0 可复现。范围：kill worker、取消竞争、tzdb 缺失三类故障。不包含：混沌工程全矩阵、网络分区、多可用区。阶段标签：v0 MVP（S2 级“恰好一次”先行验证）。前置：v0 smoke 步 3–4 已跑通，`task_events` 可查。

## 前置

- 正常链路先绿（简报→确认→task `scheduled`）。
- 准备可观测手段：`GET /tasks/{id}/events`、`outbox` 扫描日志、worker 进程号。
- 取消用例准备一个未来 task（`fire_at_utc` 距今 ≥ 10 分钟）。本地确定性替代：用 DB 时间戳强制过期/改 fire_at（`UPDATE tasks SET fire_at_utc = now() - interval '…'`、`UPDATE task_leases SET lease_expires_at = now() - interval '1 minute'`），不用 sleep，避免 CI 抖动。
- `run_attempts` 为 #9 表，本仓库断言以 `notifications` 同 `idempotency_key` 一行 + `task_events` 仅一条 `fired` 为准。

## F1 kill worker（resume 副作用恰好一次）

- 命令：
  1. task `scheduled` 后，对 worker 进程 `kill -9`。
  2. 重启 worker（同镜像 `worker` 角色），触发 resume（`resume_from` 上一 checkpoint）。
  3. 到点观察通知与事件账。
- 预期 JSON：`GET /tasks/{id}/events` 仅一条 `fired`；通知列表仅一条（同 `idempotency_key`）。`run_attempts` 为 #9 表，不在本仓库断言。
- 断言：副作用恰好一次（通知去重键唯一，无双发）。
- 本地确定性命令（`scheduler-fault.test.ts` “F1”）：`UPDATE tasks SET fire_at_utc = now() - interval '10 seconds'` 后依次跑 claim（worker-f1-a）→ send → send（resume），不断言 sleep。

## F2 取消竞争（取消 vs 到点同时发生）

- 命令：
  1. 在 `fire_at_utc` 前 30 秒内并发发出 `POST /tasks/{id}/actions/cancel` 与等待触发。
  2. 记录两者返回顺序与事件账。
- 预期：两种终局之一，不出现中间态：
  - 取消先提交：`state=cancelled`，之后无 `fired`，余单 `superseded`。
  - 触发先提交：`state=fired`，取消返回“已触发，无法取消”（按 API 篇错误码）。
- 断言：取消已提交后触发请求数 = 0（D9 权威断言在 `scheduler-fault.test.ts` “F2”：cancel 提交后 firing 窗口 `fired` 数=0 + `security_events.cancel_breach` 可记）；分不清先后按违规计，但明说“不等于认定确在取消后发出”，证据留人复核。
- 本地确定性命令（`scheduler-fault.test.ts` “F2”）：requestCancel（无回执→`cancel_pending`）→ send（门禁拦，零触发）→ 租约过期改 `task_leases.lease_expires_at` 测 resume 恰好一次，全程无 sleep。

## F3 tzdb 缺失（服务不就绪，不降级）

- 命令：
  1. 移除/损坏 tzdb 规则内容后重启服务端。
  2. `GET /readyz`；再试 `POST /conversations/messages`（“明天 9:20 提醒我喝水”）。
- 预期 JSON：`/readyz` 返回类型化错误 `{"code": "TZDB_UNAVAILABLE", "retryable": false}`；对话请求被拒（同样错误，不进归一）。
- 断言：不支持组合失败而非降级（a13n 落点）；归一函数连调用都不进；旧 task 不受影响（冻结快照照常触发）。
- 常见问题：`UNKNOWN_TIMEZONE` 与 `TZDB_UNAVAILABLE` 混淆 → 前者是单个时区名非法，后者是整库不可用。

## 断言总表

| 故障        | 恰好一次  | 零触发（取消后）     | 不降级                           |
| ----------- | --------- | -------------------- | -------------------------------- |
| kill worker | 通知 1 条 | —                    | —                                |
| 取消竞争    | —         | 取消提交后触发数 = 0 | —                                |
| tzdb 缺失   | —         | —                    | `/readyz` 类型化错误，拒绝新归一 |
