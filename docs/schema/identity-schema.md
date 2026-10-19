# Identity Schema 设计

> 状态：v0 可开工（方案已定：Better Auth 自建 credential；v0 单租户）。范围：`users`、`sessions` 两表。不包含：密码哈希算法选型、计费/额度、推送 token。阶段标签：v0 MVP。

节内标记：Observed = 沿用业界既定做法；Required = v0 必须；Proposed = 推荐；Deferred = 延后。

## 设计依据

- B03 会话/用户归 TS 侧，仓颉与 CangjieMagic 永不直连业务库 [B03]。
- a13n 落点：`organization/workspace` 租户边界简化为单 `owner_id`（v0 单用户即单租户，组织模型 Deferred）[AF]。
- QuantAgent 细度样例：字段表三列（类型/约束/说明）+ 约束与索引 + 写入规则。

## 表关系

```text
users 1 ── 0..n sessions
users 1 ── 0..n auth_accounts
users 1 ── 0..n <全业务表 via owner_id 逻辑引用>
```

- `sessions`、`auth_accounts` 归属 `users`，物理 FK `→ users.id`（`on delete restrict`）。
- 其余业务表不建到 `users` 的物理 FK（模块边界：跨模块只传 id，逻辑引用 + 查询必带 `owner_id`）。

## `users`

### 用途

[Required] 注册主体与多租户根。v0 唯一事实源的用户行；自建 credential 方案归一到此行。

### 字段

| 字段                 | 类型          | 约束                         | 说明                                                                                                    |
| -------------------- | ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                 | `uuid`        | primary key                  | 用户 ID，全业务表 `owner_id` 逻辑引用目标                                                               |
| `display_name`       | `text`        | not null, default `''`       | 展示名，可改                                                                                            |
| `primary_email_hash` | `text`        | nullable                     | 主邮箱哈希（只存哈希，不存明文邮箱）                                                                    |
| `auth_email`         | `text`        | not null, unique             | 不透明登录句柄（HMAC 派生，形如 `<hex>@local.invalid`，不是明文邮箱；轮换 `BETTER_AUTH_SECRET` 会失效） |
| `email_verified`     | `boolean`     | not null, default `false`    | 邮箱已验证（v0 自建 seed 为 false）                                                                     |
| `auth_subject`       | `text`        | nullable                     | 内部身份标识（自建 credential）；格式随 Better Auth 落地补齐                                            |
| `auth_provider`      | `text`        | nullable                     | 约束为 `local`（v0 仅自建；OIDC 不在 v0 范围）                                                          |
| `timezone_id`        | `text`        | nullable                     | 已确认时区（IANA 文本）；“明天”解析锚 + time-core 输入，未确认则 NULL                                   |
| `status`             | `text`        | not null, default `'active'` | 按 `active/disabled/deleted_requested` 约束                                                             |
| `created_at`         | `timestamptz` | not null, default `now()`    | 创建时间                                                                                                |
| `updated_at`         | `timestamptz` | not null, default `now()`    | 更新时间                                                                                                |
| `metadata`           | `jsonb`       | not null, default `'{}'`     | 扩展信息，不存敏感值                                                                                    |

### 约束与索引

- `unique(auth_provider, auth_subject)`，同一身份主体只对应一行（两者皆 NULL 时不生效，由应用层保证至少一种鉴权绑定）。
- `index(status)`，支持管理端按状态筛（v0 可选）。
- [Proposed] `index(created_at desc)`，支持运营排查。

### 写入规则

- [Required] 禁止物理删除 `users` 行；注销走 `status` 标记 + 清理流程（Deferred）。
- [Required] 不存密码明文、token 明文、邮箱明文（哈希可）；确实必须入库的敏感值先加密，优先 `secret://` 引用。
- [Required] `id` 由服务端生成（`gen_random_uuid()`），不信任客户端传入。
- `timezone_id` 写入必须校验 IANA 合法性；非法报 `UNKNOWN_TIMEZONE`（错误码见 API 篇），不写脏值。

