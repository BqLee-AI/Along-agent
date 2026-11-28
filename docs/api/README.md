# API 总览与通用约定

> 范围：v0 MVP、R1 受管文档闭环与 #68 账户访问的 HTTP 合同全表及通用约定（Web 先行，同一份 Next.js 后续套 Electron）；新增合同不代表运行验收。不包含：五缝内部接口、CangjieMagic 远程实现细节、计费与运营接口。
>
> 蓝图引用：B06（v0 切片=简报→卡片→对话→确认→调度→触发→通知→活动页）；B03（TS 模块化单体 api|worker|all）；远期形态以后用 Electron 套同一份 Next.js，不定本期契约。
>
> 标记说明：节内以 [Required] / [Proposed] / [Deferred] 标注确定性。[Required] 为 v0 必须遵守；[Proposed] 为推荐写法，可评审调整；[Deferred] 为明确未定事项，不猜。

> 授权、真实工具及 v6/SSE v2 见 [design/20 §1、§4–§9](../design/20-goal-scoped-delegation.md)。授权与冻结生命周期独立：早期 request-bound 仍断流取消，合格新 Run 冻结 server-owned；旧读取和安全门不变。

> Proposed 用户模型配置见 [模型接入 API](model-providers.md) 和 [design/22](../design/22-model-provider-settings.md)；接纳、历史投影及 SDK 传输以对应合同与验收为准。

