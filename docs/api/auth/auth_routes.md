# Auth 路由：会话自检与 R1 账户

> 状态：Required 合同；v0 会话自检与 R1 #68 账户访问分列，新增能力须由实现验收取证。范围：Better Auth 自建 credential、单租户管理员、原身份转正、登录/退出及七天固定会话。不包含：公众注册、OAuth、邮件验证/找回与滑动续期。设计真源见 [design/16](../../design/16-r1-account-access.md)。
>
> 蓝图引用：B03；B06（v0 Web 单端）。

> 本人时区委托（#107）：identity 的窄用例已支持保存/清除本人默认时区，与工具接受结果及审计原子提交，见 [design/20 §4.1、§6.1、§8](../../design/20-goal-scoped-delegation.md)。当前仅显式新 delegation profile 可直接调用，不新增通用账户 patch、偏好 HTTP 写端点或批准按钮。新 Run 为 request-bound，退出/到期不承诺后台继续；已接受设置不回滚。后续 server-owned 目标不改变本页固定会话、撤销、CSRF 及只读重登合同。

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
