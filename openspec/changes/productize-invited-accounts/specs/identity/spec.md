## MODIFIED Requirements

### Requirement: 库 credential 与 Cookie 兼容

系统 SHALL 复用锁定 Better Auth 的密码哈希/验证和 Cookie、现有 HMAC resolver；提供相容的标准字段、UUID、credential account_id 与真实 client-bound transaction。PG 仅存 token HMAC，HTTP JSON 不披露原 token/hash。正式登录以 identity 显式准入且 active 为业务门，而非仅限绑定管理员；原身份和凭据保持。详见 docs/design/21-invited-account-access.md §2、§6（D1/D6/D8）。

#### Scenario: 受邀普通账户正式登录往返

- **WHEN** 已接受邀请且 active 的普通账户通过正式 Web/proxy 提交正确用户名或已验证邮箱及口令
- **THEN** 库 Cookie 经现有 resolver 和 /me 被接受为该独立 user，不要求管理员绑定；固定七天、原 HMAC 与无 raw token JSON 边界保持

#### Scenario: 原管理员与标准字段保持

- **WHEN** 旧安装升级并由原管理员登录，或库创建/读取 credential/session
- **THEN** 原 users.id/auth_email/credential 与认证 secret 不被迁写，标准字段/UUID/client-bound transaction 正确；存储 HMAC 不冒充 raw token，不逆解或全局缓存，不手写密码/Cookie

### Requirement: 窄认证入口与原业务安全

系统 SHALL 仅暴露已评审窄认证接口；真实 Origin、适用签名会话 CSRF、输入和原始 body 边界在正确边界校验，保留业务 owner/批准/取消/unknown 合同。未准入不等于普通非管理员；所有登录分支执行相同准入/active/credential 门。详见 docs/design/21-invited-account-access.md §2、§5、§8（D6/D8）。

#### Scenario: 公开失败不泄漏账户

- **WHEN** 登录标识不存在、密码错误、无正式 credential、未准入或用户不活跃
- **THEN** 返回相同公开认证失败且不创建会话；合法已准入普通账户不因非管理员而拒绝，依赖故障准确为 503 而非 401

#### Scenario: Origin 或 CSRF 不合法

- **WHEN** 任一账户 POST 的 Origin 缺失、恶意或为 null，或需签名会话的写入缺失/错误 CSRF
- **THEN** 无副作用拒绝，匿名 Origin 例外不代替本人/管理动作的签名会话 CSRF，开发桥不能消费新账户资格

#### Scenario: 未评审路由或超限输入

- **WHEN** 请求未知认证路径/方法、额外 owner 或畸形输入，或声明/分块 UTF-8 body 超过既有上限
- **THEN** 按既有 404/400/413 拒绝且无副作用；拒绝未结束上传仍有限响应并关闭，不挂全量库 handler、不无界缓冲

### Requirement: 账户与本机工作区分层收尾

系统 SHALL 以 identity 公共资格事实为依据，由部署者明确选取待维护账户，经原本机配置与 workspaces 公共校验合并有限登记；PG、文件/配置和重载分别报告。管理员身份不授权读取或改写他人登记归属，无 workspace 不阻断账户。详见 docs/design/21-invited-account-access.md §8（D1/D7/D8）。

#### Scenario: 正式本机选择普通账户

- **WHEN** 部署者从正式本机有限候选中明确选择已准入普通账户并确认新增登记
- **THEN** 程序内部取该原 user ID，不默认管理员或要求手填 owner；只增加其有限独立 root，保留其他登记 ID/root/权限及原资源归属

#### Scenario: 文件冲突或重载失败

- **WHEN** 登记/配置被并发修改或文件发布、保存、重载失败
- **THEN** 准确报告冲突/未完成步骤，不覆盖其他变更、不回滚已提交账户；释放原锁/连接后才 reload，显式续做不重开户、不换 secret/root/原卷或自动业务 POST

#### Scenario: 无工作区与两次启停

- **WHEN** 新账户未登记本机 workspace，或原安装完成登记后两次正式 stop/start
- **THEN** 无登记账户仍可管理本人邮箱/会话/恢复并使用真实已配置基础能力，不继承管理员 root；启停保持原身份、登记和固定会话期限，不虚报模型可用

## ADDED Requirements

### Requirement: 业务准入与安装管理分离

