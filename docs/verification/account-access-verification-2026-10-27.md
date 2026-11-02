# 账户登录与本机登记验证记录（2026-10-27）

## 对象与边界

- 对象：基于 `e9d2a6d` 的账户实现，提交 `0da0b7ed2d6cf87de35d5e93717bd47ffd497594`，经 [PR #75](https://github.com/BqLee-AI/Along-agent/pull/75) squash 为 `5a035a89678133afa0f2ac5c2a7eccd569503e8e`；对应 #68、design/16 和 `close-r1-account-access`。本记录区分实现验收与独立归档，不将实现合并当作 Issue 收口。
- 环境：Windows、Bun 1.4.2、正式 Next.js production Web、Compose API/worker、PostgreSQL 16；原生合同使用正式 Linux x64 仓颉构建。
- 使用三个新建隔离安装，分别验证空安装、无会话的多原用户维护、有效旧签名会话转正。仅操作这些安装及独立测试数据库，未使用用户库、原认证密钥或模型配置；模型均未配置，没有模型调用。
- 空安装实跑构建摘要：`41eaf42616042c391459d894bf349aa515c9683a7604fa06200ae24dadc60f66`。该构建之后的代码改动仅为集成测试服务器收尾；真实用户路径的运行代码未变化。
- 以下区分库实验、自动化行为覆盖与真实用户路径。不记录密码、Cookie、CSRF、哈希值、DSN、私有配置路径或安装标识。

## 策略与门禁

| 检查                                   | 本次结果与范围                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试策略                               | 未实现时通过实际 HTTP 观察 `GET /api/v1/auth/status` 返回 404；实现后同一无数据库场景返回预期 503。库未知行为先做隔离实验；其余新增行为使用 PG/HTTP、页面消费者和本机维护行为覆盖，不把事后覆盖称为全部 TDD。    |
| `bun --no-env-file run verify`         | 10 步全通过，含 typecheck、lint、依赖边界、D 门清单、unit、OpenSpec 与格式。unit：321 pass、2 skip、0 fail；OpenSpec：7 pass、0 fail。lint 保留原有 12 条无用转义 warning。                                      |
| `bun --no-env-file run test:contracts` | WSL/Docker 正式当前源码构建；56 pass、0 fail、757 assertions；native local/HTTP、workspace、未知/取消、DTO 与线协议全部通过，D1–D10 可执行清单通过。                                                             |
| PG16 集成                              | Linux 正式镜像运行全部 29 个集成文件：256 pass，另 1 项在全部断言后因重复关闭 HTTP server 而失败。仅修正测试收尾后，该目标定向重跑 1 pass、0 fail、5 assertions；未重复无变化的其余 256 项，不伪称首次整套全绿。 |
| 数据库生命周期冒烟                     | 正式镜像内运行 `scripts/local/database-smoke.mjs`：33 场景通过，包含 0016 升至 0017、两次只读重启、原事实保留、伪账本/部分结构/未知版本拒绝、迁移中断与连接故障。                                                |

Windows Bun 1.4.2 的 PG 并行测试曾发生运行时 segmentation fault；它不是业务 Red。随后改在 Linux 正式镜像完成集成覆盖。首次有限上传测试的失败属于测试清理，不是上传断言失败；已修复并定向验证。

## 锁定 Better Auth 1.7.10 的隔离实验

1. E1：标准字段与 UUID 写入；真正同一 PoolClient 的事务中途失败后，独立连接无提交孤儿。
2. E2：原 seed credential 不能直接密码登录；明确转正后同一原用户成功登录，未建立替代用户。
3. E3：raw token 所签 Cookie 可往返验证，PG 仅保存 HMAC。旧 adapter 返回存储 HMAC 会产生 resolver 不接受的 Cookie；先排除了 `sessions.ip_address` 缺失这一前置错误。
4. E4：库 signOut 可在 PG 撤销失败时仍返回成功并要求清 Cookie，而旧会话实际可用。窄账户入口不能以库 success 代替持久撤销事实。
5. E5：生产 proxy 的实际 Origin、strict DTO、no-store 和 UTF-8 上限另做真实请求；多 Cookie、SSE 与 request/body abort 用真实 HTTP upstream 穿过同一 proxy handler 验证。后者是受控 upstream 实验，不冒充真实模型任务。

原始实验及可复现实验程序留在仓库外的隔离验收目录，凭据不进入本文或 PR。

## 七项验收

### AC1：空安装与唯一管理员

- 实际浏览器从 `/account` 进入开户页；空提交显示具体错误且焦点移至错误摘要。
- 用键盘 Enter 提交，密码保留首尾空格。实际系统剪贴板写入并通过 Control+V 粘贴，两次输入值一致。
- Web 显示“账户已完成，工作区待本机配置”，没有把账户成功说成资料或模型可用。
- 正式 proxy 的 `/me` 返回 200。独立 PG 连接观察 users、credential、administrator 各一，actor 与原创建用户一致；会话寿命正好七天。
- 并发唯一、逐写入点回滚、匿名重复开户、历史/孤立 owner 接管拒绝由本次真实 PG 集成覆盖。

### AC2：两种原身份转正

- 多原用户安装在无有效会话时，Web 只显示正式本机维护说明，不公开候选用户或自动开户。
- 实际运行 `local:account`，按显示名明确选择原资料所属用户、输入 `CONFIRM`、设置隐藏口令；终端输出不含口令。
- 正式 Web 登录后仍是该原 users.id；独立 PG 比较两个用户的原 ID/显示名/metadata 和两条原任务完整事实均未改变。原任务可读，另一 owner 的任务仍返回 403；原登记文件逐字节一致。
- 另一个安装预置旧版签名会话作为测试前置状态，实际浏览器进入 `/claim`；未勾明确确认时拒绝提交，确认后转正成功，原 user ID 和单用户数量不变，原 credential 转为标准可登录 credential。
- 旧签名会话样本的预置不是正式登录证据。空安装、正式登录及本机维护均使用产品入口，不要求用户运行 seed 或手工复制 Cookie/owner ID。
- 已有密码、disabled、无 credential、冲突和孤立 owner 的拒绝/保留由本次 PG 集成覆盖。

### AC3：正式 Cookie 与密码库

- 从实际登录响应取得的 Cookie 被正式 `/me` 接受；独立 PG 比对其 raw token 的 HMAC 与存储会话匹配，PG 不存 raw token。
- password_hash 符合锁定库的 salt/hash 结构，正式库登录验证成功；Cookie 为 HttpOnly、SameSite=Lax。
- JSON 公共 envelope 不含 session token、password 或 password_hash；公开 CSRF 字段仍按会话合同返回。多 Set-Cookie 和错误响应 no-store 另由真实 HTTP proxy 实验覆盖。

### AC4：固定期限、可信退出和原人重登

- 七天期限在重复 GET 后 created_at/expires_at 不变。
- 在隔离 PG 为撤销更新设置真实故障：Web 明确失败，不跳登录；原 Cookie 的 `/me` 仍为 200。移除故障后显式再次退出，进入登录页，旧会话 `/me` 为 401。
- 将测试会话的创建/到期时间一并回拨，受保护任务页面进入带安全 returnTo 的登录页；正式重登返回原任务与查询参数，user/task owner 和唯一管理员不变。
- 实际停止隔离 PostgreSQL：`/me` 与 auth status 均为 503，任务页面保留原地址并展示依赖失败，不误判 401；随后恢复原 PostgreSQL。

### AC5：认证和上传边界

- 正式生产 proxy：缺 Origin、恶意 Origin、`Origin: null` 均为 403；额外 owner 字段为 400；131072 字节 UTF-8 正好进入 DTO 校验并返回 400，超一个字节为 413；这些响应均 no-store。
- 有效浏览器会话携带错误 CSRF 退出返回 403，随后 `/me` 仍为 200。
- 未结束的声明超限与分块 UTF-8 超限提前拒绝、连接收尾、未知路径/方法、统一登录失败等由本次真实 HTTP/PG 测试覆盖；原生合同保留 owner/批准/取消/unknown 与五门。

### AC6：页面与安全恢复

- 错误密码 401 留在登录表单并给出可操作提示；正确密码恢复原任务地址，含编码空格查询值。
- 到期后的浏览器网络记录只有 auth sign-in 一个 POST，未重放业务 POST；恢复读取原任务。
- 390px 实际浏览器验证无横向溢出；错误摘要获得焦点。转正完成页已实际截图核对。
- 已验证 username/current-password/new-password 自动填充属性和粘贴；未验证某个第三方密码管理器扩展的实际集成。
- 403/503 非过期处理，以及 Run/approval/task 位置、危险 returnTo、清除旧重试载荷与 SSE 消费者由本次行为测试覆盖。

### AC7：本机登记和两次启停

- 空安装完成 Web 开户后，实际交互运行正式 `local:account`，明确登记受管卷内已准备的子目录和单个 `notes.md` 的有限读写权限；owner 自动取绑定管理员，没有手填 owner。
- 实际观察 account_committed、registry_published、config_saved、registry_loaded；重载完成后 Web 显示账户已配置、工作区登记已加载，仍明确不代表模型可用。
- 空安装连续两次正式 stop/start，独立比较账户/credential/绑定/任务事实、配置和 registry 字节全部相同。
- 原用户安装连续两次正式 stop/start，配置和 registry 字节、root 的设备/inode、资料 SHA256 均相同，原签名会话仍被 `/me` 接受。
- 文件发布、配置保存和重载失败后的分层反馈与续做、不重复绑定/发布、无嵌套锁由本次本机维护行为测试覆盖；真实成功路径使用正式交互命令及真实 PG/卷/重载，不是注入依赖的模拟。

## 限制与交付边界

- 同一 Chromium context 对 `127.0.0.1` 的不同端口共享 Cookie；三安装验收按顺序登录并核对 HMAC 归属，未把跨安装 Cookie 覆盖造成的 401 当作重启失败。
- 本记录是本地、隔离生产构建及受控实验结果，不冒充部署到用户原安装或 PR CI。PR 的 CI 结果单列在 PR Verification。
- 不更换用户原模型/provider/路由，不进入 #69/#70/R2，不关闭 #66。本记录仅证明 #68 账户切片；[独立归档清单](../../openspec/changes/archive/2026-10-27-close-r1-account-access/tasks.md)对应其七项验收，不代替 #66 全路径验收。

## CI 与独立审阅（2026-10-27）

- 实现提交 `0da0b7e` 的 [CI run 40492094141](https://github.com/BqLee-AI/Along-agent/actions/runs/40492094141) 中，static、migration-scan、scheduler-fault、contracts-dual、compose-smoke 五门全部通过。scheduler-fault 指定四文件为 32 pass、0 fail；不把它称为全部 29 文件集成重跑。
- 用户要求的独立 reviewer 审阅基线为 `e9d2a6d`、目标为 `0da0b7e`，未发现满足“本 PR 新引入、影响可证明且可独立修复”标准的可操作缺陷。
- 独立审阅实际采用只读 diff、源码与消费者追踪，并核对 #68、design/16、auth API §4 和 identity 合同；覆盖账户绑定/事务、库登录与 token/HMAC、撤销后清 Cookie、历史 owner、0017 结构核验、本机登记/配置/重载及 Web 401/SSE 恢复。没有新增动态复现、测试、构建、浏览器或数据库操作；未对系统 ACL、真实 Docker/网络故障、并发文件替换做运行时验证，不表示证明不存在缺陷。
- CodeRabbit Free 只生成摘要，没有独立代码审查意见，不作为上述独立审阅的证据。
- 收口仅归档合同、同步行为规格与引用，不改变运行代码、依赖、迁移或配置；沿用本记录中对应实现版本的有效验收证据，不重复运行没有新增证据价值的账户路径。
