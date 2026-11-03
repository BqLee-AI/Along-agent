# Identity Schema 设计

> 状态：Required 合同；v0 字段与 R1 #68 变更分列，新增迁移须经实现验收。范围：`users`、`sessions`、`auth_accounts` 与单租户 `installation_admin`。不包含：OAuth、多租户/RBAC、计费/额度、推送 token。阶段标签：v0/R1；账户设计见 [design/16](../design/16-r1-account-access.md)。

节内标记：Observed = 沿用业界既定做法；Required = v0 必须；Proposed = 推荐；Deferred = 延后。

> 本人默认时区切片（#107）：复用 `users.timezone_id` 及 identity 公共窄用例保存/清除，与工具接受结果和审计原子提交，见 [design/20 §4.1、§6.1、§8](../design/20-goal-scoped-delegation.md)。不新增偏好表、任意账户 patch 或批准记录。单次时区提示不保存；request-bound 断连/退出不回滚已接受设置，也不承诺后台继续。会话表及固定撤销合同保持。

> #112 Proposed 增量见末节与 [design/21](../design/21-invited-account-access.md)：待评审、不生效，以下既有 Required 字段/迁移保持；新增准入、加密联系邮箱、一次凭证和邮件记录尚不存在，不能按文档推断数据库已升级。

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
| `timezone_id`        | `text`        | nullable                     | 本人默认时区规范 ID，仅限实际规则包支持范围；未设置/明确清除为 NULL，不承诺完整 IANA                    |
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
- 本人偏好读用例 `readUserPreferences` 与写用例 `setUserTimezoneWithinTransaction` 归 identity，使用调用者事务和受信 owner。写入锁定 active 本人行，仅更新 timezone_id/updated_at；不接受任意 users patch。
- 非 null 保存只认当前真实别名表和规则包中的 zone；先转规范 ID，未知/不支持报 `UNKNOWN_TIMEZONE`，规则不可用报 `TZDB_UNAVAILABLE`，零偏好写入。`null` 是清除，不依赖可用规则；接受结果保留真实 `previous_timezone_id`、`timezone_id` 和 `alias_version`，规则不可用时清除的版本明示 `unavailable`，不伪造版本。
- 新 delegation 的工具网关将该更新、稳定 invocation 的 accepted result 及只追加审计放在同一事务；重放同调用返回原结果，不改写旧回执。直接保存/清除不制造 pending/consumed 批准；legacy 工具范围不因此扩权。

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

- token 明文存储禁止；OAuth 与多用户组织模型不在本增量范围。联系邮箱验证/找回见下方 #112；`token_hash` HMAC 和 credential 合同保持。
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

## 受邀账户增量（#112）

本节对应前向迁移 `0024_invited_accounts.sql` 与精确结构基线 `scripts/local/baselines/0024-checks.json`。保留旧表原列/行，增加 credential 的 user 唯一约束及下列 identity 自有表；`auth_email` 永远是不透明库句柄，`primary_email_hash/email_verified` 不充当新恢复事实。行为/锁序见 [design/21 §2–§7](../design/21-invited-account-access.md)，公开 DTO/路由见 auth API §5。

### 基础类型、加密和锁

下表均为 identity 自有记录。ID 服务端 UUID，引用 identity 用户/邀请/凭证均 FK `on delete restrict`；时间为 `timestamptz`，事务判断用取锁后的 PG `clock_timestamp()`，不依赖客户端时间。enum 使用 `text + CHECK`。计数/代次为非负或正整数并有对应 CHECK，过期必须晚于创建。新模型不把跨模块 owner 变成可修改 FK。

`*_digest` 为用途分离 HMAC-SHA256（固定 32-byte `bytea`），不可枚举普通 SHA 不可代替。`*_ciphertext` 为 AEAD `bytea`，随行保存独立 `*_nonce`（12-byte）、`*_tag`（16-byte）、`encryption_key_id text`；AAD 按 design/21 §3 绑定记录、owner/邀请、用途/代次/key-id。lookup、challenge、rate-limit 的密钥/上下文独立，现有 BETTER_AUTH_SECRET 与 session HMAC 不改。密码/完整邮箱/token 不进 metadata、明文 JSON 或日志；加密 token 仅存在必要邮件 payload。