系统 SHALL 由 identity 显式持有业务准入和当前 active 资格；唯一安装管理员只拥有窄安装管理资格，不因此取得他人 owner 资源权。保留空安装防接管、原身份及旧 owner 明确维护门。详见 docs/design/21-invited-account-access.md §2（D1/D6/D8）。

#### Scenario: 历史 owner 不自动获准

- **WHEN** 升级存在绑定管理员及其他 active 历史 users/seed/业务 owner
- **THEN** 仅为当前绑定管理员补准入并保留其原有效会话；其他人不因存在、旧邮箱 hash 或旧会话获得新准入，需本机明确核验原身份/口令，不建替代 user 或合并历史

#### Scenario: 管理员访问另一人的资料

- **WHEN** 管理员与普通用户互换任务、批准、会话/Run/事件、工具结果、通知或 workspace 的 ID、parent、游标和幂等键
- **THEN** 各正式公共入口继续按可信 owner 隔离，管理员同样不能越权读取/操作，不借管理摘要泄漏业务内容

#### Scenario: 当前资格失败及空安装门

- **WHEN** 用户失去准入/active、资格读取失败，或已绑定安装的管理员失效
- **THEN** 新动作/披露不以缓存登录资格放行，依赖故障不当 active；初始化不重新开放，未绑定旧安装只保留原受控转正路径

### Requirement: 独立加密且唯一的已验证邮箱

系统 SHALL 保留不透明 auth_email 和旧邮箱字段语义，以 identity 单一规范化策略、独立 AEAD 地址及用途分离 HMAC 建立可投递联系邮箱；只有本人验证成功才取得当前恢复/邮箱登录资格。详见 docs/design/21-invited-account-access.md §3（D3/D6/D8）。

#### Scenario: 同一规范邮箱并发验证

- **WHEN** 两个用户或邀请接受与本人换绑并发争用同一规范化地址
- **THEN** 数据库最多留下一个已验证 owner，不由先查再写绕过；未验证候选不永久占位，不根据同邮箱合并身份，冲突不泄漏另一个 user

#### Scenario: 换绑与旧恢复邮件

- **WHEN** 本人以当前密码申请新地址并完成本人的验证，旧地址尚有恢复凭证
- **THEN** 验证成功前旧地址继续有效；切换、revision 更新、凭证消费和旧恢复撤销同事务完成，旧链接不能再改密，verify 凭证不能当 reset 使用

#### Scenario: 旧字段和密钥不可用

- **WHEN** 旧 primary_email_hash/email_verified 已有值，或联系地址密钥缺失/无法解密
- **THEN** 不把旧字段自动提升为验证/恢复权，不修改 auth_email/认证 secret；缺 key 准确依赖失败，不生成新 key 覆盖或返回假空成功，存储/日志无明文邮箱

### Requirement: 一次邀请原子建立独立账户

系统 SHALL 只允许合资格管理员邀请，收件人显式接受后在一事务中建立完整独立账户/credential/准入/已验证联系方式并消费邀请；不自动登录、不继承管理员资源。详见 docs/design/21-invited-account-access.md §4（D3/D6/D8）。

#### Scenario: 显式接受及扫描器预览

- **WHEN** 扫描器/用户 GET 或预览邀请链接，随后用户主动提交有效接受
- **THEN** GET 零消费；只有 POST 建立一套完整账户，返回未登录且无 Cookie，收件人再经正式 sign-in，未登记 workspace 不回滚开户

#### Scenario: 接受竞争与响应丢失

- **WHEN** 同代邀请被并发接受，或接受已提交但响应丢失后再次提交
- **THEN** 最多一套 user/credential/准入/contact，后续消费统一失效且不签新 session，引导正式登录/恢复；任何确认回滚无孤儿

#### Scenario: 接受时已登录或地址已归属

- **WHEN** 浏览器仍登录另一个 Along 账户，或地址已由现有账户验证
- **THEN** 要求明确退出/切换，不能把邀请静默挂到当前 actor；已归属地址不建立第二身份/合并历史，匿名错误不披露现有 user 状态

### Requirement: 凭证代次和邀请管理竞争

系统 SHALL 以用途、目标、地址 revision、当前代次、取锁后数据库期限和消费/撤销事实裁决一次凭证；创建/重发具备管理员范围幂等，失效凭证不能重复消费。详见 docs/design/21-invited-account-access.md §4.2（D3/D6/D8）。

