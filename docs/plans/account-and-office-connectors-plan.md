# 账户产品化与首个办公只读连接实施规划

> 状态：Proposed；仅规划，不改变现行有效合同，不代表能力已上线。
> 范围：邀请制入驻、真实邮箱与账户恢复、会话管理、多用户隔离、首个飞书 Docx 只读连接，以及文档归类。
> 不包含：业务实现、部署、用户安装或凭据变更、远端 issue/PR、commit/push；不扩展短信、计费、多组织/RBAC、办公写入、自动同步、向量库或连接器市场。
> 阶段：独立后端演进方向；代码观察基线 `3ac1b27`，与 #104 主线通过公共接口协作。

> #112 的后续授权独立于本规划：账户 P0 合同见 [design/21](../design/21-invited-account-access.md) 与 [change](../../openspec/changes/productize-invited-accounts/proposal.md)，P1 正式切片与隔离证据见[实现验证](../verification/invited-account-implementation-2026-11-03.md)。原始规划的非实施范围不撤回后续账户实施授权，也不授权部署或飞书连接；真实邮件/HTTPS放行仍依据[外部前置](../verification/invited-account-external-prerequisites-2026-11-03.md)，不随代码实现自动完成。

## 1. 结论与交付顺序

推荐顺序是：**邀请制账户产品化及真实双用户隔离 → 飞书单文档只读连接**。账户不是先加一个注册表单，连接也不是先放一排供应商图标：本阶段分别要交付“被邀请的人能独立、安全地使用自己的账户”和“本人能授权并读取一份有权访问的办公文档”。

第一业务实施切片推荐为：**原管理员保留原身份，绑定并验证真实恢复邮箱，发出一封邀请；第二人从邮件设置登录凭据，经正式 Cookie 登录，拥有独立空数据面、可管理自己的会话和恢复口令，无本机工作区也不被挡住；双方不能读取或操作对方资源。**这是一条可独立验收的完整用户价值切片，不以表结构、API、空页面或假邮件替代。

邮件供应商、生产来源域名、加密密钥等前置未齐时，可以先完成正式合同评审和隔离实验，但不能把未能真实投递/恢复的版本称为邀请制账户完成。飞书公共资料核对、应用权限准备和只读客户端实验可以与账户工作并行；普通用户正式使用的连接必须建立在真实 owner 隔离之上。

如自用价值优先，也允许先交付“**现有管理员的独立飞书连接**”分支：仍按真实 `ownerId` 建模、授权和隔离，不写 singleton 连接，不使用部署者的办公 token 供所有人共享。这是独立的单用户产品价值，不冒充多用户完成；主推荐顺序不变。

### 断言等级

- **Observed**：本轮静态阅读的代码、测试定义、迁移、有效合同或官方公开资料。
- **Required 目标**：本任务明确要求的结果与保留不变量。
- **Proposed**：以下新增状态、API、表、并发和实施切片建议；正式实施前仍需遵循仓库合同变更流程。
- **Deferred**：明确不做，不能被其他章节暗中依赖。

现状判断来自静态代码、测试定义与公开资料阅读，不是本方案的运行验收。历史验收记录不证明新增的多用户、邮件或飞书授权能力。

## 2. 已有链路及必须改动的真实接缝

### 2.1 身份与认证链

当前请求链是：

`AccountScreen / AccountForm → Web /api proxy → http/app.ts → identity/routes.ts → createAccountService → createAuth / pg-adapter → PG → 库 Set-Cookie → createActorResolver → /me → owner-scoped 业务入口`。

| 观察来源                                                                          | 当前实际行为                                                                                                                            | 对本规划的约束                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/identity/account-service.ts#createAccountService`、`signIn` | 登录除了库口令验证，还要求 `installation_admin.user_id === user.id`，因此已有合法 credential 的非绑定用户仍不能正式登录                 | 多用户不能只新增 users；必须明确移除“管理员才可登录”的产品策略，并建立新用户入驻资格         |
| 同文件 `initialize`、`bind`、`snapshot`、`claim`、`bindLocal`                     | 初始化/转正有真实事务、安装级 advisory lock、历史 owner 公共投影和登记检查；旧人明确选定后才转正                                        | 保留空安装防接管和旧人维护；邀请不得复用初始化或 claim 作为任意开户旁路                      |
| `http/auth.ts#createActorResolver`、`resolveSession`                              | 正式 resolver 核验签名 Cookie、PG HMAC、到期/撤销及用户 active；它没有检查安装管理员绑定                                                | 当前“可解析旧会话”与“可正式密码登录”本就不同，不能把 resolver 改成管理员过滤，破坏旧身份     |
| `identity/better-auth.ts#createAuth`                                              | Better Auth 固定 1.7.10；七天固定会话，禁 refresh/滑动更新和 Cookie cache；库 email 映射 `auth_email`，`requireEmailVerification:false` | 真实联系方式验证另有事实源；不能直接启用库 email 验证并向 `local.invalid` 发信               |
| `identity/crypto.ts#deriveAuthEmail`、`deriveEmailHash`                           | 登录名 trim/lowercase 后 HMAC 派生不透明句柄；已有邮箱 hash helper 也不保存可投递地址                                                   | 原 auth_email 必须保留，不是邮件地址，更不是第三方账号匹配证据；现有简易正则不是正式邮箱策略 |
| `identity/pg-adapter.ts#createPgAdapter`                                          | session token 只存 HMAC；只有本次掌握 raw token 才回传给库；按 ID 读取不返回 HMAC 冒充 raw token                                        | 会话管理列表不走依赖 raw token 的库返回路径；不引入 token 缓存或第二套 Cookie 签发           |
| `identity/account-service.ts#signOut`                                             | 先确认 PG 软撤销提交，再调用库生成清 Cookie；失败/提交未知不假报完整成功                                                                | 撤销单设备/全部设备、改密和恢复沿同一提交边界扩展                                            |
| `identity/routes.ts#handleAccountRoute`、`http/app.ts`                            | 双重精确路由名单，匿名 Origin 防护、签名会话 CSRF、strict JSON、131072 原始 UTF-8 字节上限                                              | 新窄端点必须同步注册两处边界；不能只增加 service 而路由不可达，也不能转发全量库 handler      |

### 2.2 UI、proxy 与安装维护

- `apps/web/src/features/account/AccountScreen.tsx` 目前用“首次管理员、管理员用户名、无公开找回”的文案和状态组织页面；`workspace_state` 来自安装级登记诊断。普通用户不能照搬成“没有管理员工作区就账户未完成”。
- `apps/web/src/features/account/account-operation.ts`、`use-account-operation.ts` 与 `apps/web/src/lib/account-navigation.ts` 负责账户动作和安全重登。继续保持：只有 HTTP 401 才引导登录；403/503 不当作过期；重登只 GET，不重放消息、批准、取消或继续。
- `apps/web/src/app/api/[...path]/route.ts` 保留真实 Origin、多 Set-Cookie、no-store、流式 body 和取消传播；当前响应转发名单**没有 `Location`**。OAuth 回调若需要 303 导航，必须有针对性支持固定站内目的地，不能假设现有 proxy 已能处理，也不能全局放行任意上游重定向。
- `scripts/local/account.mjs#maintainAccount` 现在从 `getBoundAdministrator()` 取得登记 owner；已存在但不属于管理员的登记不会自动修改。`requestRegistration` 生成的登记数组只包含当前管理员。多用户实施必须增加明确的普通账户资源维护路径，而不是把这个默认值继续当作所有人的 owner。
- `workspaces/service.ts#configureWorkspaceRegistry` 已能处理多个条目，并拒绝重复 workspace ID、重复物理根和包含/重叠根；`listWorkspaces(ownerId)`、`getWorkspaceGrant`、`selected` 会验 owner、digest 和 root identity。
- `conversations/service.ts` 只有提供 `workspace_id` 才取 grant；没有 grant 使用 `HARNESS_BASE_TOOL_IDS`。`workspaces/routes.ts` 对无登记的已登录用户可返回空集合。**代码已有“无本机工作区”的合法运行分支；本规划应保留而不是新增全局资料门。**聊天仍取决于实际模型/native/时间等原有依赖，不因新账户成功就虚报模型可用。

### 2.3 Schema、迁移与有效合同

