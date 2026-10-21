# Approvals 路由：确认门

> 状态：v0 路由合同。范围：列表/详情/confirm/reject及显式修改 pending create_task；合同与运行证据分开。已消费 task 改期仍用取消重建；不包含批量确认（v1）。阶段标签：v0。
>
> 蓝图引用：B06（`presentation_hash` 三件套；24h 有效；重复确认回原 task；状态 pending→consumed|rejected|expired|superseded）；S0 #14 冻结 v0 只认按钮确认。

## 1. 路由

| 方法 | 路径                              | 鉴权 | CSRF | 幂等键    | 说明                                      |
| ---- | --------------------------------- | ---- | ---- | --------- | ----------------------------------------- |
| GET  | `/approvals`                      | 是   | 否   | —         | 确认列表（默认待确认优先）                |
| GET  | `/approvals/{id}`                 | 是   | 否   | —         | 确认详情（冻结快照 + 回显）               |
| POST | `/approvals/{id}/actions/confirm` | 是   | 是   | 是        | 确认并建 Task（同事务）                   |
| POST | `/approvals/{id}/actions/reject`  | 是   | 是   | 是        | 拒绝（终态 rejected）                     |
| POST | `/approvals/{id}/actions/revise`  | 是   | 是   | body 必填 | 显式替代有效 pending create_task，零 task |

## 2. GET /approvals [Required]

查询参数：`status=pending|consumed|rejected|expired|superseded|all`（默认 `pending`）、`cursor/limit`（默认 20，上限 50）。

`200 data`：

```json
{
  "items": [
    {
      "approval_id": "550e8400-e29b-41d4-a716-446655440001",
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
  "approval_id": "550e8400-e29b-41d4-a716-446655440001",
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
  "presentation_version": "v1",
  "expires_at": "…",
  "recreated_from": null
}
```

- 展示层只读呈现冻结字段，不换算、不推断、不改写 [Required]。
- `presentation_version` 是冻结字符串。普通、第二次与取消提议使用各自既有 v1 模板；显式 first 且结果 `fold=0` 的新提议使用 v2，`echo_text` 明确“第一次出现”和冻结 `UTC±HH:MM` 偏移。客户端直接展示详情和提交所见正文，不自行重建模板或把旧 v1 正文配上 v2 hash；模板版本参与既有规范 hash，未知版本不予确认（design/06 §2、§5）。
- 不存在/他人资源：`404` / `403`。

## 4. POST confirm / reject [Required]

`POST /approvals/{id}/actions/confirm` 请求体（S0 #14 冻结：`approval_id` 取自路径，不在 body 重复）：

```json
{
  "presentation_hash": "ph_…",
  "seen_content": "当时看到的完整回显原文",
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440002"
}
```

- 三件套校验：`approval_id` + 服务端冻结快照 + `presentation_hash`（规范编码：排版空格不计、原话空格计、时间先归一再编码）。对不上返回 `409 PRESENTATION_MISMATCH`，停在待核对，不建 Task。
- 成功 `200`：确认消费 + 建 Task 同一事务，返回新建 task：
  `data={approval_id, status:"consumed", task_id:"<UUID>", duplicate:false}`。
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

## 6. POST /approvals/{id}/actions/revise [Required，#31]

完整路径为 `/api/v1/approvals/{id}/actions/revise`；行为/事务见 `docs/design/06-approvals-confirmation-gate.md` §9，持久化见 `docs/schema/commitments-schema.md` 的修改增量。只作用于**路径指定的本人、有效、pending、create_task**；不是 task 改期、确认或会话自动覆盖。

### 6.1 Body 与处理边界

`Content-Type: application/json`；与其他 action 一样使用 session、`X-CSRF-Token`，非 SSE。body 必须为对象，**只接受以下四个字段**，禁止未知字段（包括 `approval_id`、`confirmed_timezone_id`、`seen_content`、`presentation_hash`、`conversation_id`、`client_sent_at`），不接受数组/null/patch：

