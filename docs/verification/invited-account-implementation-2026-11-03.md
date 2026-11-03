# 受邀账户 P1 实现验证（2026-11-03）

## 版本、范围与放行结论

- 实现分支 `feat/112-invited-accounts`，起点为 P0 合同 PR #113 合入后的 `6f7803dfda5e31baa8a77b0cedfba846cb7e3b8f`。本记录随 P1 实现提交；最终 CI 以实现 PR 的精确 head 为准，不能沿用 #113 的绿色。
- Better Auth 1.7.10、Bun 1.4.2、PostgreSQL 16；正式 `infra/docker/Dockerfile` 构建原生 Harness/Bun 镜像。PG、测试账户、密钥、端口和生命周期配置均为本任务独占隔离夹具，不是原安装或真实收件账户。
- 覆盖代码、严格 DTO、正式 API/本地进程入口、真实 PG 并发和故障、原生消费者、Web/proxy 与本机维护；外部邮件供应商接受/受控收件、生产 HTTPS、可信来源 IP 链、密钥托管/恢复与隐私保留批准另行取证。
- 未发送外部邮件、未读写 `.env*`、未使用原安装或既有业务凭据、未变更 DNS/域名/模型路由、未部署。实现 PR 仅 `Refs #112`；不归档 change、不关闭 issue、不宣称完整 P1 外部验收完成。

> 迁移序号整合说明：以下执行记录保留当时账户分支的 `0022→0023` 与93列实况。合入主线时，主线 `0023` 已用于直接创建提醒，账户迁移改为 `0024_invited_accounts.sql`，以主线0023结构事实加账户事实形成0024基线；本次重排不将旧记录视为新序号或合并基线已验证的证据。