`0001_identity_core.sql` 创建 users、sessions、auth_accounts，限制 credential provider，保护 users 不被物理删除；`0017_identity_account_access.sql` 新增安装管理员 singleton 和 session 标准字段，没有增加多用户入驻、邮件或 OAuth 表。

有效合同见 [design/16](../design/16-r1-account-access.md)、[identity schema](../schema/identity-schema.md)、[auth API](../api/auth/auth_routes.md) 和 [identity 行为规格](../../openspec/specs/identity/spec.md)。其中明确限定唯一管理员登录，不包含邮箱验证/找回/OAuth；schema 明确禁止明文邮箱，并允许确需保存的敏感值先加密。**本规划不是对这些合同的静默替换。**未来须先评审“独立业务账户准入、加密可投递邮箱、恢复与连接”的具体增量，再同步 design/API/schema/PRD/spec。

旧迁移不改，迁移号由正式集成时与 #104 的最新迁移序列共同分配，本规划不写 DDL 或预占序号；配套更新 `scripts/local/baselines/` 的结构核验和迁移扫描规则。

## 3. 目标、不变量与唯一责任

### 3.1 安装管理者不是所有业务资源的 owner

**Proposed：保留 `installation_admin` 绑定作为最小安装管理资格，不建组织或角色权限表。**

- 部署操作者持有本机配置/安装锁，负责升级、密钥、邮件与飞书应用配置、资源登记和故障恢复。这是控制面，不是可由浏览器任意提交的业务 actor。
- 绑定管理员在产品内以本人业务 user 登录，也可经窄管理用例邀请/停用普通账户。它管理安装，不因此获得他人任务、会话、文档或 token 的读取权。
- 普通用户是独立 users.id，所有业务请求的 owner 只来自 resolver/可信公共调用上下文，不来自 body、query、模型或办公资料。
- 不新增 HTTP 管理员重绑、任意代登录、凭空重设他人密码或隐含“管理员全数据可见”。不得停用/注销唯一绑定管理员而造成安装无人维护；本阶段对此明确拒绝并给本机维护说明，管理员交接另议。
- 旧 seed/其他历史 owner 不因迁移获得正式登录资格或被自动激活、合并；有需要时经本机明确选人和原口令/原身份核验，为原 ID 建立准入事实。

### 3.2 责任与拟议模块

| 唯一所有者                   | 本阶段职责                                                                                | 不负责                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| identity                     | 账户准入、用户状态、联系方式验证、邀请/恢复一次凭证、密码库调用、会话与窄管理动作         | 业务表迁归属、办公 token、Run 状态机         |
| identity 内邮件投递边界      | 事务后投递邀请/验证/恢复邮件及真实发送状态；供应商适配保持具体且窄                        | 通用通知平台、营销邮件、承诺最终到达         |
| workspaces                   | 多 owner 有限资源登记、目录资格、digest/root identity、owner-scoped 资源摘要              | 开户、发邮件、用管理员 root 兜底             |
| connectors（拟议新业务模块） | 仅飞书用户授权、加密 token、刷新/断开、指定 Docx 读取与来源快照                           | Along 登录、组织管理、通用 provider 插件平台 |
| tools                        | 如后续接入工具，负责原有稳定调用、参数合同、接受结果与审计；通过 connector 公共用例取事实 | 直接读 connector 私表、持有供应商 secret     |
| conversations/#104           | owner/Run/attempt 资格、可信输入、上下文、冻结生命周期、模型执行与停止                    | 自建 OAuth、发送邮件、直连 connector 存储    |
| Web                          | 真实身份/邮箱/会话/连接状态、用户明确操作、来源与错误展示                                 | 推导权限、自动重放原 POST、保存密码/token    |
| 本机维护                     | 明确选取账户、私有登记原子发布、配置保存、释放锁后重载                                    | 通过 HTTP 写宿主私有 JSON 或开放任意命令     |

代码沿既有目录和公共 service 函数组织；没有第二供应商前不定义 connector 注册中心、工厂、市场目录或通用同步任务引擎。当前依赖没有邮件/OAuth SDK；实施时优先选供应商成熟客户端和标准 OAuth 客户端，先验证 Bun、许可证、响应/错误与 PKCE 兼容，不手写密码算法，也不为一个读取接口引入完整平台。

## 4. 邀请、邮箱、恢复与会话的具体合同

### 4.1 登录标识和可投递邮箱分开

**Proposed：保留现有用户名登录合同与所有原 `auth_email`；新增独立、经验证的联系方式。**新邀请用户仍设置 `login_name/password/display_name`，因此不必迁写库用户 email、不改变原登录 namespace，也不把真实邮箱塞进库原字段。

真实邮箱同时用于邀请和恢复；提供明确的邮箱登录分支，而不是把包含 `@` 的用户名自动解释为邮箱。`POST /auth/sign-in` 可采用 strict 判别联合：`{login_name,password}` 或 `{email,password}`，不得同时提交。用户名分支保持原规范化与 deriveAuthEmail；邮箱分支经 HMAC 查到已验证邮箱所属 user 后，取得其既有不透明 auth_email，再由库验证密码。均须通过同一准入与 active 检查。

邮箱规则由 identity 单一实现，Web 只消费共享合同：去掉外围空白、拒绝控制字符/多地址/显示名格式，域名规范化并 lowercase；首阶段支持常见 ASCII mailbox，local-part lowercase 是显式产品规则，不声称 SMTP 标准要求。不得自行移除 `+tag` 或 Gmail 点号、按域名猜测同一人。国际化 local-part 需要真实投递/库证据再扩大，不悄悄做 Unicode 相似字符合并。

- 保存原可投递地址的**加密值**和规范化地址的**用途分离 HMAC**；普通 SHA-256 不足以保护可枚举邮箱。
- 现有 `primary_email_hash`、`email_verified` 不作为新恢复事实的依据，迁移不猜其语义或批量设 true；新公共联系方式投影显式返回 verified 状态。
- `BETTER_AUTH_SECRET` 保持原值；联系地址查找密钥、一次凭证用途密钥和 AEAD 密钥采用独立 key-id 管理，不把邮箱功能绑定到轮换原认证 secret。
- 加密采用成熟 AEAD 实现，如 AES-256-GCM；每次随机 nonce，AAD 绑定模块、记录 ID、owner/用途和 key version。密钥不进数据库、日志、前端或 Git，运维必须能备份和恢复旧 key；缺 key 明确依赖故障，不重新生成覆盖。
- 对本人仅按需返回脱敏地址；发信时只在投递边界解密。日志不记完整地址、链接 token、密码或库 token。供应商收到明文地址属于必要外部处理，必须有产品告知与批准。

这不是“允许明文邮箱入库”的例外；是对当前“只保存 hash、不具备投递能力”的合同作明确、受审查的加密联系方式增量。

### 4.2 完整入驻旅程

1. 原管理员用现有用户名/密码登录，重新验证密码，申请绑定真实邮箱；验证邮件被明确确认后才成为恢复地址。旧 ID、auth_email、credential、会话寿命和资源 owner 不变。忘记原密码且从未绑定验证邮箱时，不能在线推断恢复权，进入有授权的本机维护，不用新邮箱接管。
2. 管理员经正式 Cookie、Origin、CSRF 和当前密码再验证，创建给指定邮箱的邀请。邀请只授予新账户准入，不是组织席位，也不授予管理员工作区或飞书数据。
3. 同一 PG 事务保存邀请、一次凭证摘要、可恢复的加密邮件载荷和投递记录；提交后才允许投递。响应明确是“已创建/待发送”，不是“对方已收到”。
4. 邮件链接打开一个不自动消费的页面。邮件扫描器、预览和 GET 都不得创建账户、验证地址或消耗凭证。推荐 token 放 URL fragment，客户端只在内存持有并用 POST 发送，立刻清理地址栏；页面 no-store、无第三方脚本、Referrer-Policy 为 no-referrer，token 不进本地持久存储。
5. 用户确认当前邀请对象，设置用户名、密码和展示名。接受请求不含 owner ID；服务端从邀请取邮箱。若浏览器已登录另一 Along 账户，先明确退出/切换，不能静默把邀请挂到当前用户。
6. 接受事务锁定邀请和地址资格，检查到期/撤销/代次，建立新 user、唯一 credential、入驻资格、已验证邮箱，并消费邀请；提交确认后返回“账户已建立”。**接受本身不自动登录**，用户随后用正式 sign-in 建立库 Cookie，避免丢响应时重复签发会话。
7. 接受响应丢失：一次凭证不能再次写入；页面引导正式登录或请求恢复，不重新开户。并发接受最多一套完整用户事实，不留下第二个 user 或 credential。
8. 新用户进入自己的空资源面。没有本机登记时 `workspaces.items=[]`，显示“尚无本机资料，可正常使用账户/已配置聊天，或授权自己的办公连接”。不能强制等待全局 `workspace_binding`，不能默认选管理员 workspace，更不能把账户提交回滚成未开户。

