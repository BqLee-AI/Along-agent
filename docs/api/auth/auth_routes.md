# Auth 路由：会话自检与 R1 账户

> 状态：Required 合同；v0 会话自检与 R1 #68 账户访问分列，新增能力须由实现验收取证。范围：Better Auth 自建 credential、单租户管理员、原身份转正、登录/退出及七天固定会话。不包含：公众注册、OAuth、邮件验证/找回与滑动续期。设计真源见 [design/16](../../design/16-r1-account-access.md)。
>
> 蓝图引用：B03；B06（v0 Web 单端）。

> 本人时区委托（#107）：identity 的窄用例已支持保存/清除本人默认时区，与工具接受结果及审计原子提交，见 [design/20 §4.1、§6.1、§8](../../design/20-goal-scoped-delegation.md)。当前仅显式新 delegation profile 可直接调用，不新增通用账户 patch、偏好 HTTP 写端点或批准按钮。新 Run 为 request-bound，退出/到期不承诺后台继续；已接受设置不回滚。后续 server-owned 目标不改变本页固定会话、撤销、CSRF 及只读重登合同。

> #112 Proposed 增量仅见本页 §5 与 [design/21](../../design/21-invited-account-access.md)。§1–§4 仍为当前 Required；§5 待评审、不生效，所列新路由/DTO 尚未实施，不表示已开放邮件或普通账户登录。

## 1. 方案状态 [Required]

- [Required] 鉴权方案为 Better Auth 自建 credential；v0 保留 GET /me。R1 新增窄接口见 §4，不挂库全部 handler，未列出的认证能力不开放。
- [Required] 以下行为不变：受保护路由无有效会话返回 401；跨用户访问返回 403；写操作需 CSRF。

## 2. 路由

| 方法 | 路径  | 鉴权                               | CSRF | 说明                              |
| ---- | ----- | ---------------------------------- | ---- | --------------------------------- |
| GET  | `/me` | 会话自检（无会话返回 401，不跳转） | 否   | 当前 actor 快照 + CSRF token 下发 |

### GET /me [Required]

用途：前端启动时自检会话、取 CSRF token 与已确认时区；也是“会话是否有效”的唯一可编程判断点。

成功响应 `200`（`data` 匹配公共 `Me` 合同）：

```json
{
  "code": 0,
  "data": {
    "user": { "id": "550e8400-e29b-41d4-a716-446655440000", "display_name": "…" },
    "csrf_token": "csrf_…",
    "confirmed_timezone": "Asia/Shanghai"
  },
  "msg": "ok",
  "error": null,
  "request_id": "req_…"
}
```

- `user.id`：多租户隔离键，后续所有资源按此过滤 [Required]。
- `csrf_token`：签名会话下发字符串，后续 POST 在 `X-CSRF-Token` 头回传。显式受控开发桥接可返回 `null`；客户端仍按完整 `Me` 合同判断身份有效，仅在 token 非 `null` 时添加该头，不把合法 `null` 当作登录失败，也不能借此绕过签名会话的 CSRF 校验 [Required]。
- `confirmed_timezone`：identity 当前保存的本人默认时区，未设置或已清除为 `null`。GET 只读取、不保存偏好；Web 普通 Agent 不把缓存值当作新的明确时区提示，而由接纳事务读取实际偏好。legacy 提醒入口仍沿既有冻结/澄清合同 [Required]。
- [Deferred] 不返回：session 过期时间、provider 信息、权限列表（v0 无 RBAC，owner 即全权）。
- 本人目标内的 `set_user_timezone` 使用 strict `{timezone_id:string|null}`：非 null 值只经应用实际已有别名表和有限规则包校验、转为规范 ID，不承诺完整 IANA；未知/不支持值报 `UNKNOWN_TIMEZONE`，保存所需规则不可用报 `TZDB_UNAVAILABLE`，均不写入。`null` 为真实清除，可在规则不可用时清除。identity 锁定并校验 active 本人行后更新，工具同事务保存 `{kind:'timezone_setting',timezone_id,previous_timezone_id,alias_version}` 接受结果与审计；owner 来自受信 Run，不由模型指定，不以单次时区提示自动保存。