| 字段                 | 必选/可选 | 约束与含义                                                                                                             |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `raw_text`           | 必选      | string，长度 1..20000（沿用现有 zod string 长度语义）；完整新原话，原样冻结，不 trim；仍需可解析的日期/时段/任务内容   |
| `confirmed_timezone` | 必选      | string，长度 1..100，非 null；用户明确确认的规范时区 ID，不隐式继承 `/me`/会话/原提议                                  |
| `fold_choice`        | 可选      | `"first" \| "second" \| "none"`，省略等价 `"none"`；null/其他值非法；歧义必须明确 first/second                         |
| `idempotency_key`    | 必选      | UUID string，沿用现有 action 的 body 键规范；不从 `Idempotency-Key` header 或 request_id 补缺，也不让 header 覆盖 body |

这是 revise 的独立 body 合同，不扩大或收紧现有 confirm/reject schema。输入中的已知文字时区别名、未知别名/非法规范 ID 的处理统一委托 #30/A4 公共时间入口（`docs/design/05-time-core.md` §5、§9），不能在已有 confirmed timezone 时静默忽略未知别名。无日期/缺年/缺时段/模糊内容走 `400 VALIDATION_ERROR`；四类 typed 时间错误按 §6.3，无 approval/task 产生。fold 选择或修正内容是新请求，应换新键。

示例（明确绝对日期，生产验收另选真实未来时刻）：

```json
{
  "raw_text": "2026-11-02 09:20 喝水",
  "confirmed_timezone": "Asia/Shanghai",
  "fold_choice": "none",
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440003"
}
```

### 6.2 成功响应与幂等

首次成功及成功重放均 HTTP `200`，沿用 `okEnvelope`，没有 201/202、新错误或流事件：

```json
{
  "code": 0,
  "data": {
    "approval_id": "550e8400-e29b-41d4-a716-446655440004",
    "successor_approval_id": "550e8400-e29b-41d4-a716-446655440005",
    "duplicate": false
  },
  "msg": "ok",
  "error": null,
  "request_id": "550e8400-e29b-41d4-a716-446655440006"
}
```

`approval_id` **始终是路径中的旧目标**，`successor_approval_id` 是本次唯一新 approval；重放两者不变、`duplicate=true`。响应不包含 `status:"pending"`、task_id 或复制的详情快照，以免重放时谎称后继仍 pending。必要回显材料从已有 `GET /api/v1/approvals/{successor_approval_id}` 读取：原文、本地时间、snapshot、echo_text、string `presentation_version`、新 `presentation_hash` 及现状态；该详情的已有 `recreated_from` 指向旧目标，不另加双向关联字段。首次成功提交瞬间新项 pending，确认仍须新详情三件套。

键空间为 `(owner, revise, idempotency_key)`；同 owner 跨目标复用键为 `409 STATE_CONFLICT`，同目标异规范请求同错，不能返回其他目标的后继；不同 owner 隔离。相同请求字段顺序无关、fold省略/none等价，raw_text/时区原字节及有效fold变化不等价；规范摘要算法见 design/06 §9.3。已成功记录在状态校验前重放，因此即使旧项 superseded、新项后来 consumed/expired/再次 superseded，或当前规则不可用，仍返回原关联，不新增、重归一或延长有效期。request_id 是本次调用的，不冻结原 envelope request_id。

首次通过安全/结构/owner边界后，服务端将 DB 接收 anchor 持久预约；业务替代与结果关联同事务提交。响应丢失、进程重启或预约后跨午夜重试仍使用该 anchor，不使用原会话 anchor，也不使用重试时刻。未提交预约前断开不算服务端已接受，必须明示此边界；不存在“凭客户端声称首次时间”补写。预约/结果不自动清理，保留期与失败恢复见 design/06 §9.3–§9.5。

### 6.3 失败 envelope、优先级与副作用

