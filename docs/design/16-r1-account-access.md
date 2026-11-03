# 16. R1 账户与正式登录

> 状态：Required 合同；运行能力须由独立实现与验收取证。
> 范围：#68 单租户唯一管理员、原身份转正、credential 登录/退出、会话恢复与本机工作区收尾。
> 不包含：公开注册、多租户/RBAC、OAuth、邮箱验证/找回、滑动续期、历史发现、全站视觉或 R2。
> 阶段：R1 日常可用性；承接 [design/15](15-r1-local-lifecycle.md)。

> #112 的准入、联系邮箱、邀请/恢复与普通账户维护见 [design/21](21-invited-account-access.md)；本页保留 #68 原身份、库认证、固定会话与本机分步收尾的边界。新增资格与接口以该增量为准，外部入口放行不等于代码实现或独立 change 收口。

## 1. 结论与证据

identity 拥有安装管理员绑定、credential 和会话；复用锁定 Better Auth 1.7.10 的密码哈希/验证、Cookie 及现有 resolver，不挂载库的全量 handler。正式交付是 API、数据库、账户页面与本机维护的完整切片，不是登录表单或临时 Cookie 桥。

[Required] `identity/better-auth.ts` 与 `pg-adapter.ts` 负责库标准字段、真实事务和存储 HMAC 边界；HTTP 入口只开放批准的账户用例，Web proxy 保留实际 Origin、多 Set-Cookie 和流式通道。库返回值不能替代数据库提交或正式 Cookie 往返的证据。

[Required] 原 users.id、历史、任务、批准与工作区 owner 保持。新增账户不能替代原身份；存在其他 owner 不代表允许将其数据合并给管理员。#67 的配置、原卷与认证密钥保持，不因登录补建另一套安装。

## 2. 安装绑定与事务