地址相关写入统一先取从完整 contact lookup digest 派生的 PG 事务 advisory lock（64-bit 截断仅用作互斥，最终相等性/唯一仍比完整 digest；碰撞只导致额外串行），再锁 users（多 user 按 UUID 排序）→ invitation/challenge → credential/session/delivery。只持一个地址锁；换绑不必取旧地址锁，旧联系方式在同一 user 锁下撤销，涉及另一 user 的地址争用由完整 digest 唯一约束裁决。安装初始化沿原独立全局锁，普通操作不用它。管理员管理写入需锁并复验发起管理员及目标的用户资格，不先锁 invitation 再回头锁 user。停用不反向取得 task/Run 锁；scheduler/通知只通过 identity 公共资格函数持 user SHARE 锁，细节见 design/21 §7。

### `identity_account_admissions`：业务准入

| 字段                  | 类型/约束                                                    | 含义                                  |
| --------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `user_id`             | uuid PK/FK users                                             | 显式获准的原业务身份，不是角色表      |
| `source`              | text CHECK `installation_admin/invitation/local_maintenance` | 准入依据                              |
| `invitation_id`       | uuid nullable UNIQUE/FK invitations                          | invitation 来源必须非空，其他来源为空 |
| `admitted_at`         | timestamptz not null                                         | 获准时刻                              |
| `credential_revision` | bigint not null default 1，>=1                               | 登录/改密/恢复/停用竞争的复核版本     |
| `reset_generation`    | bigint not null default 0，>=0                               | 当前恢复代次                          |
| `contact_generation`  | bigint not null default 0，>=0                               | 当前联系方式申请代次                  |

users.status 继续是 active/disabled/deleted_requested 的唯一状态事实；准入存在不等于 active。迁移仅从有效 installation_admin 明确补一条，其他历史 user 不回填。source/invitation_id 的互相依赖可用同一迁移中的约束完成，不需要先建空引用或预占迁移号。新邀请原子建立 user、credential、admission、contact，并设置邀请 accepted_user_id；互相引用在事务内写齐后验证，不留半开户事实。

### `identity_contacts`：唯一已验证联系方式

| 字段                                  | 类型/约束                      | 含义                                             |
| ------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `id`                                  | uuid PK                        | contact 记录身份                                 |
| `user_id`                             | uuid not null UNIQUE/FK users  | 每 user 一个当前已验证地址                       |
| `lookup_digest`                       | bytea not null UNIQUE，32-byte | 对规范邮箱的 contact lookup HMAC                 |
| `lookup_key_id`                       | text not null                  | 当前 lookup key 版本，不纳入 unique 的分区键     |
| `address_ciphertext` 及 AEAD 伴随字段 | bytea/text not null            | 可投递原地址，仅在发信/授权换绑/密钥迁写边界解密 |
| `masked_email`                        | text not null                  | 输入规范化时生成的脱敏展示值，不参与查找/唯一性  |
| `revision`                            | bigint not null >=1            | 换绑时在原 user 下递增；绑定恢复凭证             |
| `verified_at/created_at/updated_at`   | timestamptz not null           | 验证与维护时刻                                   |

只存已验证地址，未验证候选在 challenge，不能长期预占唯一地址。同 digest 的验证/接受竞争在地址锁与数据库唯一约束下最多一个 owner。换绑需更新 AEAD/AAD、递增 revision 并撤销旧 revision 的恢复资格；不改 users.auth_email/email_verified。HMAC lookup 轮换必须先停相关写入、全量核验唯一后切换，不能因不同 key-id 给同地址建两条。邮箱/密钥恢复失败是依赖故障，不返回空联系人。

### `identity_invitations`：邀请与代次

