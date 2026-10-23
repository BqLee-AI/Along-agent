# API 总览与通用约定

> 状态：草稿，可评审。范围：v0 MVP 对外 HTTP API 全表与通用约定（Web 先行，同一份 Next.js 后续套 Electron）。不包含：五缝内部接口（AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault，见 design）、CangjieMagic 远程实现细节、计费与运营接口。阶段标签：v0。
>
> 蓝图引用：B06（v0 切片=简报→卡片→对话→确认→调度→触发→通知→活动页）；B03（TS 模块化单体 api|worker|all）；远期形态以后用 Electron 套同一份 Next.js，不定本期契约。
>
> 标记说明：节内以 [Required] / [Proposed] / [Deferred] 标注确定性。[Required] 为 v0 必须遵守；[Proposed] 为推荐写法，可评审调整；[Deferred] 为明确未定事项，不猜。

## 1. Base Path 与路由总数 [Required]

- Base Path：`/api/v1`。下文路由表省略该前缀，如 `GET /me` 即 `GET /api/v1/me`。
- v0 对外端点共 13 个业务端点 + 2 个探针（含 approvals 显式 revise 契约增量），与 design/03 路由数一致：
  - auth：`GET /me`（1）。
  - brief：`GET /brief`（1）。
  - conversations：`POST /conversations/messages`（SSE）、`GET /conversations/{id}`（2）。
  - approvals：`GET /approvals`、`GET /approvals/{id}`、`POST /approvals/{id}/actions/confirm`、`POST /approvals/{id}/actions/reject`、`POST /approvals/{id}/actions/revise`（5；revise 见 approvals §6）。
  - tasks：`GET /tasks`、`GET /tasks/{id}`、`POST /tasks/{id}/actions/cancel`、`GET /tasks/{id}/events`（4）。
- 探针：`GET /healthz`、`GET /readyz`（不计入业务端点，不走 envelope，见 §6）。
- Web 单端为 v0 唯一客户端；Electron 套壳后复用同一份路由，不新增端点 [Deferred：移动端/公开 OpenAPI 未定]。

## 2. Envelope [Required]

所有业务端点统一 envelope，成功与失败同形：

```json
{
  "code": 0,
  "data": {},
  "msg": "ok",
  "error": null,
  "request_id": "req_9f2c7a1b4d5e"
}
```

- `code`：`0` 成功；非 `0` 失败。HTTP 状态码同时表达类别（见 §5），`code` 用于业务细分。
- `data`：成功载荷；失败时为 `null`。
- `msg`：人类可读摘要，中文；不对客户端逻辑做断言依据。
- `error`：失败时对象，成功时 `null`：
  - `error.code`：机器可读错误码，如 `APPROVAL_EXPIRED`（全表见 §5）。
  - `error.message`：中文说明，可直接展示或转述。
  - `error.details`：可选结构化补充（如 `AMBIGUOUS_LOCAL_TIME` 的两候选、`PRESENTATION_MISMATCH` 的期望哈希摘要）。
  - `error.request_id`：与顶层 `request_id` 相同，便于工单定位。
- `request_id`：服务端生成，全链路透传（日志/outbox/事件账均带此 id）。客户端可传 `X-Request-Id`，服务端若收到则沿用（需符合长度/字符约束，否则重生成）。

失败示例（确认已过期）：

```json
{
  "code": 400002,
  "data": null,
  "msg": "确认已过期",
  "error": {
    "code": "APPROVAL_EXPIRED",
    "message": "该确认已过期，请重新发起。",
    "details": { "approval_id": "apr_01J…” },
    "request_id": "req_9f2c7a1b4d5e"
  },
  "request_id": "req_9f2c7a1b4d5e"
}
```

## 3. 鉴权与 CSRF [Required + Deferred]

- [Deferred] 鉴权方案二选一（自建 vs OIDC）在 P0 确定，见 auth/auth_routes.md。v0 文档只定以下行为，不猜字段：
  - 未定字段一律不写：token 形态、cookie 名、session 有效期、OIDC provider、注册/登录流程均不在 v0 API 契约内。
