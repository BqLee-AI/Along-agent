# Brief 路由：每日简报

> 状态：草稿，可评审。范围：`GET /brief`（v0 简报→卡片入口）。不包含：卡片创建/修改（走 conversations+approvals）、历史归档查询（v1）。阶段标签：v0。
>
> 蓝图引用：B06（v0 切片首环：简报→卡片→对话；06 喝水提醒降级为调度子用例 `task.kind=notify_only`）。

> 按本人浏览时区计算 UTC 半开日区间，卡片保留各自冻结的本地时间和时区；未设置偏好时使用并明确标示 UTC。生成保存的简报是 workspace 文件，不建 briefs/cards 表。

## 1. 路由

| 方法 | 路径     | 鉴权 | CSRF | 说明                |
| ---- | -------- | ---- | ---- | ------------------- |
| GET  | `/brief` | 是   | 否   | 每日简报 + 卡片列表 |

## 2. GET /brief [Required]

查询参数：

| 参数       | 必填 | 说明                                                                                                          |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `date`     | 否   | `YYYY-MM-DD`（按本人浏览时区解释）；缺省为该时区的今天，无偏好时使用 UTC。非法日期返回 `400 VALIDATION_ERROR` |
| `timezone` | 否   | 仅回显校验用；与浏览时区不一致时在 `meta.timezone_note` 提示，不改变查询时区                                  |

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
- `cards[].fire_at_local` 与 `timezone_id` 来自各任务冻结字段，原样展示；elapsed 卡片另附冻结 `time_basis` 与 `display_version`。
- 浏览时区使用本人已确认时区，无偏好时明确使用 UTC。按真实规则求该日期对应的 UTC 半开区间，以 `fire_at_utc` 聚合任务和批准；跨冻结时区的记录也可进入当天，展示不重新换算。
- 所需非 UTC 规则不可用时返回错误，不使用数据库自带时区规则或猜测区间。
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
- `400 VALIDATION_ERROR`：`date` 非法或浏览时区不受支持。
- `503 NOT_READY`：/readyz 非就绪时的连带（S0 #14 冻结：旧名 `SERVICE_NOT_READY` 作废）。