沿用 `{code,data:null,msg,error:{code,message,request_id,details?},request_id}`；顶层 `code` 是下表 numeric，`error.code` 是 symbolic（不颠倒）。非预期异常仍脱敏 `500 INTERNAL_ERROR`，不显示 SQL/原文。

| 条件                                               | HTTP / numeric / error.code           | details 与效果                                                  |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| 未认证                                             | 401 / 401 / UNAUTHENTICATED           | 无写入                                                          |
| CSRF不符                                           | 403 / 403 / FORBIDDEN                 | 沿用 `details.reason="CSRF_MISMATCH"`；无写入                   |
| 非UUID路径/不存在                                  | 404 / 404 / NOT_FOUND                 | 无写入；UUID沿用路由 `isUuid` 边界                              |
| 非法body/普通内容不完整                            | 400 / 400 / VALIDATION_ERROR          | 无替代；结构拒绝不留预约                                        |
| 他人目标                                           | 403 / 403 / FORBIDDEN                 | 不暴露successor/task，不写其状态或预约                          |
| 同键异body/跨目标、cancel_task、rejected、consumed | 409 / 400010 / STATE_CONFLICT         | consumed 可沿用 `details.task_id`；不新建替代或取消任务         |
| 已 superseded（非成功重放）                        | 409 / 400003 / APPROVAL_SUPERSEDED    | 沿用 `details.successor_approval_id`，不发明 `SUPERSEDED` 别名  |
| expired / 旧expires_at或fire_at已到 / 新目标已过   | 410 / 400002 / APPROVAL_EXPIRED       | 旧pending到期持久expired；不建立后继                            |
| 不存在本地时刻                                     | 422 / 400004 / NONEXISTENT_LOCAL_TIME | 共享A4错误详情，不替代                                          |
| 重复本地时刻未选                                   | 422 / 400005 / AMBIGUOUS_LOCAL_TIME   | 共享A4结构化两候选，不从文案猜fold                              |
| 未知时区/别名                                      | 422 / 400007 / UNKNOWN_TIMEZONE       | 不回退默认时区，不替代                                          |
| 实际规则不可用/越出批准覆盖范围                    | 503 / 400006 / TZDB_UNAVAILABLE       | A4共享判定/详情，不私造fixture                                  |
| pool不可用                                         | 503 / 503 / NOT_READY                 | 复用当前HTTP helper；不将尚未统一的 numeric 400011 宣称为现实现 |

AMBIGUOUS唯一共享结构引用A4 `docs/design/05-time-core.md` §9.1：`details={wall_time,timezone_id,ruleset_id,candidates:[{fold_choice:"first",offset_seconds,fire_at_utc},{fold_choice:"second",offset_seconds,fire_at_utc}]}`；候选顺序/偏移/UTC均由服务端纯归一结果给出。其他时间错误details可省略，不另造A2 reason枚举；没有候选就不能由Web猜出选择。

处理优先级与并发详见 design/06 §9.4：owner 先于预约/终态，已完成同请求重放先于旧状态；未完成请求锁后检查 kind/state/DB实时时限，再归一，提交前再次检查。confirm/reject等待行锁期间到期同样410且持久expired。修改先提交→旧confirm/reject/不同键修改409 superseded；confirm或reject先提交→修改409 conflict；并发修改仅一后继。旧确认键不能绕过 superseded；新项材料与新详情不匹配才是既有409 PRESENTATION_MISMATCH。相同presentation可同hash/所见值，不追溯材料来源；客户端仍读新详情重新按钮确认。

所有失败均不建 task/task_events/outbox/notification；业务替代失败不改旧项为 superseded、不留新approval。允许已提交的幂等预约，以及owner校验后应到期项的expired持久化；不能把它们描述成“完全零写入”。实际修改及重放也均零task；只有新项被用户重新按钮确认才建task。客户端遇失败保留旧项/输入，遇成功按新ID取详情重回显，不自动confirm、不乐观隐藏失败。