失败：

```json
{
  "code": 40101,
  "data": null,
  "msg": "未登录",
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "会话无效或已过期，请重新登录。",
    "request_id": "req_…"
  },
  "request_id": "req_…"
}
```

- HTTP `401` + `error.code=UNAUTHENTICATED` [Required]。前端收到后清本地会话态、引导登录，不自动重试业务请求。
- HTTP `403` + `FORBIDDEN`：会话有效但访问他人资源（各资源路由统一行为，本路由不直接产生）[Required]。

## 3. CSRF 约定 [Required]

- 签名会话使用 Cookie session + `X-CSRF-Token`。`GET /me` 下发 token，前端内存持有并在每次 POST 附带。
- 签名会话业务 POST 缺失/错误 token 返回 `403 CSRF_MISMATCH`，不执行副作用；R1 匿名初始化/登录的明确 Origin 防护例外见 §4，不要求尚不存在的 session token。
- 显式受控开发桥接的 `csrf_token:null` 只说明该开发身份不提供 token；签名会话的写操作校验不因客户端省略头而降级。

## 4. R1 账户访问（#68）

### 4.1 通用输入、输出与来源

Base Path 为 `/api/v1`；响应沿用统一 envelope/request_id，成功与失败均 `Cache-Control: no-store`。仅库生成的 Set-Cookie 携带签名会话，不在 JSON 返回 raw token、hash、auth_email 或完整账户对象；`GET /me` 仍是 actor 自检。

所有 POST 使用 strict JSON，不接受额外 user_id/owner_id、rememberMe、callbackURL 或模型配置。登录名在服务端 trim+lowercase，规范化后长度 1–128；展示名 trim 后 1–128。密码不 trim，长度 8–128；长度以 JavaScript 字符串 UTF-16 code unit 计，密码哈希/验证复用锁定库。重复密码确认只在表单校验，不多传一份口令。

初始化、登录、转正、退出均要求 Origin 与固定 APP_ORIGIN 精确相同；缺失、null、恶意 Origin 拒绝，proxy 不替换或伪造来源。已签名转正/退出还必须先验有效 session 与 session-bound CSRF；无会话初始化/登录不要求一个尚不存在的 session CSRF token。沿用原 131072 字节收集上限、声明/分块逐字节核验与未消费上传的有限响应/关闭。

### 4.2 窄路由

| 方法 | 路径               | 会话/CSRF                      | strict body                            | 成功 data                                                                  |
| ---- | ------------------ | ------------------------------ | -------------------------------------- | -------------------------------------------------------------------------- |
| GET  | `/auth/status`     | 匿名可读；无 CSRF              | 无                                     | `{state}`，见下文                                                          |
| POST | `/auth/initialize` | 仅确证空安装；Origin           | `{login_name,password,display_name}`   | 201 `{authenticated:true,workspace_binding:"pending_local_configuration"}` |
| POST | `/auth/claim`      | 有效旧签名会话 + CSRF + Origin | `{login_name,password,confirmed:true}` | 200 `{authenticated:true,workspace_binding:"pending_local_configuration"}` |
| POST | `/auth/sign-in`    | Origin                         | `{login_name,password}`                | 200 `{authenticated:true}`                                                 |
| POST | `/auth/sign-out`   | 有效签名会话 + CSRF + Origin   | `{}`                                   | 200 `{signed_out:true}`                                                    |

`status.state` 为 `setup_required | legacy_claim_required | ready`。匿名只见该状态，不列候选用户、owner、登录名或 credential。`setup_required` 要确证无管理员、无原用户/历史 owner/登记；不能核验则 503，不猜空安装。已绑定时保持 ready，不因会话失效/管理员 disabled 重新开放初始化，也不把工作区失败伪装成账户不存在。

有效签名会话可附 `can_claim:boolean`，只反映当前用户资格，以及 `workspace_state:unconfigured|loaded|invalid|unreadable`；工作区状态不等于模型可用。依赖错误不得降成 setup_required。该 GET 无修改、开户、认领、模型调用或自动重载。