- [Required] 已定行为：
  - `GET /me` 之外的 12 个业务端点均为受保护路由，需有效会话；无有效会话返回 `401`（见 §5）。
  - 有会话但无权访问他人资源返回 `403`（多租户隔离，服务端按 `owner_id` 强制过滤，不依赖客户端传参）。
  - 所有 `POST` 写操作需要 CSRF 防护。默认机制：Cookie session + `X-CSRF-Token` 请求头（token 来源见 `GET /me`，方案确定前为 [Proposed]，字段名可换但“写操作必校验”不变）。
  - `GET` 与探针不要求 CSRF。
  - HTTP入口先完成既有身份/适用CSRF头门禁再收集POST body；JSON原始字节累计上限128KiB（131072字节），Content-Length仅用于早拒，chunked仍逐块累计。空/畸形JSON为400，超限413；未消费请求先送完有限响应再关闭连接，不等待上传end，不无界drain；合法完整请求保留keep-alive。详见design/10 §1.1。
  - 服务端对外口径只说“已记录步骤”，不承诺必达（触发/通知语义见 tasks 文档）。

## 4. 幂等与并发 [Required]

- 写操作幂等键的默认通用约定：客户端在 `POST /conversations/messages`、既有 confirm/reject、`POST /tasks/{id}/actions/cancel` 上附带 `Idempotency-Key: <uuidv4>`，按既有端点合同去重。**revise 例外**：只认必填 body `idempotency_key`，不以 header/request_id 补缺或覆盖；按 `(owner, revise, key)` 持久保留预约/结果，不作24h自动清理，跨目标/异body冲突见 approvals §6。不能把默认通用键空间或保留期套在 revise。
- `request_id` 去重只用于链路追踪，不替代幂等键。
- 确认消费与创建 Task/created/outbox，或取消批准与 tasks 公共取消用例同事务；重复确认回原 task/取消对象，不重复业务动作（见 approvals；design/02 §1–§2）。同步公共服务/DTO/只读投影不强制 outbox。
- 取消幂等：重复取消同一 task 返回 `200` + 当前状态（见 tasks 文档）。
- 改期 v0 无原子替换接口：先取消旧 task，再走对话/确认建新 task，`recreated_from` 关联（见 tasks 文档）。

## 5. 错误码总表 [Required]

| HTTP | error.code             | 含义                                                                     | 出现位置                 |
| ---- | ---------------------- | ------------------------------------------------------------------------ | ------------------------ |
| 409  | PRESENTATION_MISMATCH  | 所见即所得不一致：`presentation_hash` 与服务端快照不符，停在待核对       | approvals confirm        |
| 422  | NONEXISTENT_LOCAL_TIME | 本地时间不存在（如夏令时跳变缺失时刻），不存不排                         | conversations            |
| 422  | AMBIGUOUS_LOCAL_TIME   | 本地时间出现两次，需 `fold_choice` 二选一，`details.candidates` 带两候选 | conversations            |
| 422  | UNKNOWN_TIMEZONE       | 非法/未知 IANA 时区                                                      | conversations            |
| 400  | VALIDATION_ERROR       | 请求体为空、JSON语法错误或zod校验失败                                    | 全 POST                  |
| 413  | PAYLOAD_TOO_LARGE      | JSON body原始累计字节超过131072；顶层code为413，不占40xxxx业务编号       | HTTP入口                 |
| 401  | UNAUTHENTICATED        | 无会话或会话失效                                                         | 全受保护路由             |
| 403  | FORBIDDEN              | 跨用户/跨租户访问                                                        | 全受保护路由             |
| 404  | NOT_FOUND              | 资源不存在（含已清理墓碑只留号的情形按 404 + 提示）                      | GET 详情/事件            |
| 409  | APPROVAL_SUPERSEDED    | 确认已被新版本替代                                                       | approvals confirm/reject |
| 410  | APPROVAL_EXPIRED       | 确认已过期（24h 或目标已过）                                             | approvals confirm/reject |
| 429  | BUDGET_EXCEEDED        | 对话预算超限（token/轮次/时长），停并告知                                | conversations SSE        |
| 429  | RATE_LIMITED           | 限流，后续版本细化配额 [Proposed]                                        | 全局                     |
| 503  | TZDB_UNAVAILABLE       | 时区库不可用，时间归一拒绝服务                                           | conversations            |
| 503  | NOT_READY              | /readyz 类型化错误，不降级（见 §6；旧名 SERVICE_NOT_READY 作废）         | 探针                     |

- [Required] numeric `40xxxx` 映射见 `docs/design/10-api-and-stream-design.md §6`；HTTP 状态以本表为准（S0 #14 冻结）。
- 时间业务失败的顶层 `code` 为既有 numeric，`error.code` 为符号名；SSE 中放在 `thread.failed.payload.error`，外层已建立的流仍 HTTP 200、唯一失败终结。`AMBIGUOUS_LOCAL_TIME` 的两候选结构与纯归一边界见 design/05 §9.1，不能混用 numeric 与符号名。