| 字段                                      | 类型/约束                                              | 含义                                                         |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `id`                                      | uuid PK                                                | 邀请身份                                                     |
| `created_by`                              | uuid not null/FK users                                 | 发起管理员，只用于窄管理事实                                 |
| `lookup_digest/lookup_key_id`             | bytea/text not null                                    | 与 contact 共用规范地址 namespace                            |
| `address_ciphertext` 及 AEAD 伴随字段     | nullable bytea/text 组；pending 必填                   | 邀请收件地址；终结后依批准留存擦除时整组为空                 |
| `masked_email`                            | text not null                                          | 管理列表的脱敏展示值，不需解密原地址                         |
| `state`                                   | text not null CHECK `pending/accepted/revoked/expired` | 显式生命周期，不用时间表达 partial unique                    |
| `generation`                              | bigint not null >=1                                    | 重发递增；旧代失效                                           |
| `expires_at/created_at/updated_at`        | timestamptz not null                                   | 当前代严格 48h；时间在创建事务确定                           |
| `accepted_user_id/accepted_at/revoked_at` | uuid FK/timestamptz nullable                           | accepted 必须有 user/time；revoked 必须有 time，其余不得伪填 |

partial UNIQUE `(lookup_digest) WHERE state='pending'`；持地址锁先把到期 pending 终结再创建，不能在索引谓词用 now()。已验证 contact 不允许另建 pending 邀请。index `(created_by,created_at DESC,id DESC)` 支持管理列表，index `(state,expires_at)` 支持到期收尾；到期维护/GET 不消费 token。accepted 唯一对应一个新账户，撤销不能删除 user 或更改 owner。

### `identity_challenges`：三个互斥用途的一次凭证

| 字段                                    | 类型/约束                                             | 含义                                                                                                    |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                                    | uuid PK                                               | 凭证记录身份                                                                                            |
| `purpose`                               | text CHECK `invitation/verify_contact/reset_password` | 必须与实际消费用例相同                                                                                  |
| `token_digest/token_key_id`             | bytea UNIQUE/text not null                            | `HMAC(K_challenge, purpose + 分隔符 + raw_token)`；仅摘要用于消费                                       |
| `user_id/invitation_id`                 | uuid nullable/FK                                      | invitation 仅绑定邀请；另两种仅绑定 user，CHECK 互斥                                                    |
| `lookup_digest/lookup_key_id`           | bytea/text not null                                   | 固定目标地址摘要，不能从消费请求改收件人                                                                |
| `generation`                            | bigint not null >=1                                   | 对应邀请或 admission 的该用途当前代次                                                                   |
| `contact_revision`                      | bigint nullable                                       | reset 必填且匹配当前已验证 contact；verify 候选不借旧地址取得恢复权                                     |
| `candidate_ciphertext` 及 AEAD 伴随字段 | nullable bytea/text 组                                | 仅 verify_contact 的待验证地址；验证成功立即擦除，否则最迟到期后24h整组擦除，其他用途不复制原地址/token |
| `masked_email`                          | text nullable；verify_contact 必填                    | 候选地址脱敏展示值，其他用途无需复制                                                                    |
| `created_at/expires_at`                 | timestamptz not null                                  | 邀请48h；验证/恢复30min，严格取锁后判断                                                                 |
| `consumed_at/revoked_at`                | timestamptz nullable                                  | 最多一次消费；撤销/消费均不可复活                                                                       |

UNIQUE `(purpose,invitation_id,generation)` 对邀请生效；UNIQUE `(purpose,user_id,generation)` 对本人用途生效。index `(user_id,purpose,generation)`、`(invitation_id,generation)` 和 `(expires_at)` 支持当前代和维护。消费条件同时要求当前代、正确用途/地址 revision、未消费/撤销、未到期及当前资格；一个原子事务条件更新并建立完整业务结果。失败回滚也回滚 consumed_at，不允许先标消费后异步开户/改密。

### `identity_mail_deliveries`：提交后可靠边界

| 字段                                         | 类型/约束                                                          | 含义                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `id`                                         | uuid PK                                                            | 稳定 delivery/供应商幂等身份                                          |
| `challenge_id`                               | uuid not null UNIQUE/FK challenges                                 | 一个凭证一封逻辑邮件，重发用新代/新记录                               |
| `generation/purpose`                         | bigint/text not null                                               | 领取时与 challenge 再核验，不赋予另一个用途                           |
| `status`                                     | text CHECK `queued/submitting/submitted/failed/unknown/suppressed` | submitted 仅接受；unknown 不盲重发                                    |
| `payload_ciphertext` 及 AEAD 伴随字段        | nullable bytea/text 组                                             | 收件地址、固定模板数据、链接 raw token 的加密最小载荷；擦除后整体为空 |
| `provider_request_id/acceptance_id`          | nullable text                                                      | 脱敏受控供应商标识，不存含地址/凭证的响应体                           |
| `attempt_count`                              | integer not null default 0，>=0                                    | 只计真实领取/尝试，不是可无限重试的授权                               |
| `created_at/updated_at`                      | timestamptz not null                                               | queued 持久化与状态更新时间                                           |
| `submitted_at/finished_at/payload_erased_at` | nullable timestamptz                                               | 真实边界及擦除事实；未知不能伪填 submitted                            |
| `failure_code`                               | nullable text                                                      | 封闭内部脱敏分类，不记原响应/邮箱                                     |

