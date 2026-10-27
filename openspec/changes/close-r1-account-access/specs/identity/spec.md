## ADDED Requirements

### Requirement: 单租户唯一管理员与原子开户

系统 SHALL 仅对确证空安装提供首次管理员开户，并以 identity 所有的真实单一 PG 事务和数据库唯一约束保证并发唯一及失败全回滚。存在历史 owner、既有登记或管理员绑定时不得匿名接管。状态、事务及空安装依据见 docs/design/16-r1-account-access.md §2、§8（AC1；D3/D6/D8）。

#### Scenario: 空安装真实 Web 开户

- **WHEN** 用户在确证空安装的正式 Web 提交合法首次账户信息
- **THEN** 同一事务建立一个用户、credential、会话和管理员绑定，提交确认后才发布 Cookie，浏览器经正式 proxy 的 /me 读取该用户

#### Scenario: 并发开户唯一

- **WHEN** 两个独立 PG 连接同时请求首次开户
- **THEN** 最多一个提交成功，另一方明确冲突，数据库只留下一个完整管理员账户而无多余用户/credential/session

#### Scenario: 中途失败无孤儿

- **WHEN** 开户事务任一步失败或提交结果无法确认
- **THEN** 不发布成功 Cookie、不伪报完成；确认回滚时无孤儿，结果未知时先核对实际绑定而不另建替代账户

#### Scenario: 旧安装或不可核验状态

- **WHEN** 安装已有用户、业务历史 owner、登记或绑定，或依赖/登记不可核验
- **THEN** 不按空安装匿名创建管理员；分别进入原身份维护或准确依赖错误，绑定不因会话过期或账户 disabled 而重新开放

### Requirement: 原身份明确授权转正

系统 SHALL 保留原 users.id 及全部业务 owner 事实；有效旧签名会话仅可在 CSRF 与明确确认后转正当前用户，无会话时须经部署者正式本地维护入口明确选择。不得默选 seed、批量合并、覆盖已有密码或激活 disabled。详见 design/16 §3（AC2；D1/D6/D8）。

#### Scenario: 当前旧会话转正

- **WHEN** 活跃原用户持有效签名会话、正确 CSRF 和明确确认设置正式登录
- **THEN** 只更新该 actor 的无密码 credential 并绑定原用户，原 ID、历史、任务、批准、工作区及其他 owner 均保持；客户端不能指定另一个 owner

#### Scenario: 无会话显式本地选人

- **WHEN** 原会话失效且部署者从正式本机维护入口选择并确认候选账户
- **THEN** 程序内部使用该原 ID 完成有资格的转正/绑定，不要求手填 ID，不默认选择第一个、最新或唯一 seed，不通过匿名 HTTP 披露候选

#### Scenario: credential 与身份冲突

- **WHEN** 目标已有密码、credential 不一致、登录名/绑定冲突、账户不活跃或历史 owner 缺用户
- **THEN** 停止有冲突的转正并给有资格入口可操作说明，不覆盖口令、激活账户、合并或重写业务 owner；已有合法口令须验证后明确绑定

### Requirement: 库 credential 与 Cookie 兼容

系统 SHALL 复用锁定 Better Auth 的密码哈希/验证和 Cookie、现有 HMAC resolver；提供相容的标准字段、UUID、credential account_id 与真实 client-bound transaction。PG 仅存 token HMAC，HTTP JSON 不披露原 token/hash。详见 design/16 §4、§7（AC3；D1/D6/D8）。

#### Scenario: 正式登录往返

- **WHEN** 绑定管理员经生产 Web/proxy 使用合法口令登录
- **THEN** 库生成的 Cookie 被现有 resolver 和 /me 接受为同一原用户，库密码 hash 与 PG token HMAC 正确持久化，无手工 Cookie 或备用认证

#### Scenario: 标准字段与库返回形状

- **WHEN** 库创建或读取 credential/session
- **THEN** 标准 password/时间/UUID/account_id 正确映射，存储 HMAC 不被当作 raw token 签名，不逆解 hash、不依赖全局 token 缓存；选用调用链由隔离真实实验确认

### Requirement: 固定会话与可信退出

系统 SHALL 创建固定七天会话且不滑动续期，退出以服务端已确认撤销为成功依据，随后才清 Cookie；过期重登保留原身份。详见 design/16 §4（AC4；D6/D8）。

#### Scenario: 七天过期后原账户重登

- **WHEN** 会话期间反复读取页面并在固定到期后再次访问
- **THEN** GET 不延长七天寿命，过期请求为 401；正式重登仍为原用户，不新建身份或恢复业务动作

#### Scenario: 正常退出

- **WHEN** 用户以有效会话、Origin 和 CSRF 退出
- **THEN** PG 确认当前会话撤销后才返回成功并发清 Cookie，持旧 Cookie 再访问 /me 为 401

#### Scenario: 撤销依赖失败

- **WHEN** PG 撤销失败或提交结果未知，即使库报告 success
- **THEN** 返回准确依赖错误，不伪报完整退出、不发布清 Cookie；显式再次操作核对真实事实，不按本地清理冒充服务端撤销

### Requirement: 窄认证入口与原业务安全

系统 SHALL 仅暴露已评审的认证窄接口；真实 Origin、适用签名会话 CSRF、输入与原始 body 边界均在正确边界校验，保留业务 owner/批准/取消/unknown 合同。详见 docs/api/auth/auth_routes.md §4、design/16 §5（AC5；D6/D8）。

