# Brief 路由：每日简报

> 状态：草稿，可评审。范围：`GET /brief`（v0 简报→卡片入口）。不包含：卡片创建/修改（走 conversations+approvals）、历史归档查询（v1）。阶段标签：v0。
>
> 蓝图引用：B06（v0 切片首环：简报→卡片→对话；06 喝水提醒降级为调度子用例 `task.kind=notify_only`）。

> Proposed 演进：新 UTC/跨冻结时区提醒同批改为明确浏览时区的服务端 UTC 日区间查询，卡片仍读各自冻结字段，见 [design/20 §4.3](../../design/20-goal-scoped-delegation.md#43-存储api-和今日投影同交付)。本文参数语义为现行/legacy，不把新分支漏项留到收口；生成保存的简报是 workspace 文件，不建 briefs/cards 表，本规范不改当前 API。

## 1. 路由

| 方法 | 路径     | 鉴权 | CSRF | 说明                |
| ---- | -------- | ---- | ---- | ------------------- |
| GET  | `/brief` | 是   | 否   | 每日简报 + 卡片列表 |

## 2. GET /brief [Required]

查询参数：

| 参数       | 必填 | 说明                                                                                                                                                 |
| ---------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`     | 否   | `YYYY-MM-DD`（按已确认时区解释）。缺省为服务端“今日”（首次接收时刻 + 已确认时区冻结的“今天”，见 conversations）。非法格式返回 `400 VALIDATION_ERROR` |
| `timezone` | 否   | 仅回显校验用；与已确认时区不一致时服务端不换算，只在 `meta.timezone_note` 提示                                                                       |

成功响应 `200`：

```json
{
  "code": 0,
  "data": {
    "date": "2026-10-16",
    "timezone_id": "Asia/Shanghai",
    "summary": { "pending_count": 1, "fired_count": 0 },
    "cards": [
      {
        "card_id": "card_01J…",
        "kind": "task",
        "schema_version": 1,
        "title": "喝水",
        "status": "scheduled",
        "fire_at_local": "2026-10-17 09:20",
        "ref": { "task_id": "tsk_01J…" }
      },
      {
        "card_id": "card_01K…",
        "kind": "approval",
        "schema_version": 1,
        "title": "请确认：明天 9:20 喝水提醒",
        "status": "pending",
        "ref": { "approval_id": "apr_01J…" }
      }
    ],
    "meta": { "brief_state": "day-in-progress", "timezone_note": null }
  },
  "msg": "ok",
  "error": null,
  "request_id": "req_…"
}
```

字段语义：

- `cards[].kind`：v0 仅 `task | approval` 两种 [Required]（S0 #14 冻结：只读投影，不建 `cards` 表；`content-schema` 的 `task_confirm/task_progress/info` 为 P1 后卡片持久化词汇，v0 不用）。其他 kind 由服务端 zod 拒收，见 §3。
- `cards[].schema_version`：卡片 schema 版本，v0 为 `1`；前端未知版本做纯文本降级展示（见 §3）[Required]。
- `cards[].fire_at_local`：冻结的 `tasks.wall_time` 原文（`YYYY-MM-DD HH:mm`），不换算、不补秒、不改写；展示层原样输出 [Required]。
- `date` 缺省时按已确认时区的本地日期取“今天”（服务端时钟）；已确认时区为空返回 `400 VALIDATION_ERROR`，不猜时区。
- 只聚合 `timezone_id` 等于已确认时区的 tasks/approvals，按冻结的 `wall_time` 日期前缀过滤；不做跨时区换算，避免读路径重算本地时间。
- `task` 卡片 `ref.task_id` / `approval` 卡片 `ref.approval_id`：跳转详情的唯一依据，不拼 URL 猜测 [Required]。
- `meta.brief_state`：`empty`（今日无卡片）/ `day-in-progress`（有未终态卡片）/ `stale`（快照过期，前端提示下拉重试）[Required]（S0 #14 冻结：删 `generating` 态；v0 简报为确定性组装，无 LLM 生成中状态）。
- 空简报：`cards: []` + `brief_state=empty`，仍 `200` [Required]。
- 过期：服务端数据快照过期时 `brief_state=stale` 并附 `meta.stale_reason`，前端展示“简报可能过期”并提供刷新 [Required]。

## 3. 非法卡片处理 [Required]

- 服务端下发前对每张卡片做 zod 校验；校验失败的卡片不下发结构化 payload，改为同位置的纯文本降级卡（`kind=text`、`schema_version=1`、`title` 为安全摘要），并记一条服务端事件（不落业务库事件账，记运行日志，`request_id` 关联）。
- 前端收到未知 `kind` 或更高 `schema_version` 时：不 crash、不猜字段，只渲染 `title` 纯文本 + “版本过新请升级”提示。
- 该降级不产生错误码、不污染 `code`；可观测靠日志，不靠 API 错误。

## 4. 错误

- `401 UNAUTHENTICATED` / `403 FORBIDDEN`：同通用约定。
- `400 VALIDATION_ERROR`：`date` 非法、已确认时区为空或不是合法 IANA 时区。
- `503 NOT_READY`：/readyz 非就绪时的连带（S0 #14 冻结：旧名 `SERVICE_NOT_READY` 作废）。