已有验证邮箱对应的账户不通过邀请建立第二个身份，也不凭邮箱把历史 owner 合并。管理界面可显示最少必要的冲突处理；收件人路径给统一可操作说明，要求现有账户正式登录/恢复。旧未准入 owner 的正式启用走本机明确维护，不通过匿名邀请“认领”历史。

### 4.3 一次凭证、撤销、重发与邮件失败

拟议凭证用途仅 `invitation | verify_contact | reset_password`，不得互相兑换。

- token 至少 32 随机字节，库中只存用途分离 HMAC/摘要；记录用途、目标邀请或 user、地址 hash、generation、expires_at、consumed_at、revoked_at 和必要绑定。
- 起步 TTL 建议：邀请 48 小时、地址验证 30 分钟、找回 30 分钟。它们是 Proposed 产品参数，正式合同评审后固定；到期使用数据库时间判定，不靠前端倒计时。
- 接受、重发、撤销以同一邀请/凭证行锁和唯一约束裁决；重发建立新 generation 并撤销旧代，旧邮件即使迟到也不可消费。并发撤销与接受由先取得并提交写权的一方决定，不以请求发起时间判断。
- 创建邀请带管理员范围内 `idempotency_key`；同键同规范化邮箱回同一邀请，同键异参 409。重发是明确动作，有自己的键且不会重复创建 user；撤销重复返回已撤销。凭证消费是一次提交，不允许用幂等键重放新密码写入。
- 邮件任务只由 identity 投递者消费，不复用目前包含 task/schedule 语义的 commitments `outbox`。沿现有 worker 角色扩展一个小型消费者，不新建常驻服务或消息系统。
- 投递状态至少区分 `queued/submitting/submitted/failed/unknown`；`submitted` 仅表示供应商接受，不是进入收件箱。外部发送不在 PG 事务中。
- 投递前锁定/领取记录并核对凭证仍有效；提交发送使用稳定 delivery ID 作为供应商幂等键。明确失败允许用户显式重发；超时或进程中断且无法证明供应商未接受时记 unknown，不盲目自动重投。同一代重复邮件即使发生，也只能有一个有效消费。
- 加密邮件载荷只保留到投递收尾/凭证到期，按明确保留策略清理；原始 token 不进入可读普通 JSON。重启后 queued 仍可投递，遗留 submitting 先核查或标 unknown。
- 匿名找回始终返回统一 `202 {accepted:true}`，不存在、未验证、停用账户均不揭露。依赖本身不可用时准确返回 503，不能伪报已经投递；统一在查账户前检查必要依赖，避免错误形状成为存在性侧信道。
- identity 实施持久化、原子配额：按地址 HMAC、可信来源 IP 摘要及动作限制登录尝试、邀请发送和匿名恢复；多 API 进程共享。阈值在合同评审中明确，拒绝为 429 并给 Retry-After；不得只做浏览器倒计时或无限制发邮件。计数记录不存明文邮箱/IP，过期清理复用投递维护路径，不建立通用限流服务。

### 4.4 密码恢复、改密和会话管理

恢复密码仅发往**已经验证并且仍绑定的地址**，不接受请求体指定新收件地址。持有恢复凭证不能激活 disabled/deleted_requested，也不能修改安装管理员绑定。

- 找回完成在同一事务中核验 user 当前资格、凭证用途/代次/期限，调用锁定库密码 hash，更新唯一 credential，消费本凭证，撤销该用户其他恢复凭证和全部会话。默认不自动登录，完成后正式重登。
- 已登录改密要求当前密码、Origin 和会话 CSRF；成功同样撤销全部会话，包括当前会话，提交确认后清当前 Cookie。这样无需维护“保留当前会话”的例外竞态，也不改七天固定寿命。
- 登录、改密/找回、停用围绕同一用户资格锁序进行。口令验证期间不能让旧密码通过后在重置提交之后又签出有效新会话；实现须在签发事务内锁用户并复核 credential 版本/状态，密码 hash 可在锁外计算，但消费前复验。
- 会话列表仅本人：`session_id/created_at/expires_at/current/设备摘要`，不返回 raw token、token_hash、完整 IP 或任意他人的会话。列表不依赖 adapter 的 raw token，也不通过 GET 更新到期时间。
- 本人可撤销单个会话或全部其他会话；WHERE 同时带 user_id/session_id。重复撤销自己的会话幂等成功；他人 ID 不成功且不泄漏详情。撤销当前会话遵循已提交才清 Cookie 的原合同。
- 联系方式替换也须当前密码及新地址验证；验证成功前旧地址继续有效，切换事务撤销旧地址上的恢复凭证，避免旧邮件在换绑后仍能改密。邮箱编辑不是任意 users patch。
- 无邮件访问、无有效已验证地址且无原口令时，缺少在线恢复的可信证据；不设计“管理员随手设他人口令”。部署者可通过原安装本机入口显式停用账户或修复明确问题，账户接管必须有独立授权证据。

### 4.5 退出、停用、注销和 Run 生命周期分别处理

| 动作                  | 身份与会话                                                 | 业务与运行边界                                                                                          |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 退出当前会话/撤销设备 | 软撤销指定会话，不删除 user                                | 不取消任务、不删除历史、不另起 Run；request-bound 与 server-owned 分别遵守 #104 冻结合同                |
| 找回/改密/全部退出    | 撤销相应全部会话和旧恢复资格                               | 不是“停止所有任务”；server-owned 已接纳委托不因普通会话变化自动撤销                                     |
| 管理员停用普通账户    | `disabled`，撤销其会话与未消费资格；不能在线恢复绕过       | 阻止新动作和新内容披露；已发生事实保留，不改 task owner 或伪造 cancel 回执                              |
| 本人申请注销          | 经当前密码确认后 `deleted_requested`，撤销会话与新动作资格 | 本阶段交付的是停止使用/注销请求，不承诺已物理抹除；users 禁物理删除继续有效，数据清除需另有明确保留规则 |
| 显式停止 Run          | 由 conversations/#104 持有                                 | 不借 identity 再写一份 Run 终结/driver，不把停止等同取消已建提醒                                        |
| 断开飞书              | connector generation 失效、凭据清除                        | 不撤销 Along 会话；不把断开本应用说成已撤销飞书服务端全部授权                                           |

停用/注销须让连接器和工具的新调用立即失去资格；不能只在登录时检查。对既有 scheduler/通知也须明确拦截停用后**尚未获得发送许可的新投递**，由 tasks/notifications 使用 identity 公共资格读取完成，不复制取消状态机。已发送、外部已接受和在途不确定的效果保留真相，不伪报已经追回；未发送的旧任务按原任务窗口/回执规则显示，不把 `disabled` 当 `cancelled`。这项跨模块增量必须有专门合同与验收，不能假设当前 scheduler gate 已检查用户状态。

## 5. 多用户隔离不是 users 表的属性

### 5.1 必须逐项覆盖的资源面