> R3（#144）的用户暂停、显式继续和 compact 见 [conversations API §9–§10](conversations/conversations_routes.md#9-用户安全点暂停和继续)，本人记忆管理见 §12；语义和边界见 [design/23](../design/23-r3-short-term-memory-and-compact.md)。
> Proposed 资料操作在浏览器中处理 CSV 和下载。可选纪要摘要端点见 [design/24 §3](../design/24-native-office-delivery.md#3-可选纪要摘要)，不计入既有路由总数。
> Microsoft Learn 的本人公开搜索开关、固定远程工具及断开边界见 [Microsoft Learn API](microsoft-learn.md)。连接状态不是上游健康或 Microsoft 身份证明。

## 1. Base Path 与路由总数 [Required]

- Base Path：`/api/v1`。下文路由表省略该前缀，如 `GET /me` 即 `GET /api/v1/me`。
- 合同共 38 个业务端点 + 2 个探针：既有 v0 的 13 个业务端点、正式 Harness 的 3 个 Run 入口、R1 的 4 个工作区/文档批准入口、5 个窄账户入口、3 个历史集合读取入口、1 个只读事件订阅入口、2 个用户暂停/继续入口、4 个本人记忆入口及 3 个 compact 入口：
  - auth：`GET /me`，`GET /auth/status`、`POST /auth/initialize`、`POST /auth/claim`、`POST /auth/sign-in`、`POST /auth/sign-out`（6；后5个是 #68 新增合同，详见 auth §4）。
  - brief：`GET /brief`（1）。
  - conversations：`POST /conversations/messages`（SSE）、`GET /conversations/{id}`，Run 查询、取消、有限批准恢复、用户暂停和继续，compact 操作和回执，以及会话/消息/Run 历史集合和 Run 事件订阅（14；见 conversations §3、§6、§9–§10）。
  - approvals：`GET /approvals`、`GET /approvals/{id}`、`POST /approvals/{id}/actions/confirm`、`POST /approvals/{id}/actions/reject`、`POST /approvals/{id}/actions/revise`（5；revise 见 approvals §6）。
  - tasks：`GET /tasks`、`GET /tasks/{id}`、`POST /tasks/{id}/actions/cancel`、`GET /tasks/{id}/events`（4）。
  - R1：`GET /workspaces`、文档批准详情、确认和拒绝（4；见 §8）。不提供工作区登记写接口或任意文件读写 HTTP 入口。
  - memories：本人记忆列表、详情、更正与停止召回（4；见 §12）。
- 探针：`GET /healthz`、`GET /readyz`（不计入业务端点，不走 envelope，见 §6）。
- Web 单端为 v0 唯一客户端；Electron 套壳后复用同一份路由，不新增端点 [Deferred：移动端/公开 OpenAPI 未定]。
- R2-A #83 不新增公开路由/RunView/SSE 字段；[对话 API §7](conversations/conversations_routes.md#7-r2-a-上下文容量83) 定义容量/预算错误与只读不执行边界，[design/18](../design/18-r2a-harness-context.md) 定义内部 wire/来源工具。内部回取工具不计入 HTTP 端点数量。

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

## 3. 鉴权与 CSRF [Required]

- 鉴权方案为 Better Auth 自建 credential。v0 自检、#68 原账户与 #112 受邀账户接口见 [auth 合同](auth/auth_routes.md)；公众注册、OAuth/SSO、滑动续期不在范围。
- #112 的显式准入、联系邮箱验证/恢复、本人会话管理和窄安装管理见 [design/21](../design/21-invited-account-access.md)与 auth §5，不开放库全量 handler。业务资格是 active 且已准入，管理资格不授予其他 owner 的资源读取权；真实邮件/生产 HTTPS 放行与实现证据分开。
- 状态、空安装初始化、登录、邀请接受和密码找回/重置是精确列出的匿名例外；本人验证、转正、退出及其他业务仍须有效签名会话与适用 CSRF。认证依赖失败不是 401，不猜空安装。
- [Required] 已定行为：
  - 除已列出的匿名认证入口外，业务端点需有效会话；`GET /me` 不匿名披露 actor，无有效会话返回 `401`（见 §5）。
  - 有会话但无权访问他人资源返回 `403`（服务端按 `owner_id` 强制过滤，不依赖客户端传参）。
  - 签名会话 POST 继续使用 Cookie session + `X-CSRF-Token`；#68 匿名初始化/登录使用真实 Origin 校验，不能弱化其余业务的 session-bound CSRF。所有账户 POST 均核对实际 Origin。
  - `GET` 与探针不要求 CSRF。
  - HTTP入口先完成既有身份/适用CSRF头门禁再收集POST body；JSON原始字节累计上限128KiB（131072字节），Content-Length仅用于早拒，chunked仍逐块累计。空/畸形JSON为400，超限413；未消费请求须完整发送有限错误并及时关闭，不等待上传end或主动无界drain，允许运行时已缓冲数据及最后chunk的有限越界。合法完整请求保留keep-alive。真实明文/TLS慢速及持续上传的验收要求和有限响应窗口见design/10 §1.1。
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
| 429  | BUDGET_EXCEEDED        | 仓颉累计迭代/可得 usage 超限；未知不估算费用                             | conversations SSE        |
| 429  | RATE_LIMITED           | 限流，后续版本细化配额 [Proposed]                                        | 全局                     |
| 503  | TZDB_UNAVAILABLE       | 时区库不可用，时间归一拒绝服务                                           | conversations            |
| 503  | NOT_READY              | /readyz 类型化错误，不降级（见 §6；旧名 SERVICE_NOT_READY 作废）         | 探针                     |
| 503  | HARNESS_UNAVAILABLE    | 显式 harness 缺 native/模型配置，或模型传输不可用；无业务/fixture 回退   | conversations            |
| 502  | HARNESS_PROTOCOL_ERROR | strict pipe/模型响应拒绝，脱敏失败                                       | conversations SSE        |
| 502  | HARNESS_EXITED         | native 异常退出，不能覆盖已提交终态/挂起                                 | conversations SSE        |

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

| #   | 方法 | 路径                                               | 鉴权                  | CSRF   | 幂等键 | 说明                                             | 详见                                     |
| --- | ---- | -------------------------------------------------- | --------------------- | ------ | ------ | ------------------------------------------------ | ---------------------------------------- |
| 1   | GET  | `/me`                                              | 会话（自检）          | 否     | —      | 当前 actor 快照 + CSRF token                     | auth/auth_routes.md                      |
| 2   | GET  | `/brief`                                           | 是                    | 否     | —      | 每日简报 + 卡片列表（v0 仅 day-in-progress）     | brief/brief_routes.md                    |
| 3   | POST | `/conversations/messages`                          | 是                    | 是     | 是     | 发送消息，SSE 流式回事件                         | conversations/conversations_routes.md    |
| 4   | GET  | `/conversations/{id}`                              | 是                    | 否     | —      | 会话恢复（历史事件重放）                         | conversations/conversations_routes.md    |
| 5   | GET  | `/approvals`                                       | 是                    | 否     | —      | 待确认/历史确认列表                              | approvals/approvals_routes.md            |
| 6   | GET  | `/approvals/{id}`                                  | 是                    | 否     | —      | 确认详情（冻结快照+回显）                        | approvals/approvals_routes.md            |
| 7   | POST | `/approvals/{id}/actions/confirm`                  | 是                    | 是     | 是     | 确认，体含 `presentation_hash`                   | approvals/approvals_routes.md            |
| 8   | POST | `/approvals/{id}/actions/reject`                   | 是                    | 是     | 是     | 拒绝                                             | approvals/approvals_routes.md            |
| 9   | GET  | `/tasks`                                           | 是                    | 否     | —      | 任务列表                                         | tasks/tasks_routes.md                    |
| 10  | GET  | `/tasks/{id}`                                      | 是                    | 否     | —      | 任务详情                                         | tasks/tasks_routes.md                    |
| 11  | POST | `/tasks/{id}/actions/cancel`                       | 是                    | 是     | 是     | 取消（幂等）                                     | tasks/tasks_routes.md                    |
| 12  | GET  | `/tasks/{id}/events`                               | 是                    | 否     | —      | 只追加事件账（按 recorded_at）                   | tasks/tasks_routes.md                    |
| 13  | POST | `/approvals/{id}/actions/revise`                   | 是                    | 是     | 是     | 显式完整修改，返回旧/新 ID，再读新详情确认       | approvals/approvals_routes.md §6         |
| 14  | GET  | `/conversations/{cid}/runs/{rid}`                  | 是                    | 否     | —      | owner-scoped Run/attempt/有效等待点，不执行      | conversations/conversations_routes.md §3 |
| 15  | POST | `/conversations/{cid}/runs/{rid}/actions/cancel`   | 是                    | 是     | 是     | 先持久取消，再通知/终止执行                      | conversations/conversations_routes.md §3 |
| 16  | POST | `/conversations/{cid}/runs/{rid}/actions/resume`   | 是                    | 是     | 是     | 最后有效批准等待点，同 Run 新 attempt；SSE       | conversations/conversations_routes.md §3 |
| 17  | GET  | `/workspaces`                                      | 是                    | 否     | —      | 当前 owner 的可选受管工作区摘要                  | §8                                       |
| 18  | GET  | `/document-approvals/{id}`                         | 是                    | 否     | —      | 冻结全文预览、授权状态及实际效果                 | §8                                       |
| 19  | POST | `/document-approvals/{id}/actions/confirm`         | 是                    | 是     | body   | 核对完整预览，只记录授权，不写文件               | §8                                       |
| 20  | POST | `/document-approvals/{id}/actions/reject`          | 是                    | 是     | body   | 记录拒绝，不自动创建替代批准                     | §8                                       |
| 21  | GET  | `/auth/status`                                     | 匿名有限状态          | 否     | —      | 无写入，不披露候选身份                           | auth/auth_routes.md §4                   |
| 22  | POST | `/auth/initialize`                                 | 仅确证空安装 + Origin | Origin | —      | 唯一管理员单事务开户                             | auth/auth_routes.md §4                   |
| 23  | POST | `/auth/claim`                                      | 旧签名会话 + Origin   | 是     | —      | 仅转正当前 actor                                 | auth/auth_routes.md §4                   |
| 24  | POST | `/auth/sign-in`                                    | Origin                | Origin | —      | 固定七天 credential 登录                         | auth/auth_routes.md §4                   |
| 25  | POST | `/auth/sign-out`                                   | 签名会话 + Origin     | 是     | —      | 已确认撤销后清 Cookie                            | auth/auth_routes.md §4                   |
| 26  | GET  | `/conversations`                                   | 是                    | 否     | —      | 本人会话发现，稳定有界分页                       | conversations/conversations_routes.md §6 |
| 27  | GET  | `/conversations/{cid}/messages`                    | 是                    | 否     | —      | 本人会话可见消息档案                             | conversations/conversations_routes.md §6 |
| 28  | GET  | `/conversations/{cid}/runs`                        | 是                    | 否     | —      | Run 索引、可信原话及指定 Run 点查                | conversations/conversations_routes.md §6 |
| 29  | GET  | `/conversations/{cid}/runs/{rid}/events`           | 是                    | 否     | —      | 按游标只读跟随 Run 已存事件                      | conversations/conversations_routes.md §3 |
| 30  | POST | `/conversations/{cid}/runs/{rid}/actions/pause`    | 是                    | 是     | header | 请求用户安全点暂停                               | conversations/conversations_routes.md §9 |
| 31  | POST | `/conversations/{cid}/runs/{rid}/actions/continue` | 是                    | 是     | header | 显式继续用户暂停的同一 Run；SSE                  | conversations/conversations_routes.md §9 |
| 32  | GET  | `/memories`                                        | 是                    | 否     | —      | 本人记忆列表                                     | §12                                      |
| 33  | GET  | `/memories/{id}`                                   | 是                    | 否     | —      | 本人记忆详情及来源                               | §12                                      |
| 34  | POST | `/memories/{id}/actions/correct`                   | 是                    | 是     | —      | 按修订更正记忆                                   | §12                                      |
| 35  | POST | `/memories/{id}/actions/stop-recall`               | 是                    | 是     | —      | 按修订停止召回                                   | §12                                      |
| 36  | GET  | `/office/feishu/bot`                               | 签名会话              | 否     | —      | 当前部署所配置机器人连接的可见状态               | §7.1                                     |
| 37  | POST | `/office/feishu/bot/scan`                          | 签名会话 + Origin     | 是     | —      | 开始配对，返回状态，不接受应用凭据               | §7.1                                     |
| 38  | POST | `/office/feishu/bot/cancel`                        | 签名会话 + Origin     | 是     | —      | 取消本人待完成配对（可在同一账户的另一会话操作） | §7.1                                     |
| 39  | POST | `/office/feishu/bot/disconnect`                    | 签名会话 + Origin     | 是     | —      | 解除连接并使旧绑定代次失效                       | §7.1                                     |

### 7.1 飞书机器人配对

四条路由返回 `Cache-Control: no-store`，POST 无业务请求体。`data.state` 为 `idle`、`preparing`、`waiting`、`other_session`、`connected` 或 `failed`。只有发起配对的会话能收到 `waiting` 的 `scan: { url, qr }`（飞书启动页和 PNG data URL）；`connected` 只附带机器人显示名 `name`。响应不返回应用凭据或文档允许列表。

配对不授予个人身份权限。只有匹配部署配置及已连接绑定的新 Run 能冻结明确指定的 Docx；飞书仍独立检查机器人当时的阅读权限。部署参数见[本地生命周期指南](../guides/local-lifecycle.md)。

## 8. R1 工作区与文档批准 [Required]

- 行为与范围见 [design/14](../design/14-r1-document-task-loop.md)，唯一 DTO/schema 为 `packages/contracts/src/workspaces.ts`、`document-approvals.ts` 和 `harness.ts`，不由 Web 复制类型。
- `GET /workspaces` 的 `data` 为 `{ "items": [...] }`。每项只有 `workspace_id`、`label`、`readable_paths`、`writable_paths`；不披露宿主 root、物理 identity、owner 或登记摘要。没有有效登记返回空列表，不自动开放整个目录。
- `POST /conversations/messages` 仅在 `execution: "harness"` 时接受可选 `workspace_id`。新 Run 冻结精确授权；后续请求不能换目录或扩大工具范围。省略工作区保留原业务工具，不开放文件工具。
- `GET /document-approvals/{id}` 返回完整冻结 receipt，加独立 `state` 和 `effect`。`state` 仅为 `pending/approved/rejected`；`effect.status` 为 `not_started/reserved/unknown/failed/conflict/applied/verified`。批准不是执行成功；`verified` 必须有绑定写回执及其后的新读取。
- 确认 body 严格为 `{ "presentation_hash": "<冻结哈希>", "seen_content": "<preview.body 原文>", "idempotency_key": "<uuid>" }`。不 trim、不换算、不以改后内容单独替代完整预览；请求仍受131072原始 UTF-8 字节限制，提议阶段会拒绝生成无法完整确认的预览。
- 拒绝 body 为 `{ "idempotency_key": "<uuid>", "reason": "<可选，最多2000字符>" }`。两个动作仅认 body 的幂等键，不以 header 或 request_id 补缺；返回 `{ "approval_id": "...", "status": "approved|rejected", "duplicate": false }`，持久重放返回原决定并标记重复，冲突 body/目标不覆盖既有决定。
- 确认只授权。用户显式调用原 Run 的 resume，增加 attempt 而非新 Run；真实 native 随后可调用唯一 apply，再独立读取。pending、普通 checkpoint、取消或终态 Run 不成为通用恢复点。
- 历史 Run、取消和冻结批准详情不因登记撤销而不可访问；仍按 owner 验证。登记撤销或更改后禁止新动作，批准后的 `can_resume` 也须反映实时执行资格。
- 版本冲突必须零写；后继修改要求新的真实全文读取和批准。`unknown` 保留未知事实，正常终结为 `TOOL_EFFECT_UNKNOWN`，不生成可恢复 unknown checkpoint、不凭相同 hash 补报成功或分配新调用重写。
- 写入口沿用先身份/CSRF、后收集有限 body 的顺序；所有结果使用通用 envelope。文档批准不创建 task、调度事件或 outbox。

## 9. 维护方式

- design 为真源、prd 跟随：路由增删、权限/CSRF/幂等语义、envelope 或错误码变化时，先改 design/03，再同步本文档与各分组文档。
- 本目录只定 HTTP 契约，不写实现代码；字段级 zod schema 以 `packages/stream-protocol`（SSE 事件）与服务端 schema 为准，文档引用其版本号。
- 不复制外部产物原文/token/DSN；不猜目标市场/推送通道/实际 LLM 供应商/计费。仓颉唯一 Harness 与 TS 长期能力/业务/存储已定；正式 pipe/用户 Run API 见 design/09/11，完整 R1 与通用恢复不据此自动通过。
- 引用蓝图统一用 B00–B06 / AF 代号。

## 10. R1 会话历史读取（#69）

[design/17](../design/17-r1-conversation-history.md) 与 [conversation API §6](conversations/conversations_routes.md#6-r1-可发现历史与只读恢复69) 定义三个带会话的 GET：会话集合、会话可见消息集合、会话 Run 集合；不新增业务写入端点，计入 §1、§7 的 28 端点 Required 合同。

新集合共享严格分页 DTO、owner 作用域、no-store 和准确失败边界；旧事件查询提供可选 Run 筛选但保持响应。原任务批准详情的只读结果字段见 [approval API §8](approvals/approvals_routes.md#8-r1-历史中的真实提醒结果69)。历史页仅 GET 恢复，403/依赖错误不跳登录；读完整历史不恢复工作区新动作权限。

## 11. 个人助理 Web 的消费者边界 [Required]

- Web 布局与交互重构不新增端点或 DTO。页面与功能控制器复用本索引、公开 schema 和 [design/01 §6](../design/01-tech-stack-and-repo-structure.md#6-r1-web个人助理与职责边界)；`intent`、活动页 `task_id` 只选择展示，不扩业务请求或授权。
- 今日简报、会话、消息、Run、提醒确认、任务及事件各自按原 GET 与游标读取。读取、翻页、展开、刷新和登录返回不自动补发业务 POST；活动只读取选中任务的事件，不无界扇出。
- 文档校样完整呈现冻结内容，确认直接提交原 `preview.body`。确认仅授权，原 Run 的显式 resume 才进入后续执行；授权、效果与 Run 状态分别读取。`can_resume=false` 不提供原因，Web 不据此猜测未批准或撤权；`unknown` 不开放盲目重做。
- 提醒详情仅沿实际 task/后继引用导航，不从 URL 附带参数构造原会话关联。401 才引导安全登录；403、404、依赖失败与无效响应保留各自类别，不能解释为成功空集合或模型缺配置。账户操作继续遵守 auth 合同的原身份与撤销回执边界。

## 12. 本人短期记忆

- `GET /memories` 支持 `limit` 和 `cursor`，仅列出本人记录；`GET /memories/{id}` 返回本人记忆和来源。原话通过已有本人会话消息接口查看，不凭记忆文本代替原始事实。
- `POST /memories` 提交 `{category, content, idempotencyKey}`，为本人创建手动记忆。分类为 `project`、`preference` 或 `goal`。`POST /memories/{id}/actions/correct-manual` 提交 `{category, content, expectedRevision}`，保存同一条记忆的新修订。手动来源的 `sourceKind` 为 `manual`，`conversationId` 为 `null`，`messageIds` 为空。聊天来源的 `category` 为 `null`。
- `POST /memories/{id}/actions/correct` 提交 `{content, conversationId, messageIds, expectedRevision, expiresAt?}`；来源必须是本人可访问的用户消息，修订冲突不覆盖。`POST /memories/{id}/actions/stop-recall` 提交 `{expectedRevision}`，停止后不再用于新召回，原始消息和已接受事实保留。
- `pause-memory/1` 模型召回使用字面匹配；`compact-memory/1` 可在编码器已配置时使用语义候选，并可回查获准召回项的原始来源。索引管理不提供 HTTP 入口。
- 记忆保存及召回只对各新 profile 冻结的工具开放，旧 `pause/1` 不扩权。保存提示要求模型只处理本人明确要求，但来源校验不证明模型对原话意图或语义的理解正确。记忆是低信任历史，不是授权或当前事实；空结果与降级不证明不存在。召回结果受接受账本大小约束，超出时仅返回完整条目的前缀并标记 `incomplete`。

## 13. 每日新闻简报和微信绑定

- `/channels/wechat` 支持读取和解除本人绑定，`POST /channels/wechat/pair` 启动限时配对，`POST /channels/wechat/poll` 接收配对 ID 和可选验证码。扫码确认后返回 `activation_required`，收到本人微信发来的「绑定」后返回 `bound`。`POST /channels/wechat/test` 向当前绑定试发。配对材料和结果按本人会话读取。
- `GET` 和 `PUT /news/subscription` 读取和更新主题、可选地区、启用状态及微信绑定。响应含账户时区。发送时刻由 [design/25 §3](../design/25-daily-news-briefing.md#3-订阅与每日触发) 统一定义。
- `GET /news/editions` 按日期倒序列出本人已发布的简报。`GET /news/editions/{id}` 加载原期内容及来源链接，独立返回采集与投递状态。
- 首次向空的 Agent 会话发送消息可携带 `news_edition_id`。服务端检查期次归属，再将摘要及原文链接作为引用数据保存。
