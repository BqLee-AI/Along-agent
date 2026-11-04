# Tasks 路由：任务与事件账

> 状态：草稿，可评审。范围：任务列表/详情/取消/只追加事件账（v0 调度→触发→通知的客户端可见面）。不包含：改期原子替换（v0 用取消重建）、重复任务（v1）、推送通道管理（Deferred）。阶段标签：v0。
>
> 蓝图引用：B06（R 状态机 saved→pending_schedule→scheduled→fired|missed→cancel 路；超 15min 标 missed 不补发；取消后触发数=0 一级指标；06 喝水 task.kind=notify_only 不走 LLM 先验调度）。

> 直接创建由委托的 `create_reminder` 工具进入 tasks 公共事务，legacy confirm 复用同一用例；不增加另一条创建路由或伪造批准。列表/详情/通知识别真实 `source_invocation_id`，旧冻结不回填。严格经过时长任务保存可信请求锚、秒数、来源和冻结展示版本，见 [design/20 §4.3、§5–§6](../../design/20-goal-scoped-delegation.md)。created、排期、取消中和撤销回执分别呈现。
>
> 新接纳的合格委托可通过 `list_tasks` 游标完整读取本人任务、用 `get_task` 读取完整事项，再用 `cancel_reminder` 调用现有取消事务。取消时同时提供目标 ID、完整事项、冻结本地时间和时区；服务端在写入前核对这些字段属于同一任务，不匹配时不取消，由助理重新读取并修正。该核对防止目标资料与 ID 串用，并不独立证明模型对用户意图的理解正确。明确取消全部未来提醒时逐页定位并逐项报告，不承诺全局原子或覆盖读取后新增的任务。`cancel_pending` 表示取消请求已接受，只有真实撤销回执支持 `cancelled`；旧冻结工具目录和交互不扩权。补充真实澄清时可选择关联上一个问题，已接受效果作为历史收据保留，不重做。

## 1. 路由

| 方法 | 路径                         | 鉴权 | CSRF | 幂等键 | 说明         |
| ---- | ---------------------------- | ---- | ---- | ------ | ------------ |
| GET  | `/tasks`                     | 是   | 否   | —      | 任务列表     |
| GET  | `/tasks/{id}`                | 是   | 否   | —      | 任务详情     |
| POST | `/tasks/{id}/actions/cancel` | 是   | 是   | 是     | 取消（幂等） |
| GET  | `/tasks/{id}/events`         | 是   | 否   | —      | 只追加事件账 |

以上业务路径统一带 `/api/v1` 前缀；通知复用 `GET /api/v1/tasks/{id}`，不增加独立通知路由。

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
  "source_invocation_id": null,
  "recreated_from": null,
  "schedule_receipt": "sched_…",
  "created_at": "…",
  "notifications": []
}
```

- `kind=notify_only`：v0 喝水类提醒，不走 LLM 先验调度 [Required]。
- 来源字段 `source_approval_id` 和 `source_invocation_id` 均为可空 UUID。新任务恰有一个真实来源：legacy 按钮批准或直接创建工具 invocation；直接创建不制造 approval。历史来源缺失行只读保留，不回填。列表与详情均返回这两个字段。
- 严格经过时长任务的 `time_basis` 含 `anchor_utc`、`duration_seconds`、`source_message_id` 和 `revision`，`display_version` 为 `elapsed/1`。列表和详情返回冻结本地时间、时区、UTC、偏移及规则版本；严格 UTC 可无 tzdb 版本。历史 wall 任务的依据和展示版本为 `null`，不回写。
- `schedule_receipt`：有登记回执才为 `scheduled`；无回执停 `pending_schedule`，前端展示“待排期”，不谎称已排 [Required]。
- 口径天花板：详情只报告系统记录到的状态（已保存/已排期/已触发/已错过），不声称用户已读/必达 [Required]。
- 不存在/他人资源：`404` / `403`。

### 2.1 任务详情通知数组 [Required]

`GET /api/v1/tasks/{id}` 成功响应的 `data.notifications` 必有且为只读数组；任务列表不增加该字段。任务尚无持久通知记录时为 `[]`，不是 `null`，也不根据 `fired` 事件补造记录。每项仅包含：

| 字段      | 类型                          | 来源与语义                          |
| --------- | ----------------------------- | ----------------------------------- |
| `id`      | UUID 字符串                   | `notifications.id`                  |
| `title`   | 字符串                        | 已存标题原文                        |
| `body`    | 字符串                        | 已存正文原文，不重算其中的时间      |
| `status`  | `pending` / `sent` / `failed` | `notifications.status` 的实际约束域 |
| `sent_at` | ISO 8601 字符串或 `null`      | `notifications.sent_at`；空值不补造 |

字段与空值基于既有迁移 `0007_commitments_notifications.sql` 及 schema 的 `notifications` 节；不新增表字段。详情先校验 task 的 owner，再经 notifications 公开 service 查询相同 owner/task 的记录；通知表查询只在通知模块内部，不让 tasks 或 Web 直读。

沿用详情错误：未认证 `401`，不存在/非 UUID `404`，跨 owner `403`；错误不转换成成功空态，查询失败不隐藏为 `[]`。GET 不发送通知、不重试、不标已读，不写 task、通知、事件或 outbox。Web 直接展示存储值与“暂无站内通知记录”空态，不改写正文的冻结时间；`sent` 与 `sent_at` 不表示设备送达、响铃或用户已读（D1/D2/D8/D10、A1）。

`notifications` 仍为内部表，无独立公开路由，仅可经任务详情投影。写入继续使用既有 `send:<taskId>:<fireAtIso>` 幂等键与 `INSERT … ON CONFLICT DO NOTHING`，本读取增量不改变发送、取消或崩溃恢复合同（design/03 §3.1–§3.2）。

## 3. POST /tasks/{id}/actions/cancel [Required]

请求体：`{"reason": "…"(可选), "idempotency_key": "…"}`。

- 状态流转：`saved|pending_schedule|scheduled → cancel_pending → cancelled`（仅本地撤销回执到才终态 `cancelled`；无回执停 `cancel_pending`，前端展示“取消确认中”）。`fired|missed` 为终态：取消返回 `409 STATE_CONFLICT` + `details.current_state`（“已触发/已错过，不可取消，请新建”）。不存在/非 uuid → `404`；跨 owner → `403`；CSRF 缺失 → `403 CSRF_MISMATCH`。
- 幂等：同一 `idempotency_key` 重复取消返回 `200` + 当前状态，`data.duplicate=true`；`cancelled` 行重复取消恒回 `duplicate=true`；`cancel_pending` 行新 key 补一条 cancel 命令行（旧行由 supersede 清理）。取消提交（`cancel_pending` 落定）后排队重试全作废（`superseded`），取消后触发数=0 为一级指标（破 0 记 `security_events.cancel_breach`，人复核）。
- 无回执不谎称：撤销回执未到前状态停 `cancel_pending`，前端展示“取消确认中”，不展示“已取消”；触发门禁照拦（“本机拦截本次触发，系统排期是否撤掉仍无法确认”）。

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
