# Approvals 路由：确认门

> 状态：草稿，可评审。范围：确认列表/详情/confirm/reject（确认门一等公民，P1 差异化落点之一）。不包含：改期原子替换（v0 用取消重建）、批量确认（v1）。阶段标签：v0。
>
> 蓝图引用：B06（确认规则：整句“确认”或点按钮；`presentation_hash` 三件套；24h 有效；重复确认回原 task；状态 pending→consumed|rejected|expired|superseded）。

## 1. 路由

| 方法 | 路径                              | 鉴权 | CSRF | 幂等键 | 说明                        |
| ---- | --------------------------------- | ---- | ---- | ------ | --------------------------- |
| GET  | `/approvals`                      | 是   | 否   | —      | 确认列表（默认待确认优先）  |
| GET  | `/approvals/{id}`                 | 是   | 否   | —      | 确认详情（冻结快照 + 回显） |
| POST | `/approvals/{id}/actions/confirm` | 是   | 是   | 是     | 确认并建 Task（同事务）     |
| POST | `/approvals/{id}/actions/reject`  | 是   | 是   | 是     | 拒绝（终态 rejected）       |

## 2. GET /approvals [Required]

查询参数：`status=pending|consumed|rejected|expired|superseded|all`（默认 `pending`）、`cursor/limit`（默认 20，上限 50）。

`200 data`：

```json
{
  "items": [
    {
      "approval_id": "apr_01J…",
      "title": "明天 9:20 喝水提醒",
      "status": "pending",
      "expires_at": "2026-10-17T09:19:00Z",
      "created_at": "…"
    }
  ],
  "next_cursor": null
}
```

- 只返回本人 `owner_id` 数据；`expired` 清内容留号 30 天的墓碑仍可列出（`title` 置空提示“已过期”）。

## 3. GET /approvals/{id} [Required]

`200 data`：冻结快照 + 回显原文 + 校验材料：

```json
{
  "approval_id": "apr_01J…",
  "kind": "create_task",
  "status": "pending",
  "echo_text": "请确认：你说“明天 9:20”，我将它归一为 2026-10-17 09:20（Asia/Shanghai），设为单次提醒；确认前不会创建正式提醒，也不会排期。",
  "original_text": "明天 9:20 喝水",
  "fire_at_local": "2026-10-17 09:20",
  "expires_in_seconds": 82800,
  "snapshot": {
    "fire_at_utc": "2026-10-17T01:20:00Z",
    "timezone_id": "Asia/Shanghai",
    "fold": 0,
    "offset_seconds": 28800
  },
  "presentation_hash": "ph_…",
  "presentation_version": 1,
  "expires_at": "…",
  "recreated_from": null
}
```

- 展示层只读呈现冻结字段，不换算、不推断、不改写 [Required]。
- 不存在/他人资源：`404` / `403`。

## 4. POST confirm / reject [Required]

`POST /approvals/{id}/actions/confirm` 请求体（S0 #14 冻结：`approval_id` 取自路径，不在 body 重复）：

```json
{
  "presentation_hash": "ph_…",
  "seen_content": "当时看到的完整回显原文",
  "idempotency_key": "550e8400-…"
}
```

- 三件套校验：`approval_id` + 服务端冻结快照 + `presentation_hash`（规范编码：排版空格不计、原话空格计、时间先归一再编码）。对不上返回 `409 PRESENTATION_MISMATCH`，停在待核对，不建 Task。
- 成功 `200`：确认消费 + 建 Task 同一事务，返回新建 task：
  `data={approval_id, status:"consumed", task_id:"tsk_01J…"}`。
- 重复确认：同一 approval 或同幂等键再次 confirm，返回 `200` + 原 `task_id`，`data.duplicate=true`，不新建（“这是重复确认，没有新建第二条”）。
- `POST /approvals/{id}/actions/reject` 请求体：`{"reason": "…"(可选), "idempotency_key": "…"}`；成功 `200`，`status=rejected` 终态。
- 24h 过期或目标已过：`410 APPROVAL_EXPIRED`；被新版本替代：`409 APPROVAL_SUPERSEDED`（`details.successor_approval_id` 指向新确认）；已消费后 reject：`409` + 原 task 引用（用“取消”而非“拒绝”关闭 task，见 tasks 文档）。

失败示例（所见非所得）：

```json
{
  "code": 400001,
  "data": null,
  "msg": "所见与存档不一致",
  "error": {
    "code": "PRESENTATION_MISMATCH",
    "message": "页面所见与存档快照不一致，已停在待核对，未创建提醒。",
    "request_id": "req_…"
  },
  "request_id": "req_…"
}
```

## 5. 状态机（重申，与 design/03 一致）

`pending → consumed | rejected | expired | superseded`，单向不可逆；`task_events` 只追加见证，DB 禁 UPDATE/DELETE [Required]。
