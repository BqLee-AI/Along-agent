# 21. 受邀账户、联系邮箱与恢复

> 状态：**Proposed（待评审）**；#112 的 P0 正式合同增量，不生效、不开放入口，不表示以下字段、路由或行为已存在。
> 范围：业务准入与安装管理分离、加密联系邮箱、邀请/验证/恢复、固定会话、停用及无损前向升级的拟议合同。
> 不包含：P1 生产实现/端点开放、部署、原安装变更、供应商采购、飞书/办公连接或 Harness/运行所有权重构。
> 阶段：#112 账户 P0；合同与隔离可行性证据，P1 完整旅程另行授权。
> 现行 Required 仍为 [design/16](16-r1-account-access.md)、[auth API §1–§4](../api/auth/auth_routes.md)、[identity schema 的既有章节](../schema/identity-schema.md) 与 `openspec/specs/identity/spec.md`。本提案经独立评审、P1 完整实现及验收后才替换明确指出的旧条款；本 PR 不改有效 specs、不 archive、不关闭 #112。
> 依据：[#112](https://github.com/BqLee-AI/Along-agent/issues/112)、[规划 §1–§4、§7–§9、§11](../plans/account-and-office-connectors-plan.md)。API/字段分别在 auth API §5、identity schema 的 #112 Proposed 章节定义；行为增量位于 `openspec/changes/productize-invited-accounts/`。

## 1. 结论、现状与取舍

推荐保留原认证链，只把“绑定管理员才可登录”的业务策略替换为 identity 持有的**显式准入且 active**；安装管理员仍只有一个，但不拥有别人的业务资料。真实邮箱使用独立加密联系方式，不迁写库的 `auth_email`，不启用库对 `local.invalid` 的邮件验证。邀请、验证和恢复各自一次凭证，事务只包含 PG 事实；邮件在提交后发送。接受邀请和恢复均不自动登录，正常登录仍由 Better Auth 签发 Cookie。

**Observed（代码基线 `76f8b78bd334e025fc98b6c75cf4d9c7bb7b19ed`，静态核对）**：

- `identity/account-service.ts#signIn` 同时校验唯一 credential、active 和管理员绑定；仅插入普通用户并不能正式登录。`transaction` 现持安装级锁，普通账户操作不能继续全局串行。
- `identity/crypto.ts#deriveAuthEmail` 对规范用户名作 HMAC，生成不透明 `@local.invalid` 句柄；`deriveEmailHash` 的简易正则和同用途密钥不是本提案的正式邮箱策略。
- `identity/better-auth.ts` 固定 Better Auth 1.7.10，`email` 映射 `auth_email`，固定 604800 秒、不 refresh、不 cache。`pg-adapter.ts` 仅存 token HMAC；已有同 client 事务及提交后 Cookie 发布边界可复用。
- `http/auth.ts#resolveSession` 查签名、HMAC、PG 到期/撤销与 active，但尚无准入检查。`identity/routes.ts` 与 `http/app.ts` 是两处精确名单，不是库 handler。
- `tasks/scheduler/send.ts` 在 task/outbox 栅栏下领取一次发送许可，再复查后调用；`notifications/service.ts` 独立接收并提交，目前两者未核验账户准入/状态，必须有跨模块增量，不能声称现有门已覆盖停用。
- workspaces 按 owner 提供 grant；无 workspace 的 conversations 分支已使用基础工具集合。本机 `local:account` 当前以绑定管理员为登记目标，不能照搬给普通账户。

[2026-10-27 历史验收](../verification/account-access-verification-2026-10-27.md) 只证明 #68 的指定版本。[本轮 P0 可行性证据 F1–F5](../verification/invited-account-feasibility-2026-11-03.md) 已在 Better Auth 1.7.10、Bun 1.4.2、真实隔离 PG16.15 上观察：非管理员库 Cookie 可过正式 `/me`，而现行 sign-in 对同人仍 401/零 Cookie；原管理员身份/credential 不变；实际库改密及最小全撤销编排可用；真实 client 中途失败回滚；正式 HTTP 在 COMMIT 前无响应、提交失败和受控 ACK 丢失均 503/零 Cookie（后者 PG 已提交）。这些不是 P1 端点、逐用户竞争、双浏览器/正式 Web、邮件或生产 HTTPS 证据，不以样例或旧绿色替代。

未选方案：公众注册不满足邀请准入；真实邮箱替换 `auth_email` 会破坏原用户名/credential 和密钥兼容；全量库 handler 暴露未评审入口；手写密码/Cookie 或第二认证系统重复安全状态。只沿现有 service、worker 和公共投影增加具体用例，不建角色平台、通用限流/邮件框架或第二 Run driver。

## 2. 准入、管理与旧身份

以下均为 Proposed：

- `installation_admin` 仅授予创建/管理邀请、查看最少账户管理摘要和停用普通账户的资格；每次写入重新核验当前签名会话、管理员绑定、active/准入、Origin、CSRF 和当前密码。不缓存“已解锁管理员”票据。
- identity 准入事实只有 `installation_admin | invitation | local_maintenance` 三种来源；普通登录要求准入、active、唯一正式 credential 和库口令验证。邮箱登录与用户名登录走同一门。管理员无代登录、他人口令重设、恢复凭证或资源读取特权。
- 所有旧 `users.id/auth_email/credential`、原 secret、session HMAC、业务 owner 和历史保持。迁移只为**当前绑定管理员**补准入，不能给全部 active users/seed/历史 owner 批量补准入或重建 credential。异常管理员/重复 credential 停止升级，明确维护，不猜人。
- 其他旧 owner 需要部署者经原安装本机入口明确选人、核验原身份/已有口令并确认，在原 ID 上补准入；无密码的旧转正沿 design/16 原授权门，不以匿名邀请按邮箱“认领”。既有非空 credential 不覆盖。
- 空安装/旧安装未绑定时的初始化、原身份转正和本机维护仍按 design/16；绑定后绝不因停用、会话失效或依赖故障重开匿名初始化。切换后绑定管理员原有效会话保持；其他未准入 owner 的旧会话不成为准入证明。未绑定安装所需的旧会话仅能进入原 claim 路径，不能借此取得新邀请/管理能力。
- resolver 和 identity 公共资格读取统一执行准入/active，不要求“是管理员”。受保护入口每次解析、长期执行新动作及新内容披露前重新核验；不把“登录时检查过”当永久资格。资格读取失败 fail closed 并返回依赖故障。

## 3. 联系邮箱、规范化与密钥

### 3.1 唯一的邮箱策略

首阶段仅接受 ASCII 单 mailbox：先去除首尾 ASCII 空白；拒绝内部空白、控制字符、多地址、注释、显示名、quoted local-part、域字面量与 Unicode。总长最多 254 字节，local-part 1–64 字节，为 ASCII dot-atom（不得首尾点或连续点）；域名为至少两段 ASCII DNS LDH label，各段 1–63 字节，不得首尾连字符或末尾点。ASCII punycode label 按同规则处理，不把 Unicode 自动转码。域名和 local-part 都 lowercase 是**产品规则**，不是 SMTP 等价性声明；不移除 `+tag`、不合并点号、不做供应商别名或 Unicode 相似合并。Web 只消费共享输入合同，identity 为唯一规范化实现。

可投递地址（保留输入的 local-part 大小写、域小写、去掉外围空白）只保存 AEAD 加密值；规范化地址只保存用途分离 HMAC。验证后每 user 一个当前地址、每规范地址最多一个已验证 owner。旧 `primary_email_hash/email_verified` 不提升为此事实，不批量设 true，不拿它们作恢复授权。

联系记录、邀请和候选 challenge 在规范化输入时同时生成 `masked_email`（规则见 API §5），供授权投影直接读取；它不是 lookup/唯一性依据，不存足以还原完整地址的 local-part。这样列表不必为展示脱敏地址解密完整地址；完整地址只在投递、获授权换绑/密钥迁写的受控边界解密。

查找摘要为 `HMAC-SHA256(K_contact_lookup, "identity:contact:v1:" || normalized)`；邀请/挑战引用同一 contact lookup digest 以裁决唯一，不另建不相交 namespace。一次凭证摘要、认证限流摘要各有独立密钥/上下文；不复用 `BETTER_AUTH_SECRET`，不使用可枚举普通 hash。加密用成熟 AES-256-GCM，随机 96-bit nonce、完整 tag，AAD 绑定 identity/记录 ID/owner 或邀请 ID/用途/代次/key-id。完整邮箱和原始凭证仅在受控内存及必要邮件处理方出现，不在普通 JSON、日志、审计、错误、URL query 或浏览器持久存储出现。

密钥配置、托管、备份恢复和保留批准以 [PRD 待决项](../prd/04-acceptance-open-questions.md) 为准，本页不猜供应商或配置取值。lookup HMAC 同一时刻只有一个写入版本；轮换必须停相关写入，使用旧 AEAD 解密当前 contact、pending 邀请及未终结 challenge 的地址，重算关联摘要、核验唯一后原子切换。已终结且地址密文已擦除的记录保留旧 digest/key-id 作为历史，不参与当前地址查找或占位；不能要求从已擦除密文恢复地址，也不能简单把 key-id 加进 unique 而允许同地址两条。旧 AEAD key 在全部相关数据迁写/到期前保持可恢复；缺 key 返回 503，不生成替代 key。原认证 secret 不轮换。

### 3.2 本人验证与换绑

本人携当前密码申请候选地址；事务撤销本人的旧验证代次并写新 challenge/加密邮件，不提前占据已验证地址。现有邮箱在新地址验证成功前继续有效。验证 POST 同时要求发起 user 的有效签名会话、Origin、CSRF 和对应一次凭证；不允许在切换账户后验证给另一个人。登录过期先正式重登，再显式提交，不自动重放验证。

验证事务重新检查 active/准入、地址归属及当前代次，原子消费 challenge、建立/替换当前联系方式并撤销旧 contact revision 的全部恢复凭证。相同地址已由其他 user 验证返回有资格入口的脱敏冲突；不泄漏其 ID，不合并 user。与 pending 邀请的地址冲突在同一地址锁下裁决：验证成功收尾该 pending 邀请并撤销其凭证/未发邮件；邀请已接受则由唯一联系方式约束拒绝另一个 owner。候选未验证不永久占位。

## 4. 邀请与一次凭证

### 4.1 一封邀请到独立账户

1. 管理员已拥有验证联系方式并重新验证当前密码，创建指定邮箱邀请。请求不含目标 owner；同事务写邀请、当前代次凭证及加密投递记录，提交后返回 queued，不说已送达。
2. 邮件链接为固定 APP_ORIGIN 下的账户页面，token 仅在 fragment；页面无第三方脚本、no-store、`Referrer-Policy:no-referrer`，读取到内存后立即 `history.replaceState` 清除 fragment。页面 GET/预览/扫描零消费，不自动 POST；token 不进 query、日志或本地存储。
3. 收件人主动提交凭证、用户名/密码/展示名。已登录任意 Along 账户时先明确退出/切换，接受返回 `409 SIGN_OUT_REQUIRED`，不隐式合并或把 Cookie owner 当邀请对象。token 证明该邮箱持有人，不授予安装管理或工作区。
4. 接受事务在地址锁和邀请锁下复核代次/用途/期限/状态、邮箱唯一和用户名唯一，建立一个新 user、一条库 credential、准入与验证联系方式，消费凭证并标 accepted。失败全部回滚。新 `auth_email` 仍按用户名派生，contact 不写库 email。
5. 返回账户已建立但 `authenticated:false`，**不创建 session、不发 Cookie**。用户随后使用正式 sign-in。接受响应丢失不重复开户；重复有效格式凭证统一失效提示，引导登录/恢复，不回传之前的 user 或密码写入结果。
6. 新人进入本人空资源面；邀请不会复制任何管理员资料、设置、偏好、workspace 或 owner。无 workspace 返回空集合，账户/会话/恢复可用；聊天仅在原有模型/native/时间依赖真实可用时可用。

已验证邮箱不允许邀请建立第二身份；有资格管理员只获 `CONTACT_UNAVAILABLE`，不知道已有用户 ID/资料。匿名接受不披露现有账户状态。相同地址最多一个 pending 邀请，过期在持锁事务中先终结，不能以 `now()` 作 partial unique 条件。

### 4.2 凭证代次、期限、幂等和竞争

用途限定 `invitation | verify_contact | reset_password`，32 随机字节、base64url 编码，持久层仅用途分离 HMAC。邀请 **48 小时**、验证 **30 分钟**、恢复 **30 分钟**；这些是本次待评审的 Proposed 初始产品参数，按 PG 当前时间（取锁后 `clock_timestamp()`）严格判 `now < expires_at`，TTL 不因 GET/邮件排队延长。

凭证绑定目标、地址 digest/revision、用途和 generation。重发建立新 generation 并撤销旧代全部凭证与 queued 邮件，TTL 从新代创建时起算；已经 accepted/revoked 的邀请不得重发。撤销和重发使用同一地址/邀请锁，接受与撤销谁先持有写权且成功提交谁赢；失败事务不算赢。换绑、恢复成功、改密、停用/注销撤销相关旧凭证，不能跨用途兑换或在线激活停用账户。

邀请创建与重发要求管理员范围内 `idempotency_key`（UUID）；同 action/actor/key 和同规范化输入重放原安全 DTO，不再写凭证/投递；同键异参 409。fingerprint 用 HMAC，不保存密码；密码只作当次授权、重放也重新核验。创建键至少保留 7 天，超期键明确失效冲突而不静默重新创建；P1 保留/清理策略获批准前不清键。撤销重复为成功，accepted 再撤销为状态冲突。一次凭证消费不接受通用幂等键；重复消费统一失败，不能凭重放再写密码或签 session。

凭证验证使用可恢复的用途 key-id：新凭证只用当前活动用途 key 写入，消费时仅在受支持的少量保留 key 上计算对应用途摘要，旧 key 保留到其最后凭证到期及批准审计期结束。不能因 key 轮换复活旧代或跨用途匹配；未知 key/缺 key 是依赖故障，不是重新开户/重发的理由。候选 challenge 地址密文在验证成功后立即擦除，否则最迟到期后24h擦除；邀请终结后的地址密文按批准期限擦除，只保留最小脱敏管理事实。

## 5. 提交后的邮件和持久限流

### 5.1 邮件状态不是收件箱事实

identity 自有窄投递记录由既有 worker 角色消费，不复用 task/schedule `outbox`，不新增通知平台/服务。业务 PG 提交确认前禁止外部发送。状态固定 `queued → submitting → submitted | failed | unknown`，以及写前明确失效的 `suppressed`。`submitted` 只表示供应商接受，绝不展示“送达”；供应商明确拒绝为 failed；超时、断连、进程死于 submitting 或接受结果丢失为 unknown。GET 不重试/重发。

领取事务验证凭证当前代次、未撤销/消费且未过期，原子记录 submitting/attempt；无效 queued 改 suppressed。提交后发送只使用稳定 delivery ID 作供应商幂等身份，有界超时。外部请求不持 user/邀请写锁；撤销后的在途旧邮件可能到达，但凭证无效。重启后 queued 可领取；遗留 submitting 只经供应商可信查询收敛，不能证明未接受就标 unknown，**不自动重投**。failed/unknown 后由用户显式重发生成新代/新 delivery；不能将供应商有限幂等窗口当作跨 48h 恰好一次保证。

投递载荷含 token/地址只能 AEAD 加密，worker 在内存解密。初始技术最小化上限：payload 在提交终态后立即擦除，queued/submitting/unknown 最迟凭证到期后 24h 擦除；供应商/审计摘要拟保留 30 天（无明文地址/凭证）；已消费凭证仅留摘要/时间用于 30 天审计。当前绑定邮箱保留到显式换绑/获批准清理，不用注销请求虚称物理删除。以上留存须经 PRD 隐私/保留审批，未批准不能开放真实入口；供应商侧留存另列外部前置，不宣称本地清理等于上游删除。

### 5.2 初始配额与匿名失败

identity 的 PG 原子固定窗口配额，所有 API 进程共享，按 PG 时间/动作/主体 digest 计数，禁止只在内存或 Web 倒计时。命中任一维度返回 `429 RATE_LIMITED` 与整数秒 `Retry-After`，从对应窗口剩余时间取最大值，失败重试不重置窗口；不永久锁号。拟议起步值：

| 动作                                            | 账号/邮箱/目标维度                             | 可信来源 IP 摘要维度 | 额外范围                           |
| ----------------------------------------------- | ---------------------------------------------- | -------------------- | ---------------------------------- |
| sign-in（用户名/邮箱分别规范化 HMAC）           | 10 次/15min                                    | 60 次/15min          | 成败均计，不按存在性跳过           |
| 匿名恢复请求                                    | 3 次/1h，每地址                                | 20 次/1h             | 不存在、未验证、停用也按同地址扣额 |
| invitation accept / reset complete              | 10 次/15min，每 token digest                   | 60 次/15min          | 无效格式也按有界输入 digest 计     |
| 联系地址申请/重发及验证                         | 5 次/1h，每 actor；验证另 10 次/15min 每 token | 30 次/1h             | 每目标地址邮件 3 次/1h             |
| 管理邀请创建/重发                               | 20 次/1h，每管理员                             | 60 次/1h             | 每目标地址邮件 3 次/1h             |
| 当前密码再验证写入（改密/停用/注销/会话批撤等） | 10 次/15min，每 actor                          | 60 次/15min          | 不能借会话撤销暴力验证密码         |

配额先于目标存在性分支，PG/key/邮件配置预检也必须与目标无关；匿名恢复对不存在、未验证、未准入、disabled/deleted_requested 或有效请求统一 `202 {accepted:true}`，表示请求接纳而非已发送。有效格式但失效/错用途/错代次/已消费 token 统一 `409 TOKEN_INVALID`，不透露目标状态；登录各失败统一 401。密码验证失败采用库提供的同等成本拒绝路径，不能由是否存在省去密码工作；不承诺网络恒定耗时。依赖全局不可用准确 503，配额 429，语法错误 400，不伪造 202。

IP 只取经过明确可信代理链配置的 socket/转发元数据；不能信任客户端任意 `X-Forwarded-For`。Web proxy 必须覆盖内部来源头，API 只接受可信 Web 网络的该头；无可信链时按直连 peer 限流（可能共享，明确部署限制），不得跳过限制。digest 和计数到窗口结束后 24h 清理；不持久化明文 IP 或邮箱。阈值后续按真实误伤/滥用证据另行评审，不自动放宽或加重试系统。

## 6. 改密、恢复和会话并发

恢复只发往当前已验证邮箱；请求不能指定替代收件地址。恢复发起递增 user 的 reset generation、撤销旧代、原子写 challenge/投递。完成事务复核准入/active、contact revision、用途/代次/期限，用 **Better Auth 1.7.10 的 password hash/verify 与当前 client-bound adapter 更新唯一 credential**，同时递增 credential revision、消费本凭证、撤销其他恢复及验证凭证、软撤销全部 sessions；不自动登录。[P0 F2](../verification/invited-account-feasibility-2026-11-03.md) 已实际观察库 `api.changePassword({revokeOtherSessions:false})` 成功，以及库 verify/hash→同 client adapter.update→PG 全撤销的最小编排可行；这不证明正式一次凭证/锁版本/清 Cookie 用例已实现。`revokeOtherSessions:true` 未实跑，静态源码会新建替换 session，不能直接用于“全部退出”目标。identity 负责同 client 用户资格锁/credential revision、全软撤销及确认 COMMIT 后才库清 Cookie，不能以库 success 代替这些边界，更不能自研密码算法/第二 Cookie 或挂载 handler。

本人改密要求签名会话、当前密码、Origin/CSRF；同事务更新 credential/revision、作废旧恢复/验证凭证及全部会话（包括当前）。提交确认后才返回成功和库生成的清 Cookie；失败/提交未知 503，不清 Cookie、不承诺旧密码仍有效。再次操作应正式登录/读取当前事实，不自动重放新密码。

并发裁决：登录、改密、恢复、停用都在相同 user 行锁下复核资格和 credential revision。允许锁外计算 hash，但登录验证快照必须在持 user 写锁后重新核验 revision，或在同一锁内调用库验证并创建 session；严禁“旧密码验证成功 → 重置提交 → 旧密码再提交新有效 session”。重置先提交则旧密码登录失败；登录先提交则重置撤销该 session。Cookie 只在确认整个事务提交后向调用方发布；COMMIT 结果未知即使库已生成 Cookie 也不得发布。

会话仍固定创建后 7 天，不滑动、不 refresh、不 Cookie cache、不手写 Cookie。本人列表只含 session ID、创建/到期、current、有界设备摘要，不含 raw token/HMAC/完整 IP。单个撤销限定 owner/session，自己的已撤销记录幂等成功；别人的或未知 ID 均 404。不改变创建/到期时间。撤销当前或全部时先提交再由库清 Cookie；撤销 others 保留当前，参数不接受任意 owner。普通退出/改密不是取消任务，已接纳 Run 的生命周期仍由现行/冻结的 conversations 合同持有，不提前实现 #104/#105。

## 7. 停用、注销请求及跨模块许可

管理停用只允许普通账户；本人注销请求需当前密码/确认。事务锁定并复核绑定与目标，设置 `disabled` / `deleted_requested`，递增 credential revision、撤销 sessions、未消费 challenge 及尚未发送的邮件资格。**唯一绑定管理员无论本人注销还是管理停用都返回 `409 SOLE_ADMIN_PROTECTED`**，不开放交接/解绑接口，不删除 user、不迁 owner、不开放再次初始化；需要交接时走另行评审的本机维护方案。本切片无在线恢复 disabled/deleted_requested 的入口，恢复 token 也不能复活状态。

identity 只更新自有事实，不反向锁 task/Run 或写取消状态机。复用 `identity/preferences.ts` 的现有公共资格入口，拟议将 `isActiveOwner(client, ownerId, {lock:"share"}) → boolean` 扩为同时检查准入/active，并按需在当前 client 锁 user；无锁读取仍服务于既有资格检查，不建立第二套权限服务。各模块调用这一公共规则，不直读 identity 私表，也不修改本人时区/偏好合同。相关规则：

- scheduler 的新发送许可事务维持 task → outbox 原锁序，随后持 user **FOR SHARE** 核验准入/active，许可提交释放锁；停用持 user 更新锁，二者由数据库串行裁决。停用先提交，许可数/实际调用增量均为零；许可先提交属于已许可在途，不能声称已追回。
- 调用前保留原 task/outbox 取消与时间栅栏；可再查当前资格以缩小在途，但不许把已提交许可当作可重新领取。无资格且确定尚未调用的 send 标 superseded，并保留脱敏 `owner_ineligible` 原因；不得把 task 标 cancelled/fired，不制造撤销回执。任务原窗口/过窗和 unknown 核对规则继续生效。
- notifications 独立接收新通知时同样通过公共资格函数持 user FOR SHARE 至接收提交；停用已提交则拒绝新的内容接收。已提交匹配接收事实仍可被只读核对，不因停用删除、改 owner 或谎称没发送。不得重演 provider。
- user SHARE 与接收端 SHARE 相容；停用只锁 identity，不反向锁 task/outbox，接收端不锁 task，因此不产生“scheduler 持用户独占锁等待独立接收”的死锁。实现须以真实 PG 双连接/进程验证，不能把资格预读当原子门。
- 新工具动作、workspace grant、Run 接纳/结果披露按原公共 owner 门加当前资格；普通退出或到期与账户停用分开。此处不重写 driver/后台能力；已外发字节和外部已接受/unknown 事实保留，停止新披露不等于抹除历史。

## 8. 正式 HTTP、Web 与多 owner 维护

拟议窄路由及 strict DTO/错误见 [auth API §5](../api/auth/auth_routes.md)。除保留的初始化/状态路径外，新增匿名入口仅恢复请求/完成和接受邀请；登录仍为匿名入口，验证联系方式需本人会话。所有 POST 精确 Origin，签名写入再验 CSRF。保留 131072 原始 UTF-8 字节上限和身份先于 body 收集；两处 route allowlist 同步，无全量库端点、任意 callbackURL 或通用 users PATCH。

正式 proxy 保留实际 Origin、多个 Set-Cookie、no-store、流式/SSE/abort 与有界上传；不伪造客户端 Origin、不全局放行 Location。生产固定 APP_ORIGIN/HTTPS 与邮件链接域名须真实取证，localhost 不替代 Secure/host-only/SameSite/Lax 的生产验收。只有受保护请求 **HTTP 401** 导向安全站内重登；403/CSRF、429 和 503 留在原页准确解释；匿名 token 409 不触发重登。重登后只 GET，不存储或自动重放接受、改密、邀请、消息、批准、取消/继续等 POST。

账户页分别展示准入状态、本人脱敏联系方式/待验证状态、本人工作区摘要和会话；普通用户不见安装登记 owner 列表/root/管理员诊断。管理员管理页仅有邀请投递状态、脱敏地址、有限账户状态和明确动作，不提供他人业务资料/恢复 token。页面可仅用键盘、粘贴、密码管理器完成，密码不 trim；邮件链接过期可显式重发，不能后台消费 GET。

本机维护从 identity 公共有限候选投影**明确选取普通准入账户**，通过 workspaces 公共校验增加不重叠有限 root；合并保留其他登记的 ID/root/权限和原配置。先核对原配置/文件版本，原子发布合并结果；并发修改报冲突不覆盖。PG、文件发布、配置保存和 reload 分开报告，释放锁/连接再 reload；失败只补未完成步骤，不回滚账户、不改其他 owner、不默认管理员 root 或整卷。无 workspace 永远是合法资源状态，不是开户失败。

## 9. 前向升级与放行证据

P0 只交拟议合同、change 和隔离可行性/外部前置证据。生产代码、依赖、迁移、原安装和配置均不动。迁移编号由 **P1 集成时**结合当时最新序列分配，本提案不预占编号、不写可执行 DDL、不改旧迁移。

P1 必须同批交付：准入/邮箱/邀请/邮件/恢复/会话/停用的 API+正式页面、两处窄名单、共享 DTO、resolver/公共资格、scheduler/通知门、本机多 owner 维护、新迁移及结构核验/扫描规则。迁移先扫描重复 credential、绑定异常、邮箱冲突，不删除/合并旧行；只为绑定管理员补准入，其他旧人留显式维护路径。升级停旧写者，使用原卷/密钥/配置和正式本机生命周期；有新准入/邮箱/凭证事实后只前向修复，不回到不理解新事实的旧写者，失败不重建安装。

放行邀请入口前由集成负责人汇总以下可观察证据，缺项不以合同合并关闭 #112：

| 层级                        | 必须观察而非推断                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 锁定库/PG                | Better Auth 1.7.10 + 隔离真实 PG16；原 ID/auth_email/credential 保留；普通 user 库登录、库密码更新/旧密拒绝、会话撤销；写失败回滚、COMMIT 未确认零 Cookie 发布；明确不能覆盖的正式链路                    |
| PG/HTTP（D3/D6/D8）         | 接受/撤销/重发、邮箱争用、过期/旧代/跨用途、逐写点回滚/提交未知、丢响应无重复开户、重置与旧密码登录两种锁顺序；多进程配额重启保持；匿名统一形状                                                           |
| scheduler/通知（A3/D1/D9）  | 停用先提交零新许可/接收；许可先提交如实在途；独立接收无锁环；旧匹配回执只核对，unknown 不重发，取消/回执原门保持                                                                                          |
| 双用户真实旅程（D6/D8/D10） | 两个隔离浏览器 context；原管理员验证真实邮箱→真实邀请→新用户设密→正式登录→本人改密/找回→单个/全部撤销后旧 Cookie 401；生产 HTTPS Cookie 独立证据                                                          |
| 全资源隔离（D1/D6/D8）      | 双方创建可辨识资料、互换 task/event/approval/conversation/Run/SSE/tool-result/notification/workspace 的 ID、parent、游标和幂等键；管理员同样拒绝；新用户空资源/无 workspace 且不泄漏 root，不虚报模型可用 |
| 旧安装（D7/D8）             | 授权隔离旧安装副本前向升级、失败收尾与两次正式 stop/start；原用户/credential/secret/历史 owner/登记/root identity、会话固定期限保持                                                                       |
| 页面/邮件（D6/D10）         | GET/预览零消费；queued/submitted/failed/unknown 真实区别，日志/URL/持久存储无秘密；401 只 GET 恢复，403/503 不误跳；键盘/粘贴/密码管理器可用                                                              |

外部邮件通道、域名/DNS、受控收件箱、APP_ORIGIN/HTTPS、密钥托管及隐私留存的缺口由 [PRD 待决项](../prd/04-acceptance-open-questions.md) 与 [本轮外部前置取证](../verification/invited-account-external-prerequisites-2026-11-03.md) 集中管理；未确认前不声称真实送达或生产可用。本设计不涉及飞书/第三方登录、不接管 #104/#105/#107/#108，不更改模型路由，不引入公众注册、多组织/RBAC、供应商采购或管理员接管账户。
