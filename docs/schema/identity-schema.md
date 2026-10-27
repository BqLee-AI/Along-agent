# Identity Schema 设计

> 状态：Required 合同；v0 字段与 R1 #68 变更分列，新增迁移须经实现验收。范围：`users`、`sessions`、`auth_accounts` 与单租户 `installation_admin`。不包含：OAuth、多租户/RBAC、计费/额度、推送 token。阶段标签：v0/R1；账户设计见 [design/16](../design/16-r1-account-access.md)。

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

[Required] Better Auth credential 支撑表。原 v0 seed 的密码为空、account_id 为 seed 前缀；R1 只有经明确授权的原身份转正才修正 credential，不在迁移中批量改写。库标准 password 映射 password_hash，哈希/验证复用锁定 Better Auth，不另选密码系统。

### 字段

| 字段            | 类型          | 约束                                                | 说明                                                           |
| --------------- | ------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `id`            | `uuid`        | primary key                                         | 行 ID                                                          |
| `user_id`       | `uuid`        | not null, references `users(id)` on delete restrict | 所属用户                                                       |
| `provider_id`   | `text`        | not null, default `'credential'`                    | 按 `credential` 约束（v0 仅自建；OIDC 不在 v0 范围）           |
| `account_id`    | `text`        | not null                                            | 正式 credential 等于原 users.id 文本；旧 seed 仅显式转正时修正 |
| `password_hash` | `text`        | nullable                                            | 库密码哈希；未转正历史账户可为空，不静默补密码                 |
| `created_at`    | `timestamptz` | not null, default `now()`                           | 创建时间                                                       |
| `updated_at`    | `timestamptz` | not null, default `now()`                           | 更新时间                                                       |

### 约束与索引

- `unique(provider_id, account_id)`，同一 provider 下账号唯一。
- `index(user_id)`，支持按用户查绑定。
- FK `user_id → users.id on delete restrict`，保留历史。

### 写入规则

- [Required] 不存密码明文；哈希和验证使用锁定 Better Auth，不在此自研或替换算法。
- [Required] 用户行永不物理删除（`users_no_delete` trigger），本表行随用户状态标记处理。

## Deferred 清单（不猜字段）

- token 明文存储禁止；OAuth、邮件验证/找回与多用户组织模型不在 R1 范围。`token_hash` HMAC 和 credential 合同保持。
- 目标市场/计费/推送供应商字段一律不进 v0。
- 组织/workspace 模型、多用户共享，P1 后定。

## R1 账户与安装绑定（#68）

以下为 R1 新增合同，对应迁移 `0017_identity_account_access.sql`；不修改已合并迁移。设计依据见 [design/16 §2–§7](../design/16-r1-account-access.md)。

### installation_admin

| 字段         | 类型          | 约束                                              | 说明                             |
| ------------ | ------------- | ------------------------------------------------- | -------------------------------- |
| `singleton`  | `boolean`     | primary key；CHECK 为 true                        | 固定单行键，不引入多租户安装分区 |
| `user_id`    | `uuid`        | not null、unique、FK users(id) on delete restrict | 唯一绑定管理员的原用户 ID        |
| `created_at` | `timestamptz` | not null，default now()                           | 绑定创建时刻                     |

空安装无行；绑定后不提供公开重绑或删除入口。身份公共用例统一持 PG 事务级互斥，在同一 PoolClient 上完成空安装复查、user/credential/session/绑定并提交；唯一约束兜底，并发最多一套完整成功，失败无孤儿。COMMIT 未确认不发 Cookie。

已有用户、业务历史 owner 或登记时不得匿名初始化。其他模块的 owner 事实由其公共只读投影提供；登记无效/不可读或孤立 owner 不当作空安装。原 user.id、history/tasks/approvals/workspace owner 不由身份迁移改写。

### 标准字段与既有会话

- account 的库标准 `password/createdAt/updatedAt` 分别映射既有 `password_hash/created_at/updated_at`，UUID 由服务端显式生成并与原列相容。旧非空 credential 不被覆盖；disabled 不自动激活。
- session 的 `updatedAt` 复用既有 last_seen_at，不新增同义时间列；新会话提供库所需标准时间，不通过 GET 延长 expires_at。库的 ipAddress/userAgent 分别映射新增 nullable text `ip_address/user_agent`，不将两个标量混塞为同一 JSON 字段；确切库入参须经隔离 E1 核对。
- 固定七天会话、禁滑动更新及 Cookie cache；只软撤销当前会话，不为退出改写 created_at/expires_at。保留原 token HMAC、原 secret 与既有会话身份，不批量转正或轮换认证材料。
- adapter 只有在当前调用掌握 raw token 时才向库返回它；PG 永不存 raw token，不能把 token_hash 再当原 token 签 Cookie。按 ID 读取形状须先实测，不用全局缓存或逆解。
- 发布配套 `scripts/local/baselines/0017-checks.json` 与 identity 迁移扫描规则，核验绑定表、列/约束及账本；沿用原 JSON 结构核验约定，旧 0016 核验继续有效。经 #67 显式升级停旧写者后迁移，失败保持停写，接受提交事实后前滚。

### 数据库与文件边界

管理员 PG 绑定不等于工作区登记完成。Windows 私有登记、registryFile 配置与 API reload 由正式本机维护入口分别发布及核验；API 不直接写宿主配置。收尾失败保留已提交账户，显式补做，不另建用户或改其他 owner；不把文件/重载伪装成同一 PG 事务。