## `sessions`

### 用途

[Required] 登录会话。Better Auth 自建 credential 下最小字段集。

### 字段

| 字段           | 类型          | 约束                                                | 说明                                                                                |
| -------------- | ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `id`           | `uuid`        | primary key                                         | 会话 ID                                                                             |
| `user_id`      | `uuid`        | not null, references `users(id)` on delete restrict | 所属用户                                                                            |
| `token_hash`   | `text`        | not null, unique                                    | 会话 token 的 HMAC-SHA256（`session:<token>` 加盐）；明文只在 cookie/内存，永不入库 |
| `created_at`   | `timestamptz` | not null, default `now()`                           | 创建时间                                                                            |
| `expires_at`   | `timestamptz` | not null                                            | 过期时间（v0 固定 7 天），过期会话不可用                                            |
| `revoked_at`   | `timestamptz` | nullable                                            | 撤销时间，非 NULL 即已撤销（软撤销，永不硬删）                                      |
| `last_seen_at` | `timestamptz` | nullable                                            | 最后活跃时间（[Proposed] 用于过期顺路清与诊断）                                     |
| `client_info`  | `jsonb`       | not null, default `'{}'`                            | 客户端信息（UA/设备名摘要）；不存 token原文                                         |

### 约束与索引

- `unique(token_hash)`，一 token 一行。
- `sessions_expiry_check (expires_at > created_at)`，过期 fixture 需连 `created_at` 一起 backdate。
- `index(user_id, created_at desc)`，支持按用户查会话历史。
- `index(expires_at)`，支持过期顺路清。
- FK `user_id → users.id on delete restrict`，保留历史。

### 写入规则

- [Required] 会话 token 明文永不入库，只存 `token_hash`（HMAC-SHA256）；cookie 值为明文，服务端哈希后比对。
- [Required] 过期与撤销判定在服务端做；客户端自报时间只用于诊断。
- [Proposed] 过期顺路清（读取/登录时），不另养后台进程（与 B06 过期顺路清同例）。

## `auth_accounts`

### 用途

[Required] Better Auth credential 支撑表（密码哈希存放处）。v0 无注册/登录 HTTP 端点，会话由服务端 `seed-session` CLI 直种；`password_hash` 恒为 NULL，登录密码哈希算法随登录端点落地定，不先猜。

### 字段

| 字段            | 类型          | 约束                                                | 说明                                                 |
| --------------- | ------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `id`            | `uuid`        | primary key                                         | 行 ID                                                |
| `user_id`       | `uuid`        | not null, references `users(id)` on delete restrict | 所属用户                                             |
| `provider_id`   | `text`        | not null, default `'credential'`                    | 按 `credential` 约束（v0 仅自建；OIDC 不在 v0 范围） |
| `account_id`    | `text`        | not null                                            | 账号标识（v0 seed 形如 `seed:<user_id>`）            |
| `password_hash` | `text`        | nullable                                            | 密码哈希；v0 恒 NULL（无登录端点）                   |
| `created_at`    | `timestamptz` | not null, default `now()`                           | 创建时间                                             |
| `updated_at`    | `timestamptz` | not null, default `now()`                           | 更新时间                                             |

### 约束与索引

- `unique(provider_id, account_id)`，同一 provider 下账号唯一。
- `index(user_id)`，支持按用户查绑定。
- FK `user_id → users.id on delete restrict`，保留历史。

### 写入规则

- [Required] 不存密码明文；哈希算法随登录端点落地定。
- [Required] 用户行永不物理删除（`users_no_delete` trigger），本表行随用户状态标记处理。

## Deferred 清单（不猜字段）

- token 明文存储、OAuth 账号表（v0 不做 OIDC）仍 Deferred；`token_hash` HMAC 与 `auth_accounts` credential 表已随本 PR 落定。
- 目标市场/计费/推送供应商字段一律不进 v0。
- 组织/workspace 模型、多用户共享，P1 后定。