#### Scenario: 重发旧代迟到及跨用途

- **WHEN** 邀请/验证/恢复被显式重发后旧邮件迟到，或凭证到期/错用途/已消费/已撤销
- **THEN** 只有当前有效用途代次可消费；无效格式之外的失败统一不透露目标状态，不因 GET/排队延长寿命

#### Scenario: 接受与撤销或重发竞争

- **WHEN** 独立 PG 连接在取得真实写锁后让接受与撤销/重发竞争
- **THEN** 先获得写权且提交者裁决，失败事务不算赢；接受提交后不能撤销开户，撤销/新代先提交则旧代零开户

#### Scenario: 幂等键重放与异参

- **WHEN** 管理员重复同 action/key 的规范输入、改参数重放或使用超出重放期限的 key
- **THEN** 同参回同一安全事实不增投递/凭证，异参/过期明确冲突不新建；重放仍核验当前管理资格，不返原 token 或重演密码写入

### Requirement: 提交后邮件与诚实接受未知

系统 SHALL 在身份 PG 提交确认后才允许窄邮件消费者发送，明确待发送、尝试、供应商接受、明确失败、接受未知和写前抑制；未知不盲重投，GET/预览不消费凭证。详见 docs/design/21-invited-account-access.md §5.1（D3/D6/D8/D10）。

#### Scenario: 业务回滚与正常发送

- **WHEN** 邀请/验证/恢复业务回滚，或提交成功后 worker 领取当前有效 queued 邮件
- **THEN** 回滚零发送；成功路径先持久化尝试再在事务外发送，仅供应商确认接受才报 submitted，不称收件箱已送达

#### Scenario: 超时崩溃和旧代在途

- **WHEN** 供应商可能已接受后超时/断连、worker 死于尝试中，或撤销时旧邮件已在途
- **THEN** 无可信未接受证据则保留 unknown、不自动重投；显式重发用新代，旧在途可能到达但不可消费，不以有限供应商幂等窗口证明无限期恰好一次

#### Scenario: 载荷清理与无秘密泄漏

- **WHEN** 载荷终态/超过批准期限，或运维查看数据库、日志、错误与浏览器持久存储
- **THEN** 按合同擦除加密载荷/保留必要摘要，不出现密码/完整邮箱/raw session token/链接凭证；本地清理不虚称供应商已删除

### Requirement: 匿名一致性与持久动作配额

系统 SHALL 对登录、凭证消费及认证发信执行多进程共享的持久原子配额；不存在/未验证/未准入/停用目标不得经匿名恢复响应暴露，依赖故障不得冒充已发送。详见 docs/design/21-invited-account-access.md §5.2（D3/D6/D8）。

#### Scenario: 匿名恢复目标变化

- **WHEN** 对不存在、未验证、未准入、disabled/deleted_requested 或有效验证邮箱提交同类恢复请求
- **THEN** 在相同全局依赖/配额条件下返回相同接纳形状，不带 delivery/账户详情；只有有效当前已验证地址能获得恢复邮件，202 不表示送达

#### Scenario: 多进程和重启超额

- **WHEN** 多 API 进程或重启后的进程同时消耗地址/标识/IP/actor/token 配额
- **THEN** 共享数据库原子裁决，命中任一维度为 429 和准确 Retry-After，不因业务回滚重置，不永久锁号；无效目标也扣同口径配额

#### Scenario: 来源伪造与依赖故障

- **WHEN** 请求伪造转发来源头，或 PG/密钥/邮件全局配置不可用
- **THEN** 只接受已配置可信来源链，否则按真实 peer 限制；依赖预检不依赖账号存在性，准确 503 而不伪报 202/401，存储不含明文 IP/邮箱

### Requirement: 库改密恢复与全部会话原子撤销

系统 SHALL 用锁定库密码能力更新本人唯一 credential，并在同事务消费/撤销恢复资格、递增 credential revision 和撤销全部会话；不自动登录，保持固定七天和提交后 Cookie 边界。详见 docs/design/21-invited-account-access.md §6（D3/D6/D8）。

#### Scenario: 本人改密或有效恢复完成

- **WHEN** 本人以当前密码/签名会话完成改密，或持当前验证地址有效恢复凭证完成重置
- **THEN** 原 user/auth_email/credential ID 不变，新密码库验证成功且旧密码失败，全部旧 Cookie 包括当前均 401；改密确认提交后才库清 Cookie，恢复不签新会话