| 资源面                           | 当前可复用依据                                                                                                                                            | 新阶段必须验证                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| tasks、events、notifications     | `tasks/repository.ts#listTasks/getTask`；`tasks/service.ts#getTaskDetail/getTaskEvents` 先验父 task owner 再读事件；`notifications` 公共投影带 owner/task | 列表、详情、事件、通知、取消、旧深链、分页和相同幂等键均不跨用户；不能只测列表                                        |
| approvals、文档批准、后继修订    | `approvals/confirm.ts`、`decision.ts`、`document-repository.ts` 校验 owner；修订/决议键带 owner                                                           | 另一用户不能确认、拒绝、修改、继续或消耗批准；管理员同样无越权例外                                                    |
| conversations、messages、history | `history-service.ts#requireHistoryConversation/cursorOf` 绑定 owner/parent；repository 查询带父归属                                                       | 从真实第二账户发现的集合为空；猜 ID、换 parent、复用游标不泄漏原话、标题或来源                                        |
| Run、attempt、SSE、checkpoint    | `conversations/repository.ts#lockRun`、`harness-authority.ts#getRunView`、`tool-binding.ts`                                                               | GET/cancel/resume、事件补读、签名 HTTP/native 消费均绑定 owner/Run/attempt；不同路由既有 403/404 语义保留，不强行统一 |
| 工具调用、接受结果、上下文来源   | `tools/invocations.ts#reserveInvocation/gate`；`tools/query.ts#readRunContextObservations` 会重新核验披露资格                                             | 稳定调用键、来源引用、重放、上下文分页、跨 Run 引用与撤权后结果返回都不能换 owner；旧接受事实不覆写                   |
| workspaces/本机登记              | `listWorkspaces/getWorkspaceGrant/selected`、root 重叠检查                                                                                                | 新人空集合；管理员不能经维护默认值把他人登记改给自己；显式新增登记合并保留其他条目和原字节事实                        |
| 邮箱/邀请/恢复/会话              | 新 identity 合同                                                                                                                                          | 本人数据与窄管理元数据分离；邮箱相同不合并历史；管理员不可读取他人的恢复 token/password/session                       |
| 飞书连接与文档快照               | 新 connector 合同                                                                                                                                         | 列表、OAuth callback、refresh、读取、快照、断开、重连及未来工具引用全部绑定 owner 和连接 generation                   |

业务跨模块 owner 主要是逻辑引用，没有全库 FK 或现成 RLS 为其兜底。不能用“数据库有 users”或 D1 静态依赖检查证明隔离完整。

### 5.2 新用户的资源与本机维护

公开账户投影分开表达：`account_status`、本人邮箱状态、本人 workspace 数量/可用摘要、本人连接状态。安装登记 invalid/unreadable 仅管理员/部署者能看最小运维诊断；普通用户不能看到全部登记 ownerIds、root 或因别人的无效登记被误判为尚未开户。

本机维护继续使用原配置、原卷和安装锁：

1. 通过 identity 公共候选投影列出可维护账户的有限摘要，由部署者明确选择和确认；不默选唯一管理员、不要求复制 user ID。
2. 通过 workspaces 公共校验构造新增的有限登记；维护目标是选定用户，不是操作者的业务 user。每人独立、不重叠的 root，权限只来自显式准备的有限路径。
3. 检查原文件/配置版本，原子发布合并结果，保留其他用户条目、workspace ID、物理根和权限；发现并发修改时明确冲突，不能覆盖丢失。绝不把整个共享卷当新人可读根。
4. 文件发布、配置保存、API reload 分别记录；释放原锁和数据库连接后才重载，失败只补未完成步骤。API 不写宿主文件，不自动运行 Agent。

普通用户不需要本机工作区才能完成入驻、恢复口令、管理会话或读自己的飞书文档。是否为其准备本机资料是独立资源维护选择，不是登录成功的附带条件。

## 6. 首个办公连接：用户指定的一份飞书新版文档

### 6.1 选择与最小承诺

推荐飞书为首候选，因为公开 API 能明确区分用户/应用身份，并提供新版 Docx 元数据和纯文本读取。**Along 登录身份不等于办公数据授权。**产品内 Along user、飞书 tenant_key/open_id、飞书应用 app_id 和部署操作者是四个不同事实。

首切片固定为：用户在连接页授权自己的飞书账号，核对外部账号摘要，提供一个云空间 `/docx/<document_id>` 链接，系统读取标题和纯文本，展示来源、读取时间、完整性和明确错误。可多次显式读取不同单文档，但不扫描账号全库。

明确不支持旧 `/docs/`、Wiki 节点、Sheets、Base、附件、图片 OCR、评论、全库搜索、目录递归、定时同步和写入。遇到这些入口给具体“不支持的资料类型”，不把它们当空文档，也不靠抓取网页或租户 token 兜底。Wiki token 不等于 document_id，这是官方文档明确指出的限制，不可直接互换。

`raw_content` 的产品能力是**纯文本**而非完整渲染；嵌入文件、表格/图形等的完整覆盖须由真实样本确认。UI 明示“只读取纯文本，不读取嵌入资源”，不能宣称所有内容均已理解。上游返回过大/格式不支持时拒绝或明确部分结果，不静默截断后标完整。

### 6.2 官方公共资料核对结果

以下均为公开文档观察，不是本机账号实验：