实现提交 `ea742e3c9047aead0ed28f3eb284d2fcfecdca10` 的 [PR #115](https://github.com/BqLee-AI/Along-agent/pull/115) / [CI run41588956058](https://github.com/BqLee-AI/Along-agent/actions/runs/41588956058)：`static`、`migration-scan`、`scheduler-fault`、`contracts-dual`、`compose-smoke` 五项均 success。此记录固定该实现版本；记录/任务同步后的最终head另由同一PR checks核验，不把旧head绿色转移给新head。没有把CodeRabbit状态当成人工独立批准。

任务独占PG与所有父线程验证容器/三个image标签已清理；两个早期失败尝试遗留的key夹具目录只核对文件名后删除、未读取密钥内容。保留脱敏生命周期/浏览器证据与D盘固定Bun缓存，不清理其他工具或用户共享缓存。

## 实现与职责

| 用户可观察能力                     | 实现位置与不变量                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通受邀账户登录，不获得安装管理权 | `account-service.ts`、`invited-service.ts`、`http/auth.ts`：active 且显式 admission；唯一管理员只是附加窄管理资格，原 ID/auth_email/credential/secret/历史 owner 不迁写 |
| 加密联系邮箱与验证换绑             | `email-security.ts`、`invited-service.ts`：独立 lookup/challenge/AEAD/rate 密钥，地址锁和数据库唯一；当前邮箱在新地址验证前有效，旧恢复 revision 同事务撤销             |
| 邀请、一次接受和安全重放           | 严格 actor/action/key、原 HMAC key-id 与脱敏响应快照；七天内后续终结/邮件状态/活动 key 变化不重建凭证；过期邀请与另一 pending 地址冲突返回稳定 409                      |
| 密码恢复、改密和本人会话           | 同 client 的库验密/哈希/更新、用户锁/revision、全撤销；只有确认 COMMIT 后才发布或清库 Cookie，接受/恢复不自动登录                                                       |
| 邮件准确状态                       | `mail.ts`、独立 worker 邮件 tick：submitting 先提交，网络期间不持业务锁；真实 Resend HTTPS 适配器不自动配置，无可信未接受证据就 unknown 且不重投                        |
| 停用/注销请求与在途事实            | resolver/Run/工具/历史入口核对当前资格；scheduler durable permit 与独立接收的 user SHARE；已授权在途和原回执不改写，identity 不反向锁写 Run/task                        |
| 普通 owner 的本机有限资料登记      | `local:account --admit/--workspace`：明确候选、保留原哈希/登记/root/权限，配置和 registry 的字节版本核对，释放 DB 锁后 reload                                           |
| 安全链接和账户页面                 | username/email 分支、账户/联系邮箱/会话/邀请/用户管理、`/invite`、`/reset-password`、`/verify-contact`；fragment 仅内存、GET 零消费、显式提交，错误不自动重放敏感 POST  |
| 前向升级                           | 新增 `0023_invited_accounts.sql`，精确基线93列及约束/索引；重复 credential/绑定异常先停，不合并、删除或重写旧身份                                                       |

## 测试策略与真实 Red/Green

本切片不是全量 TDD。未知库能力沿用 P0 指定版本实验；大部分实现使用测试后补，明确记录如下，不把 import/环境/夹具失败称为行为 Red。

- 实施前正式 HTTP 的三项行为缺失：未准入 active owner、账户读入口和缺邮件配置的恢复边界；修复后通过。首次过期包导出导致的 import 错误不算 Red。
- 缺失邀请的 resend 第21次仍 404，实际违反 actor 配额；修复为不存在目标也先收费，目标存在时再增加地址维度。
- 审阅后先新增行为失败：匿名恢复缺历史 key 形成202/503存在性差异；轮换 challenge key 后不能重放；邀请关闭后无法返回原脱敏 DTO；过期 A 与新 pending B 同址重发错误；共享 mailbox schema 拒绝允许的 ASCII padding/标点。修复后对应真实 PG/共享合同用例通过。
- 活动凭证引用的历史用途 key 被误移除时，合法旧邀请被误判409；合法输入下实际观察该行为，再增加按purpose检查未消费/未撤销且未到期 key引用的依赖门。有效/随机凭证同为503、不消费邀请；恢复原key可成功接受，终结旧引用不阻塞后续无效凭证409。首次未设置DATABASE_URL导致skip及缺display_name的400夹具不算Red。
- 既有真实 PG 回归发现 notifications 重复接收漏验原发送版本；改为通过 tasks 公共只读投影核对原 outbox 版本，保留停用后有效旧回执。完整指定调度门通过。
- 原生双入口撤销消费者实际发现已接受时区事实在内部终态汇总被重新授权，导致 Run 留 running；把资格留在内容/执行边界，底层已绑定事实解码不重新授予披露权，两个原生消费者恢复 failed/partial 记账且不向撤销连接输出终态正文。
- 邀请接受六个真实表写点的故障回滚、双入口长旅程及真正提交后丢 HTTP 响应属于补充行为覆盖，不称为先行 Red。曾将 delivery UPDATE 错列为接受写点；实际由提交后的消费者核验 consumed 并收尾，已删除这一不存在写入的错误断言，保留全部六个实际写点与投递事实快照覆盖。
- 旧夹具必须显式建立测试 admission。生产 `seedSession` 原限制不放宽；孤立历史 owner 用例显式保持没有 users 行，重复 credential 的异常转到0022旧库预检，而非在新增唯一约束后伪造可插入重复行。

## 已执行的隔离门

| 执行                                                                           | 观察与版本边界                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 `test:contracts`，WSL Linux x64、固定 Bun1.4.2、脚本自建正式镜像与私有 PG16 | 213 pass、0 fail、3522 assertions、26 files；当前执行报告及十项可执行门均通过。包含修复后的两个原生撤销消费者；脚本清理自有资源                                                                                                                   |
| 根 `test:scheduler`，正式镜像加当前 API src/test 只读挂载、自有 PG             | 32 pass、0 fail、260 assertions、4 files；取消、许可后 unknown、独立接收、错误版本绑定与 drain 全通过                                                                                                                                             |
| 首轮完整根 `test:integration`                                                  | 407 pass、8 fail：显式准入夹具、孤立 owner/重复 credential 的旧夹具、只读 Pool 假对象，以及通知版本绑定回归；未将失败隐藏或记绿                                                                                                                   |
| 修复上述问题后的根 `test:integration`                                          | 414 pass、0 fail、4061 assertions、43 files；新加的双入口/六写点覆盖另列最终执行，不用该数量冒充后来新增测试已运行                                                                                                                                |
| 最终全部API修复与邀请六种锁先后的根 `test:integration`                         | **429 pass、0 fail、4336 assertions、44 files**；含历史用途key缺失Red/Green、COMMIT后丢HTTP响应只开户一次、六实际写点全回滚/干净重试和接受/撤销/重发全部六种地址锁先后                                                                            |
| 双入口签名账户旅程初次执行                                                     | 2 pass、0 fail、226 assertions；真实库 Cookie/CSRF、username/email、无 workspace、管理/owner/游标/会话 ID 隔离、改密/恢复/撤销/停用/注销；加入 HTTP 丢响应后由最终完整集成覆盖                                                                    |
| 初期 Linux 根 `verify --network none`                                          | 10步通过；unit724 pass、37 skip、0 fail、3250 assertions。此快照早于后续通知/终态/表单/Compose 修复，不将它冒充最终 head 的统一门                                                                                                                 |
| 最终 Linux 根 `verify --network none`                                          | **10步全通过**；unit724 pass、37 skip、0 fail、3250 assertions；typecheck、28 lint warnings/0 errors、边界/治理/迁移检查、11项OpenSpec strict和746文件format通过。正式最终镜像加仅test响应emit类型修复的只读挂载，源码行为与最终集成/生产构建相同 |
| 最终93列本机数据库集                                                           | `local-invited-database.test.ts` 与 `local-goal-database.test.ts`：27 pass、0 fail、191 assertions；含旧session完整快照/两次只读reconnect，与下面真正stop/start不同证据                                                                           |
| Windows 宿主根 `verify`                                                        | unit719 pass、39 skip、3 fail；三个 `local-lock.test.ts` 失败、中止后续。没有停止未知监听器，没有改锁代码或声称 Windows 通过；Linux 隔离结果不是 Windows 原生修复                                                                                 |

邮件状态/清理的实际网络实验为本机 loopback 协议模拟器；配额使用真实 PG 多进程及重启。密码 reset-first/login-first、邮箱唯一、COMMIT失败/丢ACK、user SHARE与停用的两个持锁顺序使用真实独立连接与屏障，不用 sleep 推断谁先持锁。

补充竞争覆盖首轮六项失败只因PG bigint返回字符串，查询明确cast后全部通过，不算行为Red。双入口测试不继承宿主认证secret或Origin，逐用例使用并恢复独占进程配置；Bun中先closeAllConnections再close导致teardown `ERR_SERVER_NOT_RUNNING`，按先停止接入再清连接的次序修复，独立2项/227断言及最终根集成通过。typecheck另发现响应适配器object-literal的this不含混入EventEmitter类型，改用最终response引用；没有加类型逃逸。

另以一次性脚本启动真实 `startWorkerLoop`，在独立连接持有 mail deliveries 表排他锁：观察一个邮件backend真实等待Lock期间调度成功完成3 tick；随后stop、释放锁并成功排空，错误0、外发尝试0。脚本只用空邮件队列和独占PG，已移除，不把这个实验冒充供应商投递。

## 真实浏览器与正式proxy

验证负责人使用 Chromium156、Bun1.4.2、Next16.4.2 `dev --webpack`、独占数据库和本任务镜像。实际 `handleRequest`/services/PG 与 Next proxy，不是伪造响应；API是夹具入口而非正式main/worker。令牌仅从本任务delivery密文解密，没有启动邮件worker或外发邮件。

- 初始化201；归一化用户名/验证后邮箱登录200；联系邮箱请求202、新地址验证前旧地址有效，打开fragment清除且零POST，明确验证200。
- 三个邀请创建201；真实列表queued、重发200升第二代、撤销200显示revoked/suppressed。两普通账户明确接受201，随后`/me`仍401；普通账户没有管理区且users/invitations实际403。
- 无workspace账户仍可管理本人资料/会话并读取自有历史；管理员读另一owner历史messages为403、列表不含该资源。工作区状态不声称模型可用。
- 错误当前密码401留/account；真实CSRF403只一次POST、不跳登录；缺邮件配置503准确unavailable并禁继续提交；真实429保留至少216秒Retry-After且UI不重放。
- 改密后保护页跳登录，旧密码401/新密码200；all撤销后历史页跳登录；禁用另一账户后其旧Cookie `/me`401。reset明确200后仍未登录，新密码登录保持原owner。
- 正式proxy保留三项库清Cookie与no-store；本地HTTP Cookie为HttpOnly/SameSite=Lax，未冒充HTTPS Secure证明。
- 真正未结束上传：声明1000000字节、只送1字节的未认证敏感POST约105ms完整401；sign-in送132000字节且不结束约302ms完整413，均含响应终止。不是只测已缓存完整body。
- **浏览器Red/Green**：共享form未写method时原生默认GET把一次性探针口令放query；两个共享form改POST后，禁JS的login/forgot-password实测原生POST、URL无口令/query、不消费API且无成功回执。该探针从未作为账户密码；夹具销毁，无秘密截图；工具历史不可编辑删除，不隐瞒原Red记录。
- **浏览器Red/Green**：同路径/invite点击新token不重挂载，遗留fragment/旧成功；hashchange读取并清除、按token重置表单以及只读响应generation隔离后，新邀请/reset链接均清fragment、清旧成功、零POST，仍须明确提交。

截图与无秘密JSON保留在私有 `D:/Temp/along112-browser-20261103/`：邀请列表、无workspace资料/历史、恢复后账户、邀请/reset未登录成功态、403/503/429不重放、禁用重登及禁JS原生POST。父线程核对无workspace真实截图与对应交付代码。自有tab/context、domain Cookie、两个容器、数据库及秘密夹具均已清理。

此组浏览器证据使用Webpack开发服务：最初默认Turbopack隔离实验hydration不可靠，没有把换引擎后的结果称为默认开发模式通过；完整生产构建和正式main的证据另列。没有将本地HTTP或解密夹具链接冒充真实邮件与生产HTTPS。

### 默认生产构建与正式main补验

父线程另以新正式镜像执行 `bun --no-env-file run build`（network none），所有packages/API及Next16.4.2默认Turbopack生产构建成功，新账户与三条安全链接路由均产出。生产工件镜像为 `sha256:edde86e79f89c1ed15b28a211451d554186a954f830f5f06928106a66bc7baab`。

使用独占新数据库、正式DeploymentDatabase初始化0023、容器内新私有keyfile，之后运行未经替换的编译`apps/api/dist/main.js`（ROLE=api）及根Web start入口。真实Chromium经生产Next/proxy键盘Enter提交初始化，观察“账户已接受、资料登记待配置”而非假称资料/模型可用；明确进入/account后正式`/me`200/no-store，URL无query并看到本人会话与管理区。1280px真实账户截图保留在任务私有截图目录。

生产表面的API容器正常退出0；Web验证容器的Bun workspace启动包装在docker stop宽限期后被强制退出137，服务已停止且独占库已删除。此清理结果不计作优雅退出通过，也不替代下面正式local:stop两次成功的证据。

生产reset页面用两个仅格式有效的探针fragment验证读取与切换：hash均清除、新token重置已填字段、`new-password`与native POST属性正确、消费POST=0；375px截图实测scrollWidth=375无横向溢出。这不证明探针是有效后端凭证或邮件链接，真实一次凭证业务已由上面的PG/浏览器夹具覆盖。生产测试域Cookie已定向清除，tab已关闭、服务和独占数据已清理；仍未执行生产HTTPS或供应商发送。

## 正式旧副本生命周期与宿主权限修复

验证负责人使用本任务私有 checkout snapshot（source digest `aab1a92f564ce4701f70e7f2391e4c254d09fc16b432d9a49750ebc3d3a5c26d`）、Windows Bun1.4.2和 Compose2.35.1。复用正式 API 镜像 `sha256:ffc22a24c591d947c369122d8f81fd7a282513796f3714ac278e7c5f6b28f90b`，复制已有 Web 编译工件；不是重新执行 `local:init` 构建，也不是原用户安装副本。真实 Windows ConPTY 执行账户交互，不绕过 TTY门或注入维护业务。

- 以正式 DeploymentDatabase 创建并核验0022旧库夹具，包含绑定管理员、另一原 owner、canonical auth_email/真实库 credential hash、原 conversations/messages/cancelled task。
- 正式 `local:upgrade --config <任务私有配置>` 在重复 credential 故障时返回 `MIGRATION_FAILED_RECONCILE_BEFORE_RETRY`；原完整用户/凭据/绑定/历史逐值不变，故障行仍在、账本仍0022、无 admissions 表。只移除明确故意加入的故障行后干净重试到0023/93列；初始只有绑定管理员获准入。实际管理员登录200、旧普通 owner401。
- 两个独立坏副本分别真实删除 `identity_action_keys.response_snapshot` 和 `identity_action_keys_replay_check`，得到 `baseline_additional_columns_mismatch` / `baseline_additional_constraints_mismatch`；版本仍0023但分类unknown，升级拒绝 `unsupported_upgrade_source`，没有自动修表。
- 正式 `local:account --admit` 明确选普通owner并核验其原口令，随后 `--workspace` 增加 `/var/lib/along/workspaces/formal-owner`，仅读 `fixture.txt`、无写权限；观察 account_committed、registry_published/config_saved/registry_loaded，原 credential与管理员绑定不变。
- **两次真实正式 `local:stop` / `local:start`**：每次 stop 后 API/PG容器均停止、Web不运行、两个HTTP端口不可连；start 后 API新container ID、Web新PID、两人真实HTTP登录均200、原事实逐值相同、两条准入和原registry SHA256保持，workspace GET200。不是 PG reconnect。
- 实际发现宿主ACL私有 keyfile 在 Linux bind 显示0777导致登录503；修复正式 Compose启动命令后，每次新API容器均从只读source产生字节相同的0600运行时文件，birthtime逐次递增；严格 Linux loader未放宽，没有使用替代key卷通过验收。

Docker通过仅转换Windows参数/bind路径的任务自有transport adapter转发WSL，不改返回状态或服务行为；这是**路径适配后的正式入口通过**，不是未经适配的Windows原生Docker全路径通过。私有snapshot复用编译工件的准备边界不扩大为新安装构建验收。

脱敏证据位于任务私有 `D:/Temp/along-112-formal-lifecycle-20261103/` 的 commands、upgrade、structural、两次cycles和cleanup记录；秘密配置/keyring/口令/原事实快照、私有工件和terminal依赖已删除。最终正式stop后清理仅本项目容器/网络、两个自有external卷和image别名；共享PG与正式验证镜像未被操作。外部邮件、模型调用与生产部署不在这项证据范围。

## 外部材料与验收边界

[外部前置记录](invited-account-external-prerequisites-2026-11-03.md)和 [PRD](../prd/04-acceptance-open-questions.md#受邀账户外部前置112)是缺口真源。发布者须提供或批准：

1. 获准 Resend 发送账户及验证发件子域；供应商实际 DKIM/SPF 值与 DMARC策略。接口适配不代表采购或供应商处理条款已批准。
2. 两个受控收件箱及允许发送邀请/验证/恢复的测试范围；同时保留 API接受与实际收到的独立证据，不提交原地址、token、供应商请求ID。
3. 唯一生产 `APP_ORIGIN`、HTTPS证书/反向代理与可信来源 IP 链；另验 Secure Cookie、实际 Origin、多Cookie/Retry-After、未完成上传有限关闭与不重放。
4. 四类独立密钥的私有托管、key-id保留、备份恢复/轮换权限；原认证 secret 保持，缺旧 key 不能靠重生密钥“恢复”。
5. 供应商可见邮箱/链接、区域/保留，本地邀请地址和幂等墓碑留存，以及注销请求不等于物理删除的批准口径。

本机 loopback邮件与临时密钥不能替代这些材料；缺项阻塞真实外部验收与邀请入口放行，不阻塞实现 PR 的审查。