initialize 原子提交 user/credential/session/安装绑定后才发 Cookie。claim 不接受客户端目标身份，只转正当前 actor；无会话的原用户必须通过正式本机维护明确选人，不能匿名 claim。已有非空密码不被此接口覆盖，disabled 不被激活，其他 owner 不被改归属。

登录成功必须验证口令且属于绑定管理员；库 Cookie 经正式 proxy 被 resolver 与 /me 接受，七天固定到期，不开放 refresh/滑动续期。退出必须确认 PG 撤销后才发清 Cookie；仅库 success 不充分，PG 故障/提交未知不清 Cookie、不伪成功。

### 4.3 错误

| HTTP | error.code          | 语义                                                                                                                                   |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`  | 字段/类型/长度/畸形 JSON 不合法                                                                                                        |
| 401  | `UNAUTHENTICATED`   | 不存在/错误密码/无 credential/disabled/非绑定账户采用相同公开登录失败；受保护入口无有效会话                                            |
| 403  | `FORBIDDEN`         | `details.reason:ORIGIN_MISMATCH` 或既有 `CSRF_MISMATCH`；开发桥不能作为 claim 凭据                                                     |
| 409  | `STATE_CONFLICT`    | 有资格入口的 `INITIALIZATION_CLOSED`、`LOCAL_MAINTENANCE_REQUIRED`、`CREDENTIAL_CONFLICT`、`ADMIN_ALREADY_BOUND`；不向匿名泄漏目标详情 |
| 404  | `NOT_FOUND`         | 未列出的 auth 路径或方法，不转发全量库 handler                                                                                         |
| 413  | `PAYLOAD_TOO_LARGE` | 沿用原始 UTF-8 body 上限                                                                                                               |
| 503  | `NOT_READY`         | PG/认证依赖不可核验、写入失败或提交结果未知；不冒充 401/空安装/完整退出                                                                |

认证路由不新增通用业务幂等键。初始化响应丢失时读取状态：已 ready 用正式登录，不重建；claim 响应丢失时检查原账户事实或本地维护，不借重试覆盖已有密码。

### 4.4 页面和本机收尾

账户页面提供首次建号、当前旧用户转正、正式登录和退出。只有受保护请求的 HTTP 401 引导登录并保留安全站内路径；登录表单自身 401 是表单错误，403/503/流内业务失败不一律跳转。返回位置拒绝外部、协议相对、反斜线/编码绕过和账户登录回环，失败回首页。

重登后仅 GET 读取原任务、批准或 Run，不保存或自动重放消息、确认、取消、resume 等 POST。表单支持键盘、密码管理器及粘贴，密码不 trim，错误可操作。

账户成功与工作区可用分开：`workspace_binding:pending_local_configuration` 指引部署者通过正式 `local:account` 检查/完成登记，具体操作见[本机使用指南](../../guides/local-lifecycle.md)。程序从已绑定管理员获取 owner，复用 #67 私有配置与重载，不让浏览器/模型选择 owner、不要求手填 ID，不通过 API 写宿主私有文件。已有正确登记由本机核验后保留；文件、配置或重载失败不回滚已提交账户，不重新开户。完整阶段与实验边界见 design/16 §6–§8。

## 5. 受邀账户增量（#112）

本节定义 #112 的正式实现接口，替换 §4 的“仅绑定管理员登录”、无邮箱/恢复和管理员默认登记限制；其余固定会话、原 ID/credential、Origin/CSRF、确认提交后 Cookie、body 与 proxy 边界保持。[design/21 §2–§8](../../design/21-invited-account-access.md)定义状态、并发与邮件语义；schema 的 #112 章节定义 `0024` 存储。[实现验证](../../verification/invited-account-implementation-2026-11-03.md)与外部入口放行分开取证，不将实现或模拟器成功称为真实送达。

### 5.1 协议和输入

- Base Path `/api/v1`；统一 envelope/request_id。全部认证/账户响应（含失败）及链接页 `Cache-Control:no-store`，无 raw session token、HMAC、auth_email、密码或邮件凭证响应。新 POST 均 strict JSON；ID 为 UUID，不接受 `owner_id/user_id`、任意 callbackURL、rememberMe 或模型配置。
- 保留 §4.1 的用户名、展示名、密码长度/规范化；新口令与当前口令均不 trim。邮箱按 design/21 §3 的单一 ASCII mailbox 策略，最多 254 字节；用户名与邮箱登录为 strict 联合 `{login_name,password}` **或** `{email,password}`，禁止同时传入、不自动按 `@` 猜分支。邮箱登录只能查当前已验证 contact，再以原不透明 auth_email 调库验证。
- 所有 POST 精确校验实际 Origin=APP_ORIGIN；下表 `S` 表示有效**签名**会话、准入/active、session-bound `X-CSRF-Token` 和 Origin；`A` 再要求当前 installation_admin，写操作当次复验 `current_password`；`O` 为匿名 Origin，尚无会话故不要求 CSRF。开发桥不能用于新增账户用例。身份/CSRF 先于 body 收集，保留 131072 原始 UTF-8 字节和未结束上传有限响应/关闭。
- token 为 32 随机字节的无 padding base64url（43 字符），只从邮件 fragment 读入内存并 POST；语法错误 400，有效格式但不可消费一律 409 TOKEN_INVALID。GET/预览不带 token query、不消费。邀请接受要求当前无有效 Along 会话，避免错绑；不借清 Cookie 隐式切号。
- 当前密码错误统一 `401 UNAUTHENTICATED`，不泄漏 credential/邮箱事实；会话仍有效时表单显示验证失败，不把账户操作表单自身 401 递归跳转。

### 5.2 窄路由

下列是必要 API 全集，不是库 handler 通配；`identity/account/native-routes.ts` 注册窄入口并装配账户用例，`identity/account/routes.ts` 处理各入口资格、Origin 和请求，共享 DTO 是输入/输出契约。`{}` 为严格空对象。

| 方法/路径                           | 资格                 | strict body / query                           | 成功 data                                                                     |
| ----------------------------------- | -------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| POST `/auth/sign-in`（变更）        | O                    | `{login_name,password}` 或 `{email,password}` | 200 `{authenticated:true}`；原七天库 Cookie                                   |
| GET `/auth/account`                 | 签名会话             | 无                                            | 200 `AccountView`                                                             |
| POST `/auth/contact/request`        | S                    | `{email,current_password}`                    | 202 `{contact_state:"pending",delivery:DeliveryView}`；同路径显式重发产生新代 |
| POST `/auth/contact/verify`         | S，必须为发起本人    | `{token}`                                     | 200 `{contact_state:"verified"}`；不签新会话                                  |
| GET `/auth/invitations`             | 管理员签名会话       | `limit?,cursor?`                              | 200 `{items:InvitationView[],next_cursor:string                               | null}`                                                |
| POST `/auth/invitations`            | A，且本人邮箱已验证  | `{email,current_password,idempotency_key}`    | 201 `{invitation:InvitationView}`；同键重放 200                               |
| POST `/auth/invitations/:id/resend` | A                    | `{current_password,idempotency_key}`          | 200 `{invitation:InvitationView}`                                             |
| POST `/auth/invitations/:id/revoke` | A                    | `{current_password}`                          | 200 `{revoked:true}`；自己的已撤销邀请重复成功                                |
| POST `/auth/invitations/accept`     | O，无有效 Along 会话 | `{token,login_name,password,display_name}`    | 201 `{account_created:true,authenticated:false}`；无 Cookie                   |
| POST `/auth/password/forgot`        | O                    | `{email}`                                     | 202 `{accepted:true}`；不证明邮箱存在或邮件已发送                             |
| POST `/auth/password/reset`         | O                    | `{token,new_password}`                        | 200 `{password_changed:true,authenticated:false}`；无自动登录或新 Cookie      |
| POST `/auth/password/change`        | S                    | `{current_password,new_password}`             | 200 `{password_changed:true,signed_out:true}`；提交后库清当前 Cookie          |
| GET `/auth/sessions`                | 签名会话             | `limit?,cursor?`                              | 200 `{items:SessionView[],next_cursor:string                                  | null}`                                                |
| POST `/auth/sessions/:id/revoke`    | S                    | `{}`                                          | 200 `{revoked:true,signed_out:boolean}`；当前 session 才清 Cookie             |
| POST `/auth/sessions/revoke`        | S                    | `{scope:"others"                              | "all",current_password}`                                                      | 200 `{revoked:true,signed_out:boolean}`；all 包含当前 |
| GET `/auth/users`                   | 管理员签名会话       | `limit?,cursor?`                              | 200 `{items:ManagedAccountView[],next_cursor:string                           | null}`                                                |
| POST `/auth/users/:id/disable`      | A                    | `{current_password,confirmed:true}`           | 200 `{disabled:true}`；已停用普通账户重复成功                                 |
| POST `/auth/deletion-request`       | S                    | `{current_password,confirmed:true}`           | 200 `{deletion_requested:true,signed_out:true}`；不是删除完成                 |

本人任一写入都以当前 actor 为 owner。唯一管理员禁止 disable/deletion-request；无在线启用/交接/任意代改密码/通用 users PATCH/公开注册。既有 status/initialize/claim/sign-out 保留，status 匿名仍只返回安装状态；有会话时本人 workspace 摘要不泄漏其他 owner 或全安装诊断。无 workspace 不阻断任何账户流程，初始化仍受原空安装防接管门。

GET 列表 query strict：`limit` 默认 20、1–50，cursor 为最多 2048 字节的不透明签名站内游标，绑定 actor、集合/过滤和 `(created_at,id)` 降序边界；跨 actor/集合或畸形游标 400，不泄漏记录。GET 零副作用，不续 session、不修复、不重发。管理 GET 不要求在 URL/query 传密码，但仍当次核验管理员身份，不取得业务读取特权。

### 5.3 公共 DTO

```ts
type DeliveryStatus = 'queued' | 'submitting' | 'submitted' | 'failed' | 'unknown' | 'suppressed';
type DeliveryView = {
  delivery_id: string;
  status: DeliveryStatus; // submitted 仅供应商接受；绝不称 delivered
  updated_at: string; // RFC3339 UTC
};
type InvitationView = {
  id: string;
  masked_email: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  generation: number;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  delivery: DeliveryView; // 当前代次；不返回 token 或完整地址
};
type AccountView = {
  user: { id: string; display_name: string };
  account_status: 'active'; // 不活跃身份不能取得本投影
  installation_admin: boolean; // 仅表示管理资格，不表示跨 owner 权限
  contact: {
    state: 'unbound' | 'verified';
    masked_email: string | null;
    verified_at: string | null;
  };
  pending_contact: { masked_email: string; expires_at: string; delivery: DeliveryView } | null;
  workspace: { count: number; state: 'none' | 'available' | 'unavailable' };
};
type SessionView = {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  current: boolean;
  device_summary: string | null;
};
type ManagedAccountView = {
  id: string;
  display_name: string;
  status: 'active' | 'disabled' | 'deleted_requested';
  admitted: boolean;
  installation_admin: boolean;
  masked_email: string | null;
  created_at: string;
};
```

列表仅本人 sessions（含已撤销历史，无 raw token/HMAC/完整 IP）；device_summary 为无控制字符的最多 128 字符摘要。邮箱脱敏统一只留 local-part 首字符和 `***@` 加域名，短 local-part 仍遮盖；不在列表展示原完整输入。管理 user ID 仅用于停用的窄动作，不授予业务读取或恢复权。工作区 state 是本人可用摘要，不等同模型可用，不返回 root/登记 owner 列表。`/me` 不扩展为全账户对象，仍为会话有效性自检与 CSRF 来源。

### 5.4 错误、竞争与响应丢失

沿用 §4.3 envelope，新增下列 Proposed 原因；供应商原始错误只进入脱敏内部诊断，不直接转发。

| HTTP / error.code                    | 公开语义                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 `VALIDATION_ERROR`               | DTO、token 格式、邮箱策略、query/cursor 非法；不能靠额外 owner/callback 字段选人                                                                                                                                                                                |
| 401 `UNAUTHENTICATED`                | 登录不存在/未验证邮箱/未准入/停用/错误口令一律同形；会话无效；当前密码复验失败也不披露更多                                                                                                                                                                      |
| 403 `FORBIDDEN` / 原 `CSRF_MISMATCH` | Origin、CSRF、有效普通用户调用管理员接口或验证 token 不属当前 actor；不作会话过期                                                                                                                                                                               |
| 404 `NOT_FOUND`                      | 未列路径/方法；未知或他人的 session ID；管理对象不在允许范围。不透露资源归属                                                                                                                                                                                    |
| 409 `STATE_CONFLICT`                 | `TOKEN_INVALID`（过期/消费/撤销/旧代/错用途/目标无资格统一）；`SIGN_OUT_REQUIRED`；`CONTACT_UNAVAILABLE`；`LOGIN_NAME_UNAVAILABLE`；`INVITATION_CLOSED`；`IDEMPOTENCY_MISMATCH`；`IDEMPOTENCY_EXPIRED`；`CONTACT_VERIFICATION_REQUIRED`；`SOLE_ADMIN_PROTECTED` |
| 413 `PAYLOAD_TOO_LARGE`              | 原 UTF-8 body 上限                                                                                                                                                                                                                                              |
| 429 `RATE_LIMITED`                   | 任一持久配额命中，`Retry-After` 整数秒；不返回剩余账号配额或存在性信息                                                                                                                                                                                          |
| 503 `NOT_READY`                      | PG/key/全局邮件配置不可用、写失败、提交未知；不返回 Cookie、不假报送达/退出/空安装                                                                                                                                                                              |

邀请 token 已通过用途/代次/期限验证后，用户名冲突才可给 `LOGIN_NAME_UNAVAILABLE`；其他匿名 token 无效统一 TOKEN_INVALID，不泄漏账号状态/邮箱归属。匿名恢复依赖预检、地址/IP 配额与响应形状不依赖账号存在性；不存在、未验证、disabled/deleted_requested 同 202，202 不带 delivery ID。初始限流数值、TTL、密钥和保留见 design/21 §3–§5，不由路由实现猜值。

可信来源 IP 的配额已用尽时，请求直接返回其窗口的 `429`，不再为请求中的新用户名、邮箱或 token 创建主体配额记录；未触及 IP 上限的请求仍按相应主体配额裁决。联系邮箱查找密钥版本与现有有效记录不一致时，邮箱登录、恢复及相关邮箱写入统一返回 `503`，不将查找失败伪装为邮箱不存在。

邀请创建/重发的 key 为 UUID，作用域 `(当前管理员,action,key)`；同规范化输入回原 DTO、同键异参冲突。消费接受/验证/恢复没有通用幂等重放；丢响应先读安全状态或正式登录/恢复，不重复开户、不重写口令、不自动签会话。提交未知统一 503，即使库已生成 Cookie 也不能发布；重试必须先核对实际事实。验证/换绑、邀请、重置及撤销竞争的原子边界见 design/21 §3–§7。

正式 proxy 保留 Origin、多 Cookie、no-store、SSE/abort；生产 HTTPS/Cookie 单独取证。仅受保护请求的 HTTP 401 安全重登，403/429/503/匿名 token 409 留在原页；重登后只 GET，绝不重放上表 POST 或消息/确认/取消/继续。页面 GET、邮件扫描/预览均零消费、不触发自动 POST。

所有含口令/令牌的表单显式使用 POST，即使 JavaScript 尚未 hydration 也不得把字段写进 query；未能执行客户端操作时诚实失败。匿名恢复先统一核验保留 contact 加密 key 可读性，缺 key 对存在/不存在的目标均为 503；恢复配置后再正常受理。代理未配置可信来源 IP 链时，共用实际 peer 配额，不信任入站 `X-Forwarded-For`。