identity 增加单实例管理员绑定 `installation_admin`，字段与约束见 [identity schema](../schema/identity-schema.md#r1-账户与安装绑定68)。同一数据库最多一个绑定；公开 HTTP 不提供重绑、删除或密码重置入口。不引入角色表或多租户安装分区。

所有新建、旧会话转正、本地明确选人共用 identity 公共用例及同一 PG 事务级互斥。初始化必须在同一 PoolClient 上完成：取锁，复核允许状态，创建 users、credential、session 和绑定，确认 COMMIT，然后才发布会话 Cookie。失败整体回滚，不留用户/账户/会话孤儿；并发唯一性由数据库约束最终保证，不靠先查再写。adapter factory 的 transaction 必须绑定真实 BEGIN/COMMIT/ROLLBACK，不能沿用只调用回调的名义事务。

空安装判定不仅检查 users：还须由各模块公共只读投影确认不存在历史 owner，由 workspaces 公共状态确认没有既有登记。登记不可读/无效、发现孤立业务 owner 或依赖不可核验，都不当作空安装。identity 不直查其他模块私有表。正式切换停旧写者，不把 seed 当开户旁路。

绑定后匿名初始化永久关闭，即使管理员 disabled 或没有有效会话也不重新开放。已有历史但无绑定进入原账户维护，不匿名列候选。状态与窄 API 见 [auth routes](../api/auth/auth_routes.md#4-r1-账户访问68)。

## 3. 原账户转正与本机维护

有效旧签名会话可在明确确认、真实 Origin 与 session-bound CSRF 下，仅转正当前 actor；请求不得指定 user_id/owner_id。开发桥 sessionId:null 不能充当转正凭证。转正保留原 users.id 和所有业务事实，无密码的单一 credential 才可在授权事务中原地设置库密码、改 account_id 为原 user ID 并设置规范登录句柄；零 credential 可创建一条。

已有密码不得被转正覆盖。重复/不一致 credential、登录名冲突、绑定冲突、disabled/deleted_requested 或找不到 users 的历史 owner，均停止并给维护说明，不默选、不激活、不批量修复或合并。已有合法 credential 的原用户必须先通过库验证原口令，再经明确本地授权绑定原人；这不是密码找回。

无有效会话时，正式部署者入口为 `bun --no-env-file run local:account --config <私有配置>`。它通过原配置及 identity 公共维护用例展示有限候选摘要，由部署者明确选择并再次确认；内部使用原 ID，不让用户复制或手填 owner ID，不根据“唯一/最新 seed”自动认领。口令隐藏输入，不放 argv、普通输出或日志。该入口也负责检查及完成工作区登记收尾，不运行常驻宿主服务；具体操作见[本机使用指南](../guides/local-lifecycle.md)。

## 4. 库适配、固定会话与可信退出

- 登录名由服务端复用 trim/lowercase 规范化及 deriveAuthEmail，生成现有不透明 auth_email；不作为邮件渠道。不改认证 secret。长度与输入详见 API 合同。
- 使用库标准 password、account 时间字段、UUID 生成和 session 字段；不将 password_hash 声明成另一份逻辑密码。credential account_id 等于原 users.id 文本，禁止迁移时批量改写历史 credential。
- PG 仅持久化 session token HMAC。库在本次创建/查找已掌握 raw token 时，可返回其期望的 raw token；不得把存储 HMAC 再作为 raw token 签 Cookie，也不得逆解或全局缓存。拿不到 raw token 的按 ID 读取形状先实测，不伪造。
- 会话创建后固定七天，禁滑动更新和 Cookie session cache，不暴露 rememberMe、refresh 等分支。Cookie 由库生成，host-only、HttpOnly、Path=/、SameSite=Lax；本机 HTTP 不强设 Secure，HTTPS 遵循库 Secure 前缀。
- 正常退出先确认当前 session 的 PG 软撤销提交，再发布库生成的清 Cookie。库 success 不证明撤销；PG 失败/提交未知返回依赖错误，不发清 Cookie、不伪报完整成功。显式再次操作先查真实事实，不重写创建/到期时间来假装撤销。
- resolver 仅对无效、过期、撤销或不活跃身份返回 401；数据库错误返回 503，不将基础设施故障伪装为会话过期。

## 5. HTTP、proxy 与账户页面

只增加已列出的状态、初始化、转正、登录、退出 API；所有其他库端点保持不可达。沿用统一 envelope、request_id、131072 原始 UTF-8 字节边界与未消费上传的有限响应/关闭行为。匿名初始化/登录使用真实 Origin 校验，已签名转正/退出额外校验会话 CSRF；原业务写入校验不降级。

Next proxy 转发实际 Origin，不凭 APP_ORIGIN 或客户端转发头伪造。保留多 Set-Cookie、no-store、SSE 流式上传/下载和取消传播，不增加无界 body 缓冲。所有认证响应包括失败都 no-store，不返回 raw token、hash、auth_email 或匿名账户详情。

账户页面提供首次建号、正式登录、当前原账户转正及退出；支持键盘、密码管理器、粘贴与可操作错误。登录页不向普通用户暴露模型配置。字段使用真实 label、正确 autocomplete 与提交状态，密码不 trim，不阻止粘贴。

受保护页面或动作收到 HTTP 401 才引导登录，保留安全站内路径及必要 query；只允许同源绝对路径，拒绝协议相对、外部、反斜线/编码绕过、登录页回环，失败回首页。403 owner/CSRF 与 503 保留准确错误，不当过期。登录表单自身 401 仅显示失败，不递归跳转。重新登录后只 GET 恢复原任务/批准/Run；不保存或重放原 POST、消息、确认、取消、继续。SSE 已建立后的业务 thread.failed 不自动解释成会话过期。

## 6. 账户与工作区的分步收尾

PG 账户提交、Windows 私有登记/配置发布和 API 重载不是一个事务。API 容器不直接写宿主私有 JSON，不用 HTTP 执行宿主命令。开户/转正成功后可以已登录而工作区待本机配置，页面必须分别说明，不宣称完整资料能力可用。

正式 local:account 从 identity 公共读取取得已绑定管理员，不接受浏览器/模型提供的 owner。原登记只核验和保留该 owner 的原 workspace_id/root/有限权限及物理根身份，其他 owner 不被改归属。新安装无登记时，由部署者明确准备受管卷内的授权资料和有限相对路径；工具自动填可信 owner，不默认授权整个卷。

收尾顺序：读取并核验同一安装/管理员，私有原子发布登记，经 #67 updateConfig 保存 registryFile，释放该锁及本次数据库连接，再单独调用 reloadInstallation，核对加载结果。updateConfig 与 reloadInstallation 各自取锁，不嵌套；重载前核对原安装和管理员，不停未知服务。中间发生别的生命周期操作时，重新读事实并显式完成，不自动循环重试。

状态必须区分账户未配置、账户已配置但工作区未配置、登记无效/不可读、配置已保存但重载失败、登记成功加载。文件/配置/重载失败不撤销已提交账户、不重开户、不更换 user ID、root、原卷或 auth secret。恢复只补尚未完成的登记/重载，不自动运行 Agent 或补发业务请求。

## 7. 迁移与隔离实验

[Required] 只新增下一序号 `0017_identity_account_access.sql`；旧 0001–0016 不改。配套 `scripts/local/baselines/0017-checks.json` 目录结构核验及 identity 迁移扫描白名单，同批发布；沿用 0016 JSON 核验约定，不引入第二份可执行 DDL。#67 只有显式升级可以执行 DDL；新增绑定表、标准字段适配、约束与完整账本必须可核验。旧 seed/其他 owner 不自动变成管理员，旧认证密钥和 session HMAC 保持。

认证实施前，用锁定库与原迁移在隔离 PG 实验，不用用户库、secret 或模型：

| 实验                     | 必须观察的结果                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| E1 字段/UUID/事务        | 库 factory 到 adapter 的真实标准字段和 UUID 可写；在中途失败后另一连接看不到任何已提交孤儿；事务必须是同一连接。        |
| E2 原 seed 与转正        | 未转正样本与明确授权转正样本分别走库登录；修正仅当前 owner 的 credential，登录后仍是原 users.id。                       |
| E3 raw token/HMAC/Cookie | 先分离字段等前置错误，再核对登录所得 Cookie 经正式 proxy 被 resolver 与 /me 接受，PG 无 raw token，JSON 无 token/hash。 |
| E4 撤销故障              | 对真实 PG 撤销制造失败，对照库状态/清 Cookie/旧会话可用性；窄入口必须准确失败，正常撤销后旧 Cookie 为 401。             |
| E5 proxy/固定寿命        | 正式 Web/API 观察真实 Origin、多 Cookie、分块 UTF-8 上限、SSE/abort；七天到期且 GET 不续期。                            |

[Required] 库会签 adapter 返回的 session.token，signOut 的 success 不能作为撤销提交证据；调用方须守住 raw/HMAC 和数据库撤销边界。隔离实验先排除字段前置错误，再比较 Cookie 与 PG 事实；环境失败不能冒充 token/退出缺陷的 Red。实验若影响公开合同，先修订合同再实施，不削弱验收。

## 8. 交付与验收

合同、锁定库隔离实验、行为覆盖和正式使用路径分别取证；共同交付身份/新迁移及版本核验、窄 API/proxy、账户页面、所有受影响 401 调用者、本机维护和工作区收尾，不拆前后端半成品。完整验收后独立归档，仅关闭 #68。

| #68 验收             | 合同与实施证据                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| AC1 空安装与并发唯一 | identity 真实事务、独立连接并发、逐写入点失败回滚、匿名接管关闭；Web 初始化真实成功。                           |
| AC2 原身份转正       | 旧签名会话和无会话本地明确选人分别验证；多 owner/已有密码/disabled/孤立 owner 不误认，原 ID/历史/目录身份保留。 |
| AC3 库与正式 Cookie  | 库哈希、标准字段、raw/HMAC、正式 proxy 多 Cookie 与 /me；不手工注入 Cookie 冒充登录。                           |
| AC4 固定会话与退出   | 七天、正常撤销、过期原账户重登、PG 故障不伪成功。                                                               |
| AC5 安全拒绝         | 不可区分的登录失败、Origin、CSRF、未知路由/方法、声明及分块超限；原五门与 owner/批准/取消/unknown 保留。        |
| AC6 可用页面与恢复   | 真浏览器键盘/粘贴/密码管理器、错误操作；401 安全返回原页面，仅只读恢复且零业务 POST；403/503 不错误跳转。       |
| AC7 可独立日常使用   | 支持本机环境、真实 PG 与正式构建，开户/转正/维护绑定及两次启停无需助手、seed、临时服务或手工 Cookie/owner ID。  |

行为确定处先观察目标缺失的 Red 再实现 Green，外部库未知先实验。纯合同校验、受控测试与真实用户路径分别取证。#68 不以调用真实模型代替认证验收，不重复 #62/#67 已适用的证据，不进入 #69/#70/R2，不提前关闭 #66。

行为真源见 [identity 规格](../../openspec/specs/identity/spec.md)，完整交付清单见[账户合同归档](../../openspec/changes/archive/2026-10-27-close-r1-account-access/tasks.md)。实施与验收依据见[账户与本机登记验证记录（2026-10-27）](../verification/account-access-verification-2026-10-27.md)，分别标明库实验、自动化覆盖、真实用户路径和独立静态审阅，不将账户切片扩大为 #66 的跨模块验收。