index `(status,created_at,id)` 支持有限领取，领取用行锁/状态 CAS；业务事务写 queued，提交确认后才可发送。submitting 在网络前提交；超时/重启不确定一律 unknown，只有可信未接受证据才可收敛为 failed，不自动重投。queued 的旧代/过期凭证可 suppressed。终态立即擦除 payload、其余最迟到期后24h；其余摘要30天的拟议上限及外部保留批准见 design/21 §5/PRD。加密并不授权无限保留。

### `identity_action_keys` 和 `identity_rate_limits`

邀请创建/重发幂等记录：`actor_id uuid FK`、`action text CHECK invite_create/invite_resend`、`key uuid` 作联合 PK；`request_digest bytea`（规范化 action/目标/地址，不含密码的 HMAC）、`request_key_id text`、`response_snapshot jsonb`（原严格脱敏 InvitationView）、`invitation_id uuid FK`、`generation bigint`、`delivery_id uuid FK`、`created_at/replay_until timestamptz` 必填。同事务与邀请/代次/投递写齐；不保存原 token、密码、完整地址或未经脱敏响应。重放用原 key-id 校验请求，返回原快照，不因活动 key 轮换、后续代次、终结或邮件状态改变而重开邀请/重算结果。重放资格至少7天，超期保留 key 墓碑、返回 IDEMPOTENCY_EXPIRED；获得留存批准前不自动删除墓碑导致同键复用。

持久配额记录联合 PK `(action,dimension,subject_digest,window_started_at,window_seconds)`；`subject_key_id text`、`count integer >=0`、`expires_at timestamptz` 必填。dimension 封闭为 identifier/address/ip/actor/token；地址/IP 均 HMAC，action 与窗口由服务端选择，不能请求体覆盖。所有命中的维度在固定窗口内原子检查并增量提交，超限不因后续业务回滚清空计数；先完成独立配额事务再进入身份业务事务。具体阈值见 design/21 §5.2；计数到窗口结束后24h清理，index `(expires_at)`。无账户和无效 token 也按相同输入摘要计数，不产生存在性旁路。

### 既有 credential/session 及发布约束

- users/status、installation_admin 和原 auth_email/secret 不迁写。新增 `UNIQUE(auth_accounts.user_id)` 的 credential-only 唯一约束前先扫描旧重复/不一致并停止，不自动删行/改 account_id；本阶段 provider 仍只能 credential。旧合法 credential 原行/哈希不变；只有本人改密/恢复才经锁定库更新密码、递增 admission.credential_revision。
- 新登录以 user 行锁序列化与重置/停用，验证版本后库创建 session；重置/改密同事务更新唯一 credential、消费/撤销 challenges 并 `UPDATE sessions ... revoked_at ... WHERE user_id=...`。固定七天、软撤销、HMAC、created_at/expires_at 不变。session 列表直接读本人公开投影，不要求 adapter 伪造 raw token。
- 对恢复/改密/停用的每次失败和 COMMIT 未确认，不发新/清 Cookie；库返回 headers 只是提交前暂存结果。确认提交后才发布。原所有业务 owner/历史不由 identity 更改。
- `0024` 在正式升级停旧写者后执行预检和事务 DDL，结构核验覆盖全部新列/约束/索引；异常中止、保留原事实、只前向修复。新事实写入后不能降回不理解准入/邮件状态的旧写者。公开入口放行需真实双用户/邮件/生产 HTTPS、并发/回滚和旧副本两次启停证据，不能以 schema 文档视为实施完成。