#### Scenario: 旧密码登录与恢复竞争

- **WHEN** 独立 PG 连接分别让旧密码登录或重置先持 user 写锁并提交
- **THEN** 登录先提交的 session 被后续重置撤销；重置先提交则旧密不能再签有效 session，不存在锁外旧密码验证晚提交绕过 revision 的会话

#### Scenario: 写入失败或 COMMIT 未确认

- **WHEN** 改密/恢复/登录任一步写入失败或提交结果未知，即使库已生成 headers
- **THEN** 确认回滚不留半更新，未知准确 503 且不发布新/清 Cookie；不谎称旧密码仍有效，不自动重放口令写入，先核对真实事实再正式登录

### Requirement: 本人会话可见且可撤销

系统 SHALL 仅让本人读取最少会话摘要、撤销单个/其他/全部本人会话，保留七天固定期限及软撤销，不依赖 adapter 伪造 raw token。详见 docs/design/21-invited-account-access.md §6（D6/D8）。

#### Scenario: 单个及其他会话撤销

- **WHEN** 本人列出会话并撤销一个会话或全部其他会话
- **THEN** 不返回 raw token/HMAC/完整 IP，撤销其他不影响当前；自己的已撤销记录重复成功，其他 owner 与未知 ID 同样不可操作，不改创建/到期时间

#### Scenario: 当前或全部会话撤销

- **WHEN** 本人撤销当前或所有会话，或数据库撤销失败/结果未知
- **THEN** 只有撤销提交确认后才库清当前 Cookie 并成功，旧 Cookie 被拒绝；故障保留准确依赖错误，不用前端清态冒充服务端撤销

### Requirement: 停用注销请求及唯一管理员保护

系统 SHALL 允许窄管理员动作停用普通账户、允许本人凭当前密码申请注销并撤销会话/未消费凭证；保护唯一管理员，禁止物理删除/迁 owner/在线凭恢复复活状态。详见 docs/design/21-invited-account-access.md §7（D1/D6/D8/D9）。

#### Scenario: 普通账户失去资格

- **WHEN** 合资格管理员停用普通账户或本人确认注销请求
- **THEN** 状态与会话/未消费资格同事务失效，新请求/动作/披露拒绝；不取消任务、不伪造回执或改历史 owner，恢复邮件不能绕过状态

#### Scenario: 唯一管理员被停用或申请注销

- **WHEN** 任一入口试图停用/注销唯一绑定管理员
- **THEN** 明确保护冲突且无身份/会话状态改动，不删绑定、不开放匿名初始化或接管；交接另行受控维护

### Requirement: 受邀旅程的正式页面和前向发布门

系统 SHALL 经正式 Web/proxy/API/PG 与真实邮件完整交付账户旅程，保留真实 Origin/CSRF/多个 Cookie/流式上传边界和仅 HTTP 401 安全只读重登；旧安装前向升级保留原身份/密钥/owner。合同/实验不等于入口放行。详见 docs/design/21-invited-account-access.md §8–§9（D6/D7/D8/D10）。

#### Scenario: 正式双用户与生产 HTTPS

- **WHEN** 在两个隔离浏览器 context 从原管理员验证邮箱、邀请到新人设密/登录并本人恢复/撤销
- **THEN** 真实邮件和正式链路可独立完成，生产 HTTPS/Cookie 单独取证，不以 localhost/mock/手工 Cookie 或旧实验替代；键盘/粘贴/密码管理器可用

#### Scenario: 重登及非会话失败

- **WHEN** 受保护请求 401 后重登，或发生 403/429/503、匿名 token 失效、表单自身验证失败
- **THEN** 仅真实会话失效安全跳转，其他准确留页；重登只 GET，不存储/重放邀请/改密/消息/批准/取消/继续等 POST，fragment 凭证不进入 query/持久存储

#### Scenario: 旧安装升级及未齐前置

- **WHEN** 授权旧副本前向升级并两次正式启停，或真实邮件/HTTPS/密钥保留等证据未齐
- **THEN** 旧 ID/auth_email/credential/secret/owner/登记/root 与固定会话保持；异常停写不重建，新事实后不回旧写者；证据未齐不开放邀请、不归档/关闭 #112
