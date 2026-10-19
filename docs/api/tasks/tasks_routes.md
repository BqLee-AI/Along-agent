# Tasks 路由：任务与事件账

> 状态：草稿，可评审。范围：任务列表/详情/取消/只追加事件账（v0 调度→触发→通知的客户端可见面）。不包含：改期原子替换（v0 用取消重建）、重复任务（v1）、推送通道管理（Deferred）。阶段标签：v0。
>
> 蓝图引用：B06（R 状态机 saved→pending_schedule→scheduled→fired|missed→cancel 路；超 15min 标 missed 不补发；取消后触发数=0 一级指标；06 喝水 task.kind=notify_only 不走 LLM 先验调度）。

## 1. 路由

| 方法 | 路径                         | 鉴权 | CSRF | 幂等键 | 说明         |
| ---- | ---------------------------- | ---- | ---- | ------ | ------------ |
| GET  | `/tasks`                     | 是   | 否   | —      | 任务列表     |
| GET  | `/tasks/{id}`                | 是   | 否   | —      | 任务详情     |
| POST | `/tasks/{id}/actions/cancel` | 是   | 是   | 是     | 取消（幂等） |
| GET  | `/tasks/{id}/events`         | 是   | 否   | —      | 只追加事件账 |

## 2. GET /tasks 与 GET /tasks/{id} [Required]

- `GET /tasks` 查询参数：`status=pending_schedule|scheduled|fired|missed|cancel_pending|cancelled|all`（默认 `all`）、`cursor/limit`（默认 20，上限 50）。只返回本人数据，按 `fire_at_utc` 升序；列表项含 `schedule_receipt`，前端据此显示“有/无登记回执”。
- `GET /tasks/{id} 200 data`：

```json
{
  "task_id": "tsk_01J…",
  "kind": "notify_only",
  "state": "scheduled",
  "fire_at_utc": "2026-10-17T01:20:00Z",
  "fire_at_local": "2026-10-17T09:20:00",
  "timezone_id": "Asia/Shanghai",
  "source_approval_id": "apr_01J…",
  "recreated_from": null,
  "schedule_receipt": "sched_…",
  "created_at": "…"
}
```

- `kind=notify_only`：v0 喝水类提醒，不走 LLM 先验调度 [Required]。
- `schedule_receipt`：有登记回执才为 `scheduled`；无回执停 `pending_schedule`，前端展示“待排期”，不谎称已排 [Required]。
- 口径天花板：详情只报告系统记录到的状态（已保存/已排期/已触发/已错过），不声称用户已读/必达 [Required]。
- 不存在/他人资源：`404` / `403`。

## 3. POST /tasks/{id}/actions/cancel [Required]

请求体：`{"reason": "…"(可选), "idempotency_key": "…"}`。

- 状态流转：`saved|pending_schedule|scheduled → cancel_pending → cancelled`（仅本地撤销回执到才终态 `cancelled`；无回执停 `cancel_pending`，前端展示“取消确认中”）。`fired|missed` 为终态：取消返回 `409 STATE_CONFLICT` + `details.current_state`（“已触发/已错过，不可取消，请新建”）。不存在/非 uuid → `404`；跨 owner → `403`；CSRF 缺失 → `403 CSRF_MISMATCH`。
- 幂等：同一 `idempotency_key` 重复取消返回 `200` + 当前状态，`data.duplicate=true`；`cancelled` 行重复取消恒回 `duplicate=true`；`cancel_pending` 行新 key 补一条 cancel 命令行（旧行由 supersede 清理）。取消提交（`cancel_pending` 落定）后排队重试全作废（`superseded`），取消后触发数=0 为一级指标（破 0 记 `security_events.cancel_breach`，人复核）。
- 无回执不谎称：撤销回执未到前状态停 `cancel_pending`，前端展示“取消确认中”，不展示“已取消”；触发门禁照拦（“本机拦截本次触发，系统排期是否撤掉仍无法确认”）。
- `notifications` 为内部表（v0 无公开路由）：站内信一行一 `idempotency_key`（`send:<taskId>:<fireAtIso>`），`INSERT … ON CONFLICT DO NOTHING` 保证 kill-9 resume 恰好一次；标题/正文只读冻结字段（`wall_time/timezone_id/original_note`），禁时间换算；口径只说“已记录”，不承诺送达/已读。

```json
{
  "code": 0,
  "data": { "task_id": "tsk_01J…", "state": "cancelled", "duplicate": false },
  "msg": "ok",
  "error": null,
  "request_id": "req_…"
}
```

## 4. GET /tasks/{id}/events [Required]

- 只追加事件账只读投影：`task_events` 按 `recorded_at_utc` 升序，分页 `cursor/limit`；DB 禁 UPDATE/DELETE。
- 每行：`{event_id, type, recorded_at_utc, state_version, evidence_ref}`；`evidence_ref` 有凭据写号，无写“本机记录”。
- `type` 封闭集（S0 #14 冻结，以 `docs/design/07 §1` 为准）：`created | scheduled | fired | missed | cancel_requested | cancelled | reconciliation_run`（`missed`=超 15min 不补发；`ACK_UNKNOWN/FAILED_DEADLINE_WINDOW/SUPERSEDED` 只进 outbox.status，不进本账）。
- 前端用此页做“已记录步骤可核对”展示；三种对账话术（没记录到触发/已错过给重约口/对不上暂停等维护者）见 design，不在本接口另设错误码。