| 官方资料                                                                                                                                        | 已确认的关键约束                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [平台索引与身份说明](https://open.feishu.cn/llms.txt)                                                                                           | 自建应用仅本企业发布使用，商店应用涉及跨租户安装；用户 token 与 tenant token 访问边界不同；应用 scope/可用范围/数据权限分别存在                                                                           |
| [获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code.md)                                       | 授权入口 `https://accounts.feishu.cn/open-apis/authen/v1/authorize`；code 五分钟、一次使用；redirect_uri 须在后台配置；scope 空格分隔；支持 state 和 PKCE S256；refresh 需 offline_access；历史授权可累积 |
| [获取用户 token，v3](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)     | `POST https://accounts.feishu.cn/oauth/v3/token`；推荐 form-urlencoded；平台创建的应用属于 confidential client，须 client_secret；支持 PKCE；按实际 expires_in/scope 保存，不能硬编码寿命                 |
| [刷新用户 token，v3](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3) | refresh_token 单次使用，成功后旧 refresh 立即失效，旧 access 可持续到自身到期；须保存新 refresh；offline_access 和后台刷新设置/发布有前置；文档说明授权满 365 天需重授权                                  |
| [获取用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get.md)                             | user token 可获取 app 内 open_id 和 tenant_key；敏感字段需额外 scope；邮箱/手机号由企业导入，并非实时验证，不宜直接用于业务登录                                                                           |
| [Docx 元数据](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/get.md)                                                    | `GET /open-apis/docx/v1/documents/:document_id` 返回 title/revision_id；只读 scope 为 `docx:document:readonly`；需要实际文档权限；文档记录应用级 5 次/秒限制及非零错误                                    |
| [Docx 纯文本](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content.md)                                            | `GET /open-apis/docx/v1/documents/:document_id/raw_content`，同只读 scope，支持 user token；可能 forbidden、deleted、raw content 过大、限频或维护                                                         |
| [云文档权限 FAQ](https://open.feishu.cn/document/server-docs/docs/faq.md)                                                                       | 应用 API scope 不等于某份文档的可读权限；用户/应用协作者资格分别控制；Wiki 需先解析 obj_token，本切片不包含                                                                                               |
| [撤销用户授权事件](https://open.feishu.cn/document/authentication-management/auth-v4/revoked.md)                                                | 存在 `auth.user_access_token.revoked_v4`，订阅需额外 `auth:user_access_token:read` 和事件配置；不能假设不订阅也会实时收到撤权                                                                             |

旧 [获取 token 文档](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token.md) 和 [刷新文档](https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token.md) 已标记 v2 历史版本并引向 v3。实施不得从旧 SDK 示例照抄 v2 endpoint。公共资料也不能证明当前应用已获这些权限或所有租户都可用。

推荐首个可用租户的企业自建应用；跨企业用户不能默认使用同一自建应用。若首批邀请对象必须跨租户，应先解决应用类型/可用范围前置，不能用扩大 Along 账户模型为组织/RBAC 来掩盖上游应用限制。

### 6.3 OAuth 绑定、scope 与错绑防护

1. 已登录且 active 的 Along 用户以 Origin+CSRF 发起授权；不接受 body 中 owner、任意 callbackURL、任意 scope 或 tenant token。
2. 服务端生成随机 state、PKCE verifier/challenge，保存短期授权尝试：owner、发起 session ID、固定 redirect URI、应用配置标识、允许 scope、期限、预期重连主体及状态。state 仅存摘要；需要跨请求恢复的 verifier/临时 token 加密。
3. 请求 scope 最小为 `docx:document:readonly offline_access`；用户身份确认调用官方 user_info，不额外索要手机号、邮箱或员工 ID。如果真实应用需要额外基本身份 scope，先在隔离实验确定并审查，不能默认申请通讯录全量权限。
4. callback 是外部跨站 GET，不能机械套同 Origin POST 检查；必须核验 state、发起会话仍有效且当前 actor 相同、到期/消费状态、精确 redirect URI 和 PKCE。无会话、会话被撤销、用户切号或 state 不匹配都停止，不把回调转成 Along 登录。
5. 同一尝试只允许一个 callback 取得交换资格；交换和 user_info 网络请求在短事务之外执行。code 交换超时/结果丢失不盲目重复使用一次 code，标记需重新授权；重复 callback 只能读同一安全结果或明确失败，不新建另一连接。
6. 交换时显式请求允许的 scope 子集并核对实际返回 scope，防止历史累计授权被误当本产品授权范围。即使上游 token 包含更广权限，代码出口仍只允许文档 GET，不把 token 下发模型或浏览器。
7. 获取 tenant_key/open_id/app_id 后，以受保护页面展示“即将连接的账号/企业”摘要，由原 Along actor 明确确认；确认前不读任何文档。已有连接重连必须匹配原主体，否则报外部账号不匹配，用户需显式断开再重新连接，不能静默换企业或换人。
8. 同一个 app/tenant/open_id 默认只绑定一个 Along owner；遇到另一个账户已占用给不泄漏其身份的冲突。解除后才允许明确重绑；重连绝不迁移旧读取历史。不得使用同邮箱、姓名或头像作为绑定凭据。

首切片一个 Along 用户最多一个当前飞书连接，避免过早设计多账号挑选；断开保留历史连接记录，新连接是新代次，不复活旧资格。

### 6.4 凭据、刷新和断开竞态

连接状态建议为 `active/reauthorization_required/disconnected`；未确认授权由独立短期 attempt 表达。上游不可达、限频和最后一次失败是健康事实，不等于授权已撤销；UI 可显示“已连接，暂时不可读取”，不能显示假断开或假空资料。

- access/refresh 均 AEAD 加密，记录实际过期时刻、允许/实际 scope、credential revision、authorization generation 与 key-id。app secret 是部署级私有凭据，不保存在每个用户的可见配置中。
- 多进程 refresh 由数据库裁决，不只靠进程内 mutex。短事务预留 `refresh_in_progress` 和 credential revision，提交后在有界请求中刷新，再 CAS 保存新一对 token；等待者只读取新版本或返回明确忙碌，不同时消耗旧 refresh。
- refresh 在发送前已经持久化“可能被消费”，进程崩溃或响应丢失时旧 refresh 不盲重用，明确进入需重授权。一次读操作可以在确认 token 过期且刷新成功后做一次有界续读，不能无限 refresh/重试掩盖故障。
- 断开是同 owner 事务：递增 authorization generation，标 disconnected，清除可用 token 和未确认 attempt。refresh 结果 CAS 必须匹配原 generation，不能让迟到响应复活断开的连接。
- 文档读出发前核验 active owner/连接/generation，返回、保存和披露前再次核验。断开提交后，尚未披露的响应丢弃；HTTP abort 只是节约 IO，不能承诺撤回已到飞书或已到浏览器的请求/字节。
- 未订阅撤权事件时，只能在下次读取/刷新得到失效或权限错误时发现上游撤权，不能宣称秒级撤权。文档权限丢失只影响对应文档，不必把整个连接标坏；无效/撤销 refresh 则需重授权。
- 本地“断开”保证 Along 不再使用该凭据，不保证飞书服务端所有历史 token 已撤销。当前未确认可用的全量主动撤权 API，不发明 endpoint；页面提供飞书授权管理中的人工撤权说明。若未来要事件级实时撤权，另审额外 scope、验签、去重与延迟边界。

### 6.5 单文档读取、快照与内容保留

`readOfficeDocument` 是一个具体公共用例：输入为可信 actor、connection ID、用户提供的链接及有界取消信号，输出为文档读取 DTO 或明确类型错误。

- URL 只在本地解析允许的 HTTPS 飞书 host 和 `/docx/` 路径；拒绝用户名密码、非标准端口、IP/本机地址、非允许域和不支持类型。绝不对用户 URL 自由 fetch 或跟随任意 redirect；提取 ID 后只访问固定官方 API，因此没有“用户链接变任意网络代理”的旁路。
- 读取元数据、纯文本，再核对元数据版本；版本已变则本次明确冲突，用户可重新读取，不把不同版本的标题与正文拼成一致快照。这个检查不是上游原子快照保证；真实实验须确认 revision 与 raw_content 可观察关系，不能宣称 API 提供了它没有提供的版本绑定。
- 设响应字节、超时和全应用频控上限；以序列化后 DTO/现有快照预算为依据。现有 tools 接受结果有 240000 字节安全界，context_slice 有 16384 字节界；不能把大文档直接塞入全量 accepted_result 或绕过预算。具体产品上限由样本文档实验确定并写入合同。
- 显式读取可保存最小 immutable 读取快照，正文加密，带 owner、connection/generation、document_id、标题、原始来源 URL、读取时间、内容 hash、前后版本和完整性标记。正文不进入日志；无自动索引、自动同步或本机文件写入。
- 页面必须显示“某时刻读取的副本，不保证源文档当前仍一致”。`source_ref` 是归属和来源引用，不是批准、委托或文档内容指令的授权证据。
- 断开/撤权后保留最小历史元数据和既有完成事实，停止新源读取，旧正文快照不再被新的模型输入或普通正文读取接口披露；未来引用必须重新通过当前 owner/连接资格，不能从接受结果重放旁路读出。故障/限频不自动删除事实，也不以旧缓存冒充最新读取。
- 已经交付到本人聊天中的文字/摘要仍是本人的历史，不能承诺断开能追回已交付文本或模型已处理内容。本阶段不自动删除会话/用户文件；若将来提供“删除已导入内容”，须单独列出原文、引用、派生摘要和备份的处理范围，不能把普通断开写成全链路抹除。

该策略需要在首次授权/读取时告知用户“将读取什么、是否保留副本、是否会提交给已配置模型”。首个 UI 读取闭环不自动调用模型；用户明确把资料用于对话才进入原 conversations 授权边界。

## 7. Proposed API、DTO 与存储/事务边界

### 7.1 窄 API 草案

以下是供正式合同评审的候选，不是当前可调用端点；沿用 `/api/v1`、envelope/request_id、strict JSON、no-store 和原始 body 上限。除明确匿名接口/OAuth callback 外，写入均需真实 Cookie、Origin 和 session-bound CSRF；敏感动作还需当前密码再验证。GET 不发送邮件、不消费凭证、不刷新上游 token。

| 入口                                                                                        | 输入/输出要点                                                                                  | 权限与一致性                                                                     |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /account`                                                                              | `{status,contact:{masked,verified}                                                             | null,is_installation_admin,workspace:{count},...}`                               | 仅本人；安装诊断单独管理投影；不将 workspace 状态当登录资格 |
| `POST /account/contact/requests`                                                            | `{email,current_password}` → `{accepted:true}`                                                 | 本人；建立验证凭证与投递事实                                                     |
| `POST /auth/contact-verifications/consume`                                                  | `{token}` → `{verified:true}`                                                                  | 凭证+Origin；绑定原申请用户/地址，替换需匹配原再验证事实                         |
| `POST /admin/invitations`                                                                   | `{email,idempotency_key,current_password}` → `{invitation_id,state,delivery_state,expires_at}` | 当前绑定管理员；没有任意 owner 参数                                              |
| `GET /admin/invitations`                                                                    | 有界列表、最小脱敏元数据                                                                       | 仅管理资格，不含 token/密码                                                      |
| `POST /admin/invitations/:id/actions/resend                                                 | revoke`                                                                                        | resend 带独立幂等键与当前密码；revoke 可重复                                     | 锁同一邀请，代次失效与投递记录原子提交                      |
| `POST /auth/invitations/inspect`                                                            | `{token}` → 最小有效状态/脱敏目的地址                                                          | 不消费、不发信、限流；不是 GET URL token 旁路                                    |
| `POST /auth/invitations/accept`                                                             | `{token,login_name,password,display_name}` → `{account_created:true}`                          | Origin+凭证；开户/验证/准入/消费同事务；随后正式登录                             |
| `POST /auth/sign-in`                                                                        | 原用户名分支或显式邮箱分支 → 原 authenticated DTO                                              | 同一库验证与 Cookie；匿名失败不可区分                                            |
| `POST /auth/password-reset/requests`                                                        | `{email}` → 统一 `{accepted:true}`                                                             | 匿名 Origin+限流；只发已验证地址                                                 |
| `POST /auth/password-reset/consume`                                                         | `{token,new_password}` → `{password_changed:true,reauthentication_required:true}`              | 凭证用途/代次/期限；改密/消费/全会话撤销原子                                     |
| `POST /account/password`                                                                    | `{current_password,new_password}`                                                              | 本人再验证；全会话撤销，提交确认后清当前 Cookie                                  |
| `GET /account/sessions`                                                                     | 本人有界会话 DTO                                                                               | 不返 raw token/hash，不滑动续期                                                  |
| `POST /account/sessions/:id/actions/revoke`、`POST /account/sessions/actions/revoke-others` | 最小确认输入，返回撤销事实                                                                     | 不接受目标 user；行级 owner 限定、软撤销                                         |
| `POST /admin/accounts/:id/actions/disable`                                                  | `{current_password,confirmed:true}`                                                            | 窄停用普通账户；目标 ID 仅此管理用例可指定，不授予业务访问                       |
| `POST /account/deletion-request`                                                            | `{current_password,confirmed:true}`                                                            | 本人注销请求；不物理删除/宣称抹除                                                |
| `GET /connections`                                                                          | 本人飞书连接摘要及最后已知健康                                                                 | 不触网验证、不刷新、不返回 token                                                 |
| `POST /connections/feishu/authorization-attempts`                                           | `{return_to?}` → `{authorization_url,expires_at}`                                              | return_to 只允许安全站内目的地；scope/redirect 固定服务端生成                    |
| `GET /connections/feishu/oauth/callback`                                                    | code/state 或拒绝信息                                                                          | 唯一跨站回调例外；state+session+PKCE；303 到固定确认页，绝不发 Along 登录 Cookie |
| `POST /connections/feishu/authorization-attempts/:id/actions/confirm`                       | `{confirmed:true}` → connection summary                                                        | 原发起 actor/session，外部主体确认后才激活                                       |
| `POST /connections/:id/documents/read`                                                      | `{document_url}` → DocumentRead                                                                | 本人；可能按需 refresh；显式读取，不由状态 GET 触发                              |
| `GET /connections/:id/document-reads/:read_id`                                              | 历史读取 DTO/元数据，正文披露需当前资格                                                        | 不触发重读或刷新；断开后仅安全元数据                                             |
| `POST /connections/:id/actions/disconnect`                                                  | `{confirmed:true}` → `{disconnected:true}`                                                     | 同 owner 幂等，generation fence，清可用凭据                                      |

示意 DTO：

```ts
// Proposed；只展示公共字段，不是新增代码。
type OfficeConnection = {
  connection_id: string;
  provider: 'feishu';
  status: 'active' | 'reauthorization_required' | 'disconnected';
  external_account: { display_name: string; tenant_label: string | null };
  granted_scopes: string[];
  last_checked_at: string | null;
  last_error: { reason: string; retryable: boolean } | null;
};
type DocumentRead = {
  read_id: string;
  connection_id: string;
  source: { type: 'feishu_docx'; url: string; title: string };
  fetched_at: string;
  revision: { before: number; after: number };
  content_hash: string;
  representation: 'plain_text';
  completeness: 'complete_plain_text';
  content: string;
};
```

不返回宿主 root、token、app secret、邮箱完整值、数据库行对象或模型自报 owner。超限/权限/版本变化不制造假的 DocumentRead 成功结果；若未来支持部分文本，应独立演进判别联合，不能在上述 complete shape 下偷截断。

### 7.2 拟议数据归属、唯一约束与索引

表名是 Proposed，用途比最终拼写重要；不另建组织、目标或通用 provider 表。

| 所有者/记录               | 最小事实与约束                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity：账户准入记录    | user_id 唯一，来源为原绑定管理员/已消费邀请/明确本机启用；迁移只为原绑定管理员补准入，不为所有 active users 自动开放登录                                                                                                                      |
| identity：已验证联系方式  | user_id 唯一、规范化邮箱 HMAC 唯一；加密地址、验证时间、key-id、地址 revision。只把成功验证地址放进此表，候选地址在短期 challenge 中，避免未验证地址长期占位                                                                                  |
| identity：邀请            | ID、发起管理员、地址 HMAC/加密值、state、generation、到期/接受/撤销事实、accepted_user_id；创建幂等键按发起管理员唯一；同地址最多一个 pending 邀请，事务中先收尾过期状态，不能在 partial unique 条件中依赖 now()                              |
| identity：一次凭证        | token_digest 唯一；purpose、邀请/user 引用、地址 hash/revision、generation、expires/consumed/revoked；索引支持当前用途/目标及过期维护；邀请消费和账户建立同事务                                                                               |
| identity：邮件投递记录    | delivery_id 唯一、凭证引用/代次、状态、加密载荷、供应商接受标识、尝试和结果时间；一个 delivery 的幂等身份稳定；索引支持 queued 和收尾，不记录 token 明文                                                                                      |
| identity：动作限流记录    | action+subject_digest+time_bucket 唯一，原子计数/到期；只涵盖本阶段认证和发信，不建设独立通用平台                                                                                                                                             |
| 原 sessions/auth_accounts | 保持原约束与软撤销；正式 credential 每 user 仅一条的业务不变量须通过冲突扫描后新增约束/维护门，发现旧重复即停止，不自动删旧行；用户级会话与活跃范围索引沿用/按实际查询补充                                                                    |
| connectors：飞书连接      | owner、app 配置标识、tenant_key、open_id、状态、authorization generation、credential revision、加密 token/实际到期/scope/key-id；每 owner 最多一个未断开的飞书连接；同 app/tenant/open_id 最多一个未断开的绑定；owner+created/id 支持安全分页 |
| connectors：授权尝试      | state_digest 唯一、owner/session、固定 redirect、PKCE 加密值、期限、状态、预期外部主体、临时候选凭据；同一次 callback 只有一个交换者，确认后失效                                                                                              |
| connectors：文档读取快照  | read_id、owner、connection/generation、document_id、读取时间、前后 revision、hash/完整性、加密正文；owner/connection/read 查询与索引，immutable 已接受事实；不跨 owner 合并正文记录                                                           |

地址验证与邀请接受涉及同一地址时，使用规范化地址 hash 对应的数据库事务互斥/最终唯一约束，避免不同请求绕过“邮箱未被占用”的先查再写。现有 primary_email_hash 不自动当作已验证唯一事实，冲突须显式处理。

### 7.3 事务、锁和错误语义

- 保留现有安装初始化互斥，仅用于安装级初始化/转正。普通用户登录、会话管理和邀请不应全部串行在 `pg_advisory_xact_lock(680068,1)` 上；以用户/邀请/地址为实际争用范围。
- identity 新写用例统一锁序：地址互斥（需要时）→ user（已有用户）→ 邀请/凭证 → credential/session/投递记录。接受新邀请没有旧 user 时，在已锁邀请下创建新 user。邀请的终结用例不反向取得另一个用户锁。
- 业务模块保持既有 attempt→Run 锁序；若需要当前用户资格锁，由公共 identity 用例在后续取得，identity 停用绝不再反向锁 Run/task。正式设计须核对所有新调用，不能为了邮箱方案重排 #104 的执行锁。
- PG 内可原子完成身份写入；邮件、OAuth、文档读取、文件发布、API reload 都不在该原子性声明中。外部调用前后用短事务和 generation/CAS 连接真实事实，不持用户写锁等待网络。
- 用户状态读取失败返回依赖错误，不能当 active；邮箱 key/供应商配置不可用不伪报恢复邮件已发送；读取失败不返回空成功。
- HTTP 错误复用既有错误体系：400 VALIDATION_ERROR；401 UNAUTHENTICATED 仅 Along 会话/登录失败；403 FORBIDDEN/原 CSRF；404 NOT_FOUND；409 STATE_CONFLICT 搭配用途明确 reason；413 原 body 上限；429 配额/上游限频；503 NOT_READY 依赖不可用。新增业务 reason 在 contracts/API 同步，不抛裸供应商响应。
- 飞书 token 失效必须映射为“办公连接需重授权”的 409/类型化失败，**不能返回让全站登录跳转的 HTTP 401**；上游文档拒绝为准确权限/不可读错误，网络失败保留可重试信息和 request_id，不能泄漏 token/完整错误体。
- 状态型 GET 不修复配置、不自动重发、不执行 source refresh。POST 丢响应时，先读已保存事实；不能以全局自动重试重放开户、改密或 OAuth 单次凭证。

## 8. 与 #104/design20 的接口及并行边界

[design/20](../design/20-goal-scoped-delegation.md) 和 [#104](https://github.com/BqLee-AI/Along-agent/issues/104) 持有本人委托、可信上下文、直接提醒、资料效果、GoalResult、request-bound/server-owned 和停止/失联收尾。本规划不重复这些内容；[主线规划](agent-capability-refactor-plan.md) 为移动后的实施规划引用。

可供其消费的边界仅为：

- identity：既有 `isActiveOwner` 与本人偏好等公共用例，新增账户/准入/会话公共投影；#104 不直读新邮件/准入私表，不由本分支重做 timezone 保存。
- workspaces：本人资源集合与原 grant 验证；多用户维护只是让登记的 owner 来源正确，不另建资源执行平台。
- connectors：`listOfficeConnections(actor)`、`readOfficeDocument(actor, connectionId, url, signal)` 和按本人/连接 generation 核验的读取快照投影。调用方不能传替代 owner、tenant token 或 secret。
- tools 如需消费连接读取，按现有稳定调用/接受结果和上下文来源机制集成，保存引用而不是无界正文复制；当前资格在发起、接受和再次披露时都检查。正文仅是资料，不能向模型伪装为可信 system 指令。

首个飞书切片先交付正式 Web 连接页与文档读取，**不依赖 #104 后台执行完成**，也不偷偷把新工具塞进旧 Run allowlist。将资料用于 Harness 的接缝由 #104 集成负责人统一选用已交付的协议/输入版本，并验证新的只读来源投影；本分支不固定 `harness/v6` 以外的下一协议号，不修改 GoalResult 或 run-driver。

可以并行：公开资料/权限实验、邮件供应商适配、飞书固定读取客户端、owner 数据模型评审。必须串行：新用户正式入口开放前的隔离验收；连接激活前的 owner/session 绑定；工具进入真实 profile 前的共享合同/native/Web 集成。

`packages/contracts`、`tools/gateway.ts`、`conversations/harness-authority.ts`、Web 对话 controller 的同一文件由一位集成负责人协调，不能两个方向各建第二套合同或直接覆盖主线变更。

## 9. 分阶段实施与独立验收

### 阶段 P0：正式合同与真实外部能力门

交付：评审并落定本规划的邮箱存储/准入/恢复/停用/连接边界；实施前按 CONTRIBUTING 准备独立行为合同增量，本轮不创建 OpenSpec change 或议题。

最小实验只在明确授权的隔离环境进行：锁定 Better Auth 下新增用户/改密/撤销/Cookie 事务；测试邮件实际送达和失败/超时；飞书 v3+PKCE、user_info、最小 scope、Docx 元数据/纯文本、refresh 轮换及源权限拒绝。外部未知先实验，不能把实验代码留成生产替身。

验收责任：identity/connector 各负责人保存实际版本、操作、观察和限制；产品/部署者提供供应商与测试租户前置。没有真实前置时记录阻塞，不伪造 Green。

### 阶段 P1：一封邀请到第二用户独立使用（推荐首个业务切片）

同批交付：

1. 原管理员真实联系方式申请/验证、找回、本人改密和会话管理；保持原 ID/credential/七天会话。
2. 管理员创建/查看/重发/撤销邀请，真实邮件投递；收件人接受、设置库 credential、正式登录与恢复。
3. 新准入代替管理员登录白名单，保留匿名初始化防接管；旧其他 owner 不自动开放登录。
4. 普通用户独立空资源面、无 workspace 的可用路径；安装管理诊断不再冒充其工作区状态。
5. 必要停用/注销请求门、当前用户资格检查，以及本机明确选取普通账户添加独立有限登记。
6. 所有旧/新入口和同 owner/跨 owner 错误语义共同更新，不能只通过后端 API 或临时 UI 证明完成。

自动化验收：真实 PG 的并发接受/撤销/重发、唯一邮箱竞争、各写点失败/提交未知、旧密码登录与找回并发、旧链接失效、不同用途 token 互拒、匿名枚举一致性、持久限流、全部会话撤销后旧 Cookie 拒绝。

真实用户验收：两个隔离浏览器 context，通过真实邮件、正式 Web/proxy/API/PG 完成邀请和独立登录。双方建立可辨识的任务/会话/批准测试资料，互换所有关键 ID/游标/幂等键访问；管理员也必须被拒绝。验证会话撤销、恢复邮件、七天固定寿命、键盘/粘贴/密码管理器属性、重新登录仅 GET。生产域 HTTPS Cookie 另验，不以 localhost Cookie 替代。

责任：identity 负责人负责库/PG/邮件与并发，Web 负责人负责真实页面/Cookie/错误/零重放，workspaces 负责人负责多 owner 本机登记，集成负责人负责完整矩阵和旧安装演练。**P1 没有真实双用户、真实邮件与旧安装无损升级证据，不得放行邀请入口；旧安装演练采用下文统一清单，不能推迟到主线消费阶段。**

### 阶段 P2：本人飞书连接与一份真实 Docx 可读

交付：真实 OAuth 开始/回调/外部主体确认、加密凭据、刷新串行、状态/断开、链接输入、标题/纯文本读取、来源快照和错误页面。没有本机 workspace 的第二用户也可独立授权和读取。

自动化验收：state 伪造/过期/重放、错误 session/切号、PKCE 错误、同外部主体双 owner 竞争、重连错绑、scope 不足、refresh 并发/崩溃/响应丢失、断开赢过迟到 refresh 和文档读取、URL 绕过/非支持类型/上游限流/网络失败/过大正文/版本变化。并发屏障设置在真实取得锁后，不能用“先调用”替代写权证据。

真实验收：经授权的测试飞书应用和至少两个测试用户，完成 v3 flow、读取有权限文档；另一用户不可读文档准确失败；在飞书撤销应用授权或文档分享后观察下一次读取/刷新如何失败；断网、上游不可达与本地断开过程中不泄漏晚到正文。实际浏览器经过正式 proxy 验证 303/Location、SameSite=Lax 回调 Cookie 和 state/session 绑定。

责任：connector 负责人持有 token/refresh/读取/故障事实；Web 负责人持有授权确认和错误恢复；租户管理员负责应用授权/可用范围前置，不由开发者擅自扩权。未实测的租户/文档类型明示不在支持范围。

P2 以多用户正式账户与**真实文档读取能力**完成本方向的最小产品目标，不用 fake token、假正文、只保存授权状态或空连接卡片交付。

### 阶段 P3：主线消费与整体发布演练

当 #104 有真实资料消费需求且协议版本明确时，由其集成负责人消费上述公共只读接口。验证 owner/source refs、正文预算、撤权后不新披露、资料注入无扩权、旧 Run 不获得新连接资格；只读连接不依赖或冒充 server-owned 已交付。

下列旧安装发布清单适用于每个业务切片：P1 开放账户入口前即须完成相应项，P2 再补连接状态；P3 只补主线集成新增风险，不重复已有有效验证。各阶段在隔离的旧安装副本中演练：

- 含原绑定管理员、其他旧 owner、原 credential/会话、任务/批准/Run 和本机登记的旧状态升级；新增准入只绑定明确对象，原 ID、历史归属和原登记/root identity 保留。
- 配套前向迁移与结构核验、停旧写者、版本门和原配置；失败保持可解释状态，不自动另建安装或换认证 secret。
- 两次正式 stop/start 后账户、会话寿命、原卷、原密钥与资源资格不变；邮件 queued/unknown 和 OAuth 中间态按合同恢复，不自动执行业务 POST。
- 产生新事实后不回退到不理解准入、邮箱或 token 状态的旧写者。关闭新入站、保留事实、前向修复；升级前备份与恢复须考虑业务新增数据，不能承诺无损 down migration。

责任：集成负责人统一安排最终适用检查。实施阶段按 `CONTRIBUTING` 运行实际存在的 `bun run verify`、`bun run test:integration`、`bun run test:contracts` 和触及调度时的 `bun run test:scheduler`，保留五门；不把本地静态检查、受控上游实验或历史 CI 扩大为真实产品验收。

## 10. 影响文件、证据与文档整理

### 10.1 预计影响范围（均为未来实施，不是本轮改动）

- identity：`apps/api/src/modules/identity/account-service.ts`、`routes.ts`、`better-auth.ts`、`pg-adapter.ts`、`crypto.ts`、`preferences.ts`；按所有权增加必要的邀请/联系方式/恢复/投递实现，不创建空 service/repository 壳。
- HTTP：`apps/api/src/http/app.ts`、`auth.ts`；维护窄名单、资格错误和新 body/CSRF 入口。
- Web：账户 feature、`account-navigation.ts`、`api.ts`、正式 proxy，以及必要的邀请/找回/会话/连接页。沿现有 server/client/controller/data 边界，不顺带重做全站。
- workspaces/local：`workspaces/service.ts`、`routes.ts`、`scripts/local/account.mjs` 和相应配置发布边界；不动用户原配置或环境文件。
- 连接：拟议 `apps/api/src/modules/connectors/` 内的具体飞书实现与公共 service；Worker 只增加 identity 邮件消费者，不引入全量同步 worker。
- 共享合同：`packages/contracts/src/auth.ts`、导出入口、必要的新账户/连接 DTO；同步 Web/API，模型工具接入另由 #104 协调。
- 数据与发布：仅新增未来迁移、`scripts/local/baselines/` 核验和适用迁移扫描；不修改已有 0001–0020 迁移，不在规划中固定下一编号。
- 规范：正式实施前增量修订 identity 行为规格与 design/API/schema/PRD；新增 connector 合同按实际范围归类，本轮只写规划和机械移动链接。

### 10.2 当前可复用的测试证据（仅静态阅读，不称本轮通过）

- `apps/api/test/integration/identity-account.test.ts`：初始化并发和逐表失败回滚、COMMIT 失败/确认丢失、原双 owner/历史保留、正式库 Cookie/HMAC、统一登录失败、退出撤销故障、过期重登、Origin/CSRF/未知库路由与有限上传。原“非绑定用户登录失败”是旧合同，应保留未准入负例并增加受邀准入正例，不简单删断言。
- `apps/api/test/integration/identity-session.test.ts`：/me、过期/撤销/disabled、CSRF、库 adapter 链。
- `apps/api/test/workspaces.test.ts`：不列他人 owner、不披露 root、重叠/同物理根拒绝、登记变化撤权、路径/链接边界。
- `scripts/test/local-account.test.ts`：自动取绑定管理员、明确选人、保留登记、拒绝改他人归属、文件/配置/重载分步失败。新增普通 owner 维护要扩展该行为覆盖，不删原保留测试。
- `apps/web/test/account-navigation.test.ts`：安全 returnTo、HTTP 401 与流内错误区分、无业务重放、账户响应未知和真实 /me 核验。
- `apps/api/test/integration/tasks-read.test.ts`、`approvals-read.test.ts`：跨 owner 拒绝与不存在区分；tasks 还验证通知按 owner/task 双条件和 GET 零副作用。
- `apps/api/test/integration/conversation-history.test.ts`、`harness-authority-http.test.ts`：owner-scoped 历史、Run GET/cancel/HTTP 与真实归属门。
- `apps/api/test/integration/tool-invocations.test.ts`：owner/conversation/Run/attempt 一致性、已接受结果重放和当前权限隐藏；`tool-invocations-workspace.test.ts` 有撤权后迟到效果保留但不披露的覆盖。
- [账户历史验收](../verification/account-access-verification-2026-10-27.md) 记录旧版本真实 Web/PG、库实验、多 Cookie/流式 proxy 受控实验及两次重启；它不证明新增多用户、邮件、OAuth 或生产域名可用。

### 10.3 文档归类与引用规则

`docs/README.md` 保持唯一总入口。分类按内容职责，不按更新时间混放：

- `docs/design/api/schema/prd/agent/adr/references` 保持语义和现行有效合同；本轮只因移动修相对链接，不修改业务条款。
- `docs/plans`：本文件、`r2a-context-engineering-plan.md`、原 demo 下的能力重构/inline-reminder/v0 收口计划。规划保留其 Proposed、历史版本与已完成范围，不因移动抹去旧判断。
- `docs/guides/local-lifecycle.md`：从根目录移入的实际操作指南。
- `docs/verification`：根目录带日期的账户/本机生命周期/会话历史/Web 体验/inline-reminder 验证记录，以及原 demo 下带日期的验收/实验 MD 与其关联 JSON。MD/JSON 作为同组历史证据移动，修复互链，不复制旧路径副本。
- `docs/demo`：仅保留可重复运行的 `v0-slice-smoke.md`、`fault-injection-smoke.md`、`time-core-golden-cases.md` 等 smoke/故障/黄金用例说明，不继续存规划和历史报告。

本文件引用指南/历史报告/其他规划均以移动后路径为准，例如 [本机使用指南](../guides/local-lifecycle.md)、[本机历史验收](../verification/local-lifecycle-verification-2026-10-27.md)、[会话历史验收](../verification/conversation-history-verification-2026-10-28.md)。移动负责人同步修复受影响的 README、贡献指南、规范引用和仓库其他消费者的相对路径；已加载的仓库规则、已合并迁移与用户环境不因机械链接检查而改写。

不建空 README、旧路径副本或兼容 shim。Today 研究只吸收“目录不等于授权、身份/运行/效果分离、首个只读信息源”的结论，不复制竞品代码、提示词、API 命名、个人账户证据或原始实验脚本进入仓库。

文档整理的交付检查由集成负责人统一执行：检查新增规划为 Proposed；索引仅一个总入口；搜索旧路径引用；检查移动后的相对链接、历史 MD/JSON 伴随文件和未搬迁规范；确认没有凭据/用户数据混入、没有改变有效业务合同。不因纯文档整理启动业务测试或部署。

## 11. 实施前置与仍需真实证据的风险

| 前置/待确认                                                                                               | 谁提供/确认                        | 未满足时的处理                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 邮件供应商、发信域名与 SPF/DKIM/DMARC、回信/退信策略、幂等接受能力与费用                                  | 用户/部署者选择并授权              | 不代注册/购买；不能宣称真实邀请和找回已完成                                                    |
| 生产 APP_ORIGIN、HTTPS、Cookie 域名边界、邮件链接域名和飞书精确回调 URI                                   | 部署者                             | localhost 实验不替代生产 Cookie/OAuth 验收                                                     |
| 联系邮箱与办公 token 的加密密钥托管、备份/恢复、轮换与访问人                                              | 部署者/安全负责人                  | 缺 key 明确不可用，不重生成覆盖，不更换原 auth secret                                          |
| 飞书 app_id/app_secret、应用类型、发布版本、offline_access、Docx 只读 scope、测试用户可用范围和文档权限   | 用户/租户管理员                    | 只读公共资料不能替代授权；不调用本机 lark 登录态或自动授权外部账号                             |
| 首批用户是否来自同一可用飞书租户                                                                          | 用户/产品负责人                    | 自建应用不承诺跨租户可用；若要跨租户先解决上游应用资格，不预建多组织                           |
| 联系方式隐私告知、外部模型使用、快照/邮件载荷保留期限、注销请求口径                                       | 产品/安全负责人                    | 不把断开写成彻底抹除；正式合同先说明有限承诺                                                   |
| Better Auth 改密/多用户准入/事务与 adapter 的锁定版本兼容                                                 | identity 负责人在隔离 PG 实验      | 复用真实库能力，不猜全量 handler 可满足新合同                                                  |
| 飞书 v3/PKCE、实际 user_info 字段/scope、refresh 一次消费、复杂 Docx 纯文本与 revision 关系、撤权传播延迟 | connector 负责人持授权测试账号实验 | 文档已核实 API，不把样例或公共说明当当前租户实测；失败准确记录，不用 tenant token/网页抓取降级 |
| 与 #104 的共享 contracts、当前资格读取和资料消费接缝版本                                                  | 主线集成负责人                     | 不在本分支另起 Harness/GoalResult/运行所有权方案                                               |

最终放行必须同时有：真实邀请与恢复、正式 Cookie/会话撤销、真实双用户全资源隔离、无工作区新用户可用、旧安装不改归属，以及本人飞书 OAuth/刷新/断开/撤权与实际 Docx 读取的证据。任何一项未做都应标明未验证，不能以 scaffold、mock、假回退或历史绿色替代。
