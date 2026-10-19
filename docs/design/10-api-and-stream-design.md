# 10. API 与流设计（REST 真源）

## 文档状态

- **状态**：草案 v0.1（本篇为 REST 真源；`contracts/openapi` 生成物跟随本篇）
- **范围**：v0 约 12 端点路由表、envelope、资源 actions、幂等/request_id、SSE 版本化、断线恢复、WS 延后、错误码 40xxxx
- **不包含**：表字段 DDL（见 schema 组）、AgentEvent 语义（见 09）、Spike 标准（见 11）
- **阶段标签**：v0 全链路；P1 起五缝全接口化后本篇增补接口但不改 v0 语义

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. 通用约定（Required）

- Base path：`/api/v1`（探针除外：`/healthz`、`/readyz`）。
- Envelope（成功/失败统一）：`{ code, data, msg, error? }`；`error={ code, message, request_id, details? }`。
- `request_id`：全链路透传（调用方生成 UUIDv7/UUIDv4；网关缺失则生成并回写 `X-Request-Id`）。所有写操作同时接受 `Idempotency-Key`（缺失则服务端按 `request_id` 充当）。
- 认证：v0 `GET /me` 外全部需 Better Auth session（模式 Deferred，P0 定）；写操作 CSRF（SameSite cookie + `X-CSRF-Token`，对标 QuantAgent api 约定 Observed）。
- 版本化：破坏性变更走 `/api/v2`；SSE 事件带 `protocol_version`（见 §4）。

## 2. v0 路由表（Required，约 12 端点）

| # | 方法 | 路径 | 说明 | 幂等/约束 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/v1/me` | 当前 actor 快照 | 读；401 未登录 |
| 2 | GET | `/api/v1/brief` | 简报（确定性组装） | 读；`ETag` 缓存 Proposed |
| 3 | POST | `/api/v1/conversations/messages` | 发送消息，SSE 流（`text/event-stream`） | 写；`Idempotency-Key` 去重 24h |
| 4 | GET | `/api/v1/conversations/{id}` | 对话详情 + 消息补全（断线恢复用） | 读；`?after_seq=` 增量拉取 |
| 5 | GET | `/api/v1/approvals` | 确认队列（`?status=pending`） | 读 |
| 6 | GET | `/api/v1/approvals/{id}` | 确认单详情（含 `presentation_hash`、`presentation_version`、过期/被替状态） | 读 |
| 7 | POST | `/api/v1/approvals/{id}/actions/confirm` | 确认：验 owner/pending/未过期/展示一致 → 同事务消费+建 Task | 写；幂等（重复确认回同一 task，不新建）；`409 APPROVAL_*` |
| 8 | POST | `/api/v1/approvals/{id}/actions/reject` | 拒绝 → `rejected` 终态 | 写；幂等 |
| 9 | GET | `/api/v1/tasks` | 任务列表（`?state=`） | 读 |
| 10 | GET | `/api/v1/tasks/{id}` | 任务详情（含 `fire_at_utc`、`schedule_receipt`、`state_version`） | 读 |
| 11 | POST | `/api/v1/tasks/{id}/actions/cancel` | 取消：`→cancel_pending→cancelled`（有撤销回执才终态） | 写；幂等；取消后触发数=0 一级指标 |
| 12 | GET | `/api/v1/tasks/{id}/events` | 只追加事件账（`task_events` 投影） | 读；`?after_seq=` |
| — | GET | `/healthz` | 存活（不依赖 DB） | 读 |
| — | GET | `/readyz` | 就绪：DB + TZDB 规则就绪；失败返回类型化错误，不降级（见 §6） | 读 |

资源 actions 一律用 `/actions/<verb>`（Required，对标 QuantAgent `approve/reject/pause/resume/run-now` Observed）。

## 3. 请求/响应要点（Required）

- `POST /conversations/messages`：`{ conversation_id?, raw_text, confirmed_timezone_id?, idempotency_key?, client_sent_at?（仅诊断） }`；服务端以首次接收时刻+已确认时区解析“明天”并冻结（B06§3.5/§7）。
- `confirm`：`{ presentation_hash, seen_content, idempotency_key }`（`approval_id` 取自路径；S0 #14 冻结：三件套缺一即 `400 VALIDATION_ERROR`，对不上即 `409 PRESENTATION_MISMATCH`）；
- `cancel`：`cancel_pending` 提交事务落定即算已提交（S0 #14 冻结，以 design/07 §3 为准）；无撤销回执停在 `cancel_pending`，不谎称已取消。
- 对外口径（Required）：只说已记录步骤，不承诺必达；超 15min 标 `missed` 不补发；取消后触发数=0 一级指标。

## 4. SSE 设计（Required）

- `POST /conversations/messages` 响应 `text/event-stream`；每行 `data: {protocol_version, seq, type, payload, request_id}`，`type` 即 09 AgentEvent 词汇（zod 版本化，`packages/stream-protocol`）。
- `Last-Event-ID`：客户端断线重连带 `seq`，服务端经 `GET /conversations/{id}?after_seq=` 补全（REST 恢复，Required）；SSE 本身不做消息可靠投递。
- AG-UI 对照（Proposed→Required）：事件名开工前对照 `thread-stream.schema.json`（AF§7）；对照结论写入 `stream-protocol/README`（对照前本条为 Proposed）。

## 5. WS 延后（Deferred，Required 声明）

- WS + `ws-ticket` P2 起；v0–P1 任何 WS 需求一律走 SSE+REST 恢复，不立 WS 服务。

## 6. 错误码（Required，`40xxxx` 业务段 + HTTP 状态）

envelope `error.code` 统一 `40xxxx`；HTTP 状态只表达传输语义。

| error.code | HTTP | 含义 | 触发点 |
| --- | --- | --- | --- |
| `400001` / PRESENTATION_MISMATCH | 409 | 回显与快照对不上 | confirm 哈希比对失败 |
| `400002` / APPROVAL_EXPIRED | 410 | 确认已过期（24h/目标已过） | confirm 晚到 |
| `400003` / APPROVAL_SUPERSEDED | 409 | 已被新确认单替代 | confirm 旧单 |
| `400004` / NONEXISTENT_LOCAL_TIME | 422 | 本地不存在的时刻 | normalize |
| `400005` / AMBIGUOUS_LOCAL_TIME | 422 | 重复时刻未选 fold（带两候选） | normalize |
| `400006` / TZDB_UNAVAILABLE | 503 | 时区规则缺失（服务未就绪） | normalize 前检查；`/readyz` 同码 |
| `400007` / UNKNOWN_TIMEZONE | 422 | 非法/未知时区 id | normalize 入口 |
| `400008` / BUDGET_EXCEEDED | 429 | 预算超限停 | agent-runtime |
| `400009` / IDEMPOTENT_REPLAY | 200 | 幂等重放（返回原结果） | 写接口去重命中 |
| `400010` / STATE_CONFLICT | 409 | 状态机非法跃迁 | task/approval 状态机 |
| `400011` / NOT_READY | 503 | `/readyz` 类型化未就绪（不支持组合/降级） | 启动/规则缺失 |

`/readyz` 失败只返回类型化错误（`TZDB_UNAVAILABLE/NOT_READY` + `details.missing[]`），不降级为可用（Required；a13n 不支持组合落点，见 12）。

## 引用

- B06§5–§7/§9–§10；AF§7（stream）。