#### Scenario: 公开失败不泄漏账户

- **WHEN** 登录名不存在、密码错误、无 credential、非绑定用户或用户不活跃
- **THEN** 返回相同公开认证失败，不披露是哪一种，不创建会话；数据库故障则为依赖错误而非 401

#### Scenario: Origin 或 CSRF 不合法

- **WHEN** 初始化/登录/转正/退出的 Origin 缺失、恶意或为 null，或会话写入缺失/错误 CSRF
- **THEN** 拒绝请求且无副作用；匿名登录 Origin 校验不代替已有业务 session-bound CSRF，开发桥不能用于转正

#### Scenario: 未评审路由或超限输入

- **WHEN** 请求未知认证路径/方法、畸形输入，或声明/分块 UTF-8 body 超过既有上限
- **THEN** 按 404/400/413 明确拒绝且无副作用，拒绝未结束上传仍能有限响应并关闭；不挂载库全部 handler 或无界缓冲

### Requirement: 正式 proxy 保留认证与流边界

系统 SHALL 在正式 Web proxy 保留真实 Origin、多 Set-Cookie、no-store、有界 body、SSE 流式及取消传播。详见 design/16 §5（AC3/AC5；D6/D8）。

#### Scenario: 来源与多个 Cookie

- **WHEN** 浏览器经 proxy 发出认证请求并接收库生成的多个 Cookie
- **THEN** API 收到原始真实 Origin，proxy 不伪造缺失来源，多个 Set-Cookie 与认证成功/失败 no-store 均完整传回

#### Scenario: SSE 与取消保持

- **WHEN** 现有业务 SSE 经同一 proxy 传输或下游取消
- **THEN** 响应保持流式、取消传播至上游，认证接入不缓存整流、不改变既有 body/上传拒绝语义

### Requirement: 可用账户页面与只读重登恢复

系统 SHALL 提供可独立使用的建号、转正、登录和退出页面；仅对 HTTP 401 引导安全站内重登，成功后只读恢复原状态而不重放业务动作。详见 design/16 §5（AC6；D6/D8/D10）。

#### Scenario: 原页面会话过期

- **WHEN** 用户在任务、批准或原 Run 页面遇到 HTTP 401 并成功重新登录
- **THEN** 返回安全原站内位置，仅 GET 读取已保存状态；不自动补发消息、确认、取消、继续或其他 POST

#### Scenario: 非会话错误与不安全返回位置

- **WHEN** 发生 403/503、登录表单自身 401、流内业务失败，或 returnTo 为外部/畸形/登录回环
- **THEN** 保留对应错误且不进入会话过期跳转循环，不接受不安全导航；合法登录后无法安全返回时回首页

#### Scenario: 键盘与密码管理器

- **WHEN** 用户仅用键盘、粘贴和密码管理器完成账户操作
- **THEN** label/autocomplete/焦点和提交状态可用，密码不 trim、不阻止粘贴，错误给出可操作说明且不要求助手或手工 Cookie

### Requirement: 账户与本机工作区分层收尾

系统 SHALL 从已绑定管理员公共事实取得 owner，通过 #67 私有配置与重载入口完成登记；账户 PG 提交、文件/配置发布、重载分别报告，不伪装跨资源原子性。详见 design/16 §6（AC2/AC7；D1/D6/D7/D8）。

#### Scenario: 正式本机完成登记

- **WHEN** 账户已建立且部署者通过正式本机入口完成授权资料登记
- **THEN** 程序自动使用绑定 owner，保留原登记/root/有限权限及其他 owner；无登记时明确授权有限资料，不让用户手填 ID、不默认开放整卷

#### Scenario: 文件或重载失败显式补做

- **WHEN** 账户已提交但登记写入、配置保存或重载失败
- **THEN** 准确区分账户已配置和工作区未就绪，保留账户与原 ID；显式补做仅处理未完成收尾，不重开户、换密钥、重建 root 或自动恢复 Agent

#### Scenario: 安装锁与两次启停

- **WHEN** 完成登记并经同一配置重载及两次启停
- **THEN** 更新锁/数据库连接释放后才另行重载，无嵌套锁或自阻塞；原身份、登记与资料保持，不自动提交业务 POST

### Requirement: 完整切片与分层验收证据

系统 SHALL 在支持的本机正式环境以真实 PG、Web/proxy/API 交付完整账户路径，不依赖 seed、助手、临时服务、手工 Cookie/owner ID。合同、隔离实验、测试和真实用户路径分别举证，保留五门和原安全边界。详见 design/16 §7–§8（AC7；D7/D8/D10）。

#### Scenario: 新安装和原安装完整使用

- **WHEN** 按正式指南执行新安装建号、原身份转正、登录/退出/过期重登及登记收尾
- **THEN** 前后端和维护入口共同可用，原 users.id/history/workspace 保留；不把后端接口、空页面或临时桥当作完成

#### Scenario: 兼容实验与升级证据

- **WHEN** 对锁定库适配、新身份迁移及账户交付执行验收
- **THEN** 先隔离确认字段/真实事务/token/撤销/proxy风险，配套新增迁移核验与扫描规则；原迁移冻结，五门和认证/CSRF/owner/批准/取消/unknown 不回归，未执行项如实保留