对外展示的触发/通知一律用“已记录/未记录到”口径，不使用成功保证类文案 [Required]。

## 6. 探针 [Required]

| 方法 | 路径       | 鉴权 | CSRF | 说明                                                                                                  |
| ---- | ---------- | ---- | ---- | ----------------------------------------------------------------------------------------------------- |
| GET  | `/healthz` | 无   | 否   | 存活探针，不依赖 DB；`200 {"status":"ok"}`                                                            |
| GET  | `/readyz`  | 无   | 否   | 就绪探针；未就绪返回 `503` + 类型化错误（不支持组合/降级，缺 time-core ruleset 或 DB 不可达即非就绪） |

探针不走 §2 envelope，直接返回 `{"status":"ok"}` 或 `{"status":"not_ready","reason":"…"}`。

规则上下文、alias、标识与支持范围见 design/05 §5、§10。`readyz` 先检查同一份实际规则上下文：缺规则/alias或标识不匹配时唯一 `reason:"TZDB_UNAVAILABLE"`；规则健康但真实 DB 探测失败时 `reason:"NOT_READY"`；均健康才 200，不接受任意非空版本标签。DB 探测只要求连通，不要求新库已迁移。两者同时失败不拼组合 reason、不降级。健康规则下某个用户输入范围外可 503 拒绝，但不使全局 readiness 变坏。旧冻结读取/确认/取消/执行不套新归一门；healthz 保持存活语义。

## 7. 全路由表 [Required]

| #   | 方法 | 路径                              | 鉴权         | CSRF | 幂等键 | 说明                                         | 详见                                  |
| --- | ---- | --------------------------------- | ------------ | ---- | ------ | -------------------------------------------- | ------------------------------------- |
| 1   | GET  | `/me`                             | 会话（自检） | 否   | —      | 当前 actor 快照 + CSRF token                 | auth/auth_routes.md                   |
| 2   | GET  | `/brief`                          | 是           | 否   | —      | 每日简报 + 卡片列表（v0 仅 day-in-progress） | brief/brief_routes.md                 |
| 3   | POST | `/conversations/messages`         | 是           | 是   | 是     | 发送消息，SSE 流式回事件                     | conversations/conversations_routes.md |
| 4   | GET  | `/conversations/{id}`             | 是           | 否   | —      | 会话恢复（历史事件重放）                     | conversations/conversations_routes.md |
| 5   | GET  | `/approvals`                      | 是           | 否   | —      | 待确认/历史确认列表                          | approvals/approvals_routes.md         |
| 6   | GET  | `/approvals/{id}`                 | 是           | 否   | —      | 确认详情（冻结快照+回显）                    | approvals/approvals_routes.md         |
| 7   | POST | `/approvals/{id}/actions/confirm` | 是           | 是   | 是     | 确认，体含 `presentation_hash`               | approvals/approvals_routes.md         |
| 8   | POST | `/approvals/{id}/actions/reject`  | 是           | 是   | 是     | 拒绝                                         | approvals/approvals_routes.md         |
| 9   | GET  | `/tasks`                          | 是           | 否   | —      | 任务列表                                     | tasks/tasks_routes.md                 |
| 10  | GET  | `/tasks/{id}`                     | 是           | 否   | —      | 任务详情                                     | tasks/tasks_routes.md                 |
| 11  | POST | `/tasks/{id}/actions/cancel`      | 是           | 是   | 是     | 取消（幂等）                                 | tasks/tasks_routes.md                 |
| 12  | GET  | `/tasks/{id}/events`              | 是           | 否   | —      | 只追加事件账（按 recorded_at）               | tasks/tasks_routes.md                 |
| 13  | POST | `/approvals/{id}/actions/revise`  | 是           | 是   | 是     | 显式完整修改，返回旧/新 ID，再读新详情确认   | approvals/approvals_routes.md §6      |

## 8. 维护方式

- design 为真源、prd 跟随：路由增删、权限/CSRF/幂等语义、envelope 或错误码变化时，先改 design/03，再同步本文档与各分组文档。
- 本目录只定 HTTP 契约，不写实现代码；字段级 zod schema 以 `packages/stream-protocol`（SSE 事件）与服务端 schema 为准，文档引用其版本号。
- 不复制外部产物原文/token/DSN；不猜未定目标市场/推送通道/LLM 供应商/计费。仓颉唯一 Harness 与 TS 长期能力/业务/存储责任已定（design/09/11），不等于远程 API 已实现。
- 引用蓝图统一用 B00–B06 / AF 代号。
