# 受邀账户 P0：Better Auth / PG16 可行性证据（2026-11-03）

## 结论与证据等级

本次是 [#112](https://github.com/BqLee-AI/Along-agent/issues/112) 的 **P0 库能力及现有接缝实验**，不是邀请业务实现或 P1 验收。

- **Observed**：锁定 Better Auth **1.7.10** 可为非安装管理员的标准 credential 生成正式 Cookie；该 Cookie 经现有 HTTP `GET /api/v1/me` 和正式 resolver 被接受。与此同时，现行正式 `POST /api/v1/auth/sign-in` 仍对同一用户返回 **401、零 Set-Cookie**。库认证能力与产品准入策略不是一回事，不能把实验开户当作已开放普通用户登录。
- **Observed**：库 `api.changePassword({revokeOtherSessions:false})` 在现有 HMAC adapter 上实际成功，无兼容失败；另以库 verify/hash、client-bound adapter 更新及 PG 软撤销组成最小本人改密编排，观察旧密码失败、新密码成功、全部会话撤销后三个旧 Cookie 均被正式 `/me` 拒绝。
- **Observed**：库可以在外层事务 COMMIT 前生成 Cookie headers；它不负责外层响应发布。现有账户服务真实 HTTP 路径在 COMMIT 确认前不响应，提交失败/受控提交结果未知均返回 **503、零 Cookie**。
- **Observed**：整个实验前后，原管理员 `users.id/auth_email`、credential 行 ID、`account_id/password_hash` 及安装管理员绑定未变化；不是以新用户替代原身份。
- **Proposed 复用边界**：保留 Better Auth 密码算法、credential adapter 与 Cookie 生成；由 identity 窄用例持有资格检查、同用户锁序、credential 更新/全部会话撤销及提交后发布。无需自研密码或第二套 Cookie，不挂载库全量 handler。

## 对象、版本与隔离

源码基线：`76f8b78bd334e025fc98b6c75cf4d9c7bb7b19ed`。实验时间：`2026-11-03T01:52:08.298Z`—`01:52:18.908Z`。

| 对象          | 实际版本 / 标识                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 宿主运行时    | Windows x64，Bun `1.4.2`，`--no-env-file`                                                                                  |
| 库 / 驱动     | Better Auth `1.7.10`；pg `8.23.1`；从实际安装包的 package.json 读取并断言库版本                                            |
| PostgreSQL    | `PostgreSQL 16.15 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit`                                 |
| Docker        | client / Engine `28.1.1`，Docker Desktop `4.41.2`，Linux amd64 Engine                                                      |
| PG 镜像 ID    | `sha256:6a2e324ebe59af6031c4c1cd96c1d5072c2ebc36563d2196365e43b8297c062d`                                                  |
| PG RepoDigest | `postgres@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab`                                         |
| 独占资源      | 容器 `along-112-authpg-20261103-f83a`；网络 `along-112-authpg-20261103-f83a-net`；卷 `along-112-authpg-20261103-f83a-data` |
| 网络          | PG 仅新绑定 `127.0.0.1:57368`，由 `-p 127.0.0.1::5432` 动态分配；正式 HTTP handler 另在 loopback 动态端口启动临时服务      |
| 实验文件      | `D:/Temp/along-112-authpg-20261103-f83a/experiment.mjs`；已按本阶段约束在取证后删除                                        |

没有挂载用户安装或既有数据卷，没有使用既有数据库/认证凭据，没有读写 `.env*`。脚本在导入产品模块前清除继承的应用环境变量，仅保留运行时所需的 PATH/系统/临时目录变量，注入本次内存新生成的认证 secret 和新 PG 凭据；dev-auth 明确关闭。认证 Origin 是实验值，不是生产来源域名。

只复用已安装的依赖和既有 `packages/contracts/dist`，直接导入基线 TypeScript 模块；未安装/升级依赖，也未构建现有包。原有依赖只读使用，实验代码全部在仓库外。PG 为全新独占库，按文件名顺序执行 **0001—0020 共 20 个原始 SQL 文件**，保留每个文件自身 BEGIN/COMMIT，不裁剪为仿制 schema。

### 字节标识（SHA-256）

以下是实验实际读取文件的 hash，不是密码、Cookie 或数据库事实摘要。

| 文件                                     | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| throwaway `experiment.mjs`               | `24f9943e86ff30e9fa1bdcb792c60934f721e840c5e02676e8346212ff487643` |
| `bun.lock`                               | `f68bfc0c77f16ba7cc63266d55ad3d2dc8c22ac6a9d8f952cb58f4955f2fd831` |
| `identity/better-auth.ts`                | `8dff32bd83e9a000b4f5059d2762440a48ca81fdc8dd324d43474bcd06a4dbb4` |
| `identity/pg-adapter.ts`                 | `022d1fa55fe2f3c94ab7d2205faae48c97f16b560b4d7bba3b21007f55ab0274` |
| `identity/account-service.ts`            | `cd395fdc0767a28a84651336a171abe278c05b7313d5f1bfabfed84c4bb9e565` |
| `identity/crypto.ts`                     | `9b3aab09513666cc462a3a0212570ec7f97bf092f96af449603fcfc8d179a60b` |
| `http/auth.ts`                           | `91d7287a51cc876d1ef6ff541cfe7c1f0a5491880edd0814fecb398888c98846` |
| `http/app.ts`                            | `db0ac823ede56fc4d2f882afd3d179012367c2f1409fcaba1eb7dc9c57552b88` |
| `packages/contracts/dist/index.js`       | `397420118f921a833d2c0b48be707c3e3589b8af43e0d9c11206d2a16ca3d7fd` |
| `0001_identity_core.sql`                 | `dbf641de0790ccdf83185d80a04081998e1d9dc6ec813813f90c9738a678c47c` |
| `0017_identity_account_access.sql`       | `37ad479a26f69cf0f7bc166a0e5b5bcb32f4d69dee4e027417bb45cc1ca44d79` |
| `0020_conversation_readonly_routing.sql` | `cc927df921af0d712517adf8eb35f06347fc61f04bdf70c90211622e667ddb61` |

`identity/` 和 `http/` 路径相对 `apps/api/src/modules/` 和 `apps/api/src/`；迁移路径相对 `infra/migrations/`。其余原始迁移由上述基线固定；没有修改旧迁移。

## 实际执行方式

实际执行入口与工作目录：

```text
cwd: D:/Temp/along-112-authpg-20261103-f83a
bun --no-env-file D:/Temp/along-112-authpg-20261103-f83a/experiment.mjs
```

脚本用 `spawnSync('docker', args)` 创建以下资源。下面保留实际参数结构；唯一不记录的参数值是用 `randomBytes(24).toString('hex')` 当次生成的 PG 密码；认证 secret 另用 `randomBytes(48).toString('hex')` 生成，均未输出。

```text
docker network create along-112-authpg-20261103-f83a-net
docker volume create along-112-authpg-20261103-f83a-data
docker run -d --name along-112-authpg-20261103-f83a --network along-112-authpg-20261103-f83a-net --mount type=volume,source=along-112-authpg-20261103-f83a-data,target=/var/lib/postgresql/data -p 127.0.0.1::5432 -e POSTGRES_USER=along112 -e POSTGRES_DB=along112 -e POSTGRES_PASSWORD=<本次随机值，不归档> postgres:16-alpine
docker port along-112-authpg-20261103-f83a 5432/tcp
docker image inspect postgres:16-alpine --format "{{.Id}} {{json .RepoDigests}}"
```

实际原始迁移执行算法是 `readdir(infra/migrations).filter(name => name.endsWith('.sql')).sort()`，在同一真实 PoolClient 上逐文件 `client.query(await readFile(file,'utf8'))`；不用迁移 mock。实验主池与独立观察池使用同一新建库、不同物理连接。

临时 HTTP server 使用 `createServer((req,res) => handleRequest(req,res,{pool,accountService,tzdbVersion:'2024a'}))`，没有重写 `/me` 或认证路由。用户名和密码为纯实验值；公共响应、raw token、签名 Cookie、CSRF、密码 hash 及 secret 不归档。

参考并核对了 [identity 集成测试](../../apps/api/test/integration/identity-account.test.ts) 中的初始化、独立池观察、绑定 client、deferred commit fault 和丢失 commit ACK 接缝，但本次是单独程序实际执行，**没有运行该测试文件或仓库 suite/build/lint/format**。

## F1：普通 credential 可认证，不等于获得产品登录准入

1. 通过现有正式 HTTP `POST /auth/initialize` 在新库建立原管理员：201；其库 Cookie 请求正式 `/me` 为 200。把原管理员 user、credential、绑定事实存入内存基准。
2. 另取 PoolClient，BEGIN；`createAuth(pool,{secret,origin,client}).$context` 的 adapter 按标准 `user/account` 模型创建第二个 user 和唯一 credential；口令由 `context.password.hash` 产生，`accountId=user.id`，COMMIT。没有创建第二条安装管理员绑定，没有 P1 准入表、邀请或邮件。
3. 同一 `createAuth` 的 `api.signInEmail({body:{email,password},returnHeaders:true})` 连续创建第二人的两个会话。真实库 Cookie 请求正式 `/me`：200，返回 owner 等于该第二人；直接正式 resolver 亦解析同一 owner。
4. 对 Cookie 用既有 `verifySignedCookieValue` 取得 raw token，仅在内存比较：PG `token_hash === hashSessionToken(raw)`，且 PG 值不等于 raw。两会话寿命均在 `(604799000,604800000]` 毫秒，符合相邻时钟采样的固定七天。
5. 使用该第二人的用户名、同一正确密码调用正式 HTTP `POST /auth/sign-in`：**401、零 Set-Cookie**，数据库仍只有先前两个该用户会话，没有额外会话。
6. 独立连接比较原管理员 `id/auth_email/credential_id/account_id/password_hash` 与基准完全相同；总 user 数为 2，绑定仍指向原管理员。

这符合源码职责：[`account-service.ts#signIn`](../../apps/api/src/modules/identity/account-service.ts) 要求安装管理员绑定，而 [`http/auth.ts`](../../apps/api/src/http/auth.ts) 按签名、HMAC、有效期、撤销和 active 状态解析会话，不要求管理员。P1 必须实现受邀准入策略，不得把 resolver 收紧成仅管理员，也不能只增加一行 user 就声称已开放多用户。

## F2：本人改密的库调用与全会话失效

### 实际库端点能力

以第二人的第一个正式 Cookie 和正确当前密码直接调用：

```ts
await auth.api.changePassword({
  headers: new Headers({ cookie, origin }),
  body: { currentPassword, newPassword, revokeOtherSessions: false },
  returnHeaders: true,
});
```

**Observed**：成功；`response.token === null`，Set-Cookie 数为 0。后续最小编排从数据库读到更新后的 credential，库 `password.verify` 对这个端点刚设置的新密码返回 true。因此本次没有“changePassword 与 HMAC adapter 不兼容”的失败，不能把历史 adapter 风险推断成该 API 现行必然失败。

**范围限制**：这里只调用库 API，没有新增 Along 本人改密端点/Origin-CSRF 校验或页面。没有实跑 `revokeOtherSessions:true`。锁定库 `dist/api/routes/update-user.mjs` 静态观察：该分支会删除用户会话、改密、**新建替换会话并发 Cookie**；它不直接等于本合同要求的“全部会话退出”。

### 最小可复用编排的真实运行

另执行一次明确的本人改密，不使用自研密码/Cookie：

1. BEGIN，正式 resolver 解析现有 Cookie 得本人 ID；在同一 client 上 `SELECT ... FROM users WHERE id=$1 FOR UPDATE`，再锁定该人 credential。
2. 绑定该 client 的 `createAuth` context 调用库 `password.verify({hash,password:currentPassword})`；确认通过后用库 `password.hash(finalPassword)`。
3. 同一 context 的 `adapter.update({model:'account',where:[{field:'id',value:credentialId}],update:{password:nextHash,updatedAt:new Date()}})` 更新原 credential 行；同 client 执行 `UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 RETURNING id`，本次撤销 2 行，然后 COMMIT。
4. 独立连接读取真实 hash：库 verify 对原密码 false、最终新密码 true，结构为 salt:hash。直接库 sign-in 对原密码报 `UNAUTHORIZED`；新密码生成的新 Cookie 请求正式 `/me` 为 200。
5. 先前两个 Cookie 请求正式 `/me` 均为 **401**。再次持久撤销该人的全部会话后，刚才新密码创建的第三个 Cookie 也为 **401**；独立连接查询该人 `revoked_at IS NULL` 会话数为 **0**。

上述结果来自真实数据库事实和正式拒绝响应，不是库 `success` 或清 Cookie 的替代证据。清当前浏览器 Cookie 的提交后时机沿用 F4 的正式服务证据；本实验编排本身没有实现新的清 Cookie 产品入口。

**Proposed**：P1 可复用已验证的库 verify/hash/adapter 更新组合，identity 负责把改密、一次凭证消费和全部会话撤销纳入同 client 事务；必要时也可调用已实跑的库改密 API，但不能认为库成功本身覆盖外层锁序和发布。登录与改密/恢复并发资格仍须 P1 单独证明，本次顺序改密不是竞态验收。

## F3：client-bound 中途失败与外部可见性

单个真实 PoolClient 上 BEGIN，以 `createAuth(...,{client})` 创建候选 user、credential，并实际库 sign-in 生成 session/Cookie headers，尚未 COMMIT：

- 独立连接按候选 `auth_email` 查到 user 数 **0**；本次已确认库返回了非空 Cookie headers，但未向 HTTP 发布。
- 执行真实故障 SQL：`SELECT 'intentional failure'::integer`，得到 PG SQLSTATE **22P02**；ROLLBACK。
- 独立连接候选 user 数仍 **0**；全库 `auth_accounts LEFT JOIN users ... WHERE users.id IS NULL` 为 **0**；先前缓存的候选 Cookie 请求正式 `/me` 为 **401**。不把未提交的库结果当作已开户事实。

session 与 credential 的 user FK 均来自原始迁移；本次直接计数的是候选 user 和孤儿 credential，Cookie 拒绝另覆盖回滚 session 不可用。没有以重写 adapter、另一个 pool 的伪事务或手工签 Cookie 模拟该链。

关键限制是 **库 headers 已生成不等于允许发给浏览器**。接受邀请按 Proposed 合同只创建账户、不自动登录，可进一步避免响应丢失导致重复签发；这仍需 P1 实现，不由此实验自动获得。

## F4：正式 HTTP 的 COMMIT 发布边界

同一个临时 HTTP server 运行原 `handleRequest`，仅通过 Pool/PoolClient Proxy 在明确接缝控制时间或抛错；SQL 均发往真实新 PG，服务没有被替换为 stub。

| 场景                          | 真实方法                                                                                                                                       | 观察                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| COMMIT 前 gate                | 正式管理员 sign-in；代理在实际 `client.query('COMMIT')` 前等待显式解除，库此前已经建立事务内 session                                           | gate 持有时再等待 100ms，fetch 尚未得到 HTTP 响应；独立连接新增可见 session 数 0。解除后正式响应 200、非空 Cookie，该 Cookie `/me` 200 |
| PG 拒绝 COMMIT                | 在实验 sessions 表创建 `AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED` constraint trigger，触发函数 `RAISE EXCEPTION 'deferred commit fault'` | 正式 sign-in 返回 **503、零 Set-Cookie**；独立连接 session 增量 **0**。随后移除本次 trigger/function                                   |
| COMMIT 实际成功、调用者未确认 | 代理先 `await realClient.query('COMMIT')`，之后抛 `injected lost commit acknowledgement after real commit`                                     | 正式 sign-in 返回 **503、零 Set-Cookie**；独立连接 session 增量 **1**，没有把失败响应误写成回滚已发生                                  |

“丢失 ACK”是明确的**受控应用层故障注入**，不是物理网络断连/真实半开连接实验；但已实证实际 COMMIT 与调用者返回错误可同时存在，以及本例不发布 Cookie。未知结果不能按“没有成功响应”推断可以安全重放开户或一次凭证消费。

本次复用了当前 `account-service.transaction` 的真实提交后返回行为，不代表 P1 接受邀请、改密、恢复等尚不存在的入口已经持有此保证。

## F5：当前锁竞争接缝

- 连接 A BEGIN 后实际持有 `SELECT pg_advisory_xact_lock(680068,1)`。
- 另建连接池，连接参数 `options: '-c statement_timeout=150ms'`，通过原 `createAccountService(contenderPool).signIn` 竞争同一现有安装锁。
- **Observed**：竞争请求抛 `httpStatus:503`，消息为 `account dependency unavailable; inspect account status before trying again`；随后连接 A 回滚释放锁。

这证明当前全局安装锁确实影响正式登录的可用性与错误口径；它没有证明逐用户锁、旧密码登录与恢复竞争、邀请接受/撤销/重发的赢家语义，也没有做吞吐/延迟基准。P1 不应把安装级串行化的存在当作所有新竞态已被覆盖。

## 历史 E1—E5 的复用范围

依据 [2026-10-27 账户验收](account-access-verification-2026-10-27.md) §“锁定 Better Auth 1.7.10 的隔离实验”，本轮只补新增能力和关键发布边界，没有重跑完整历史用户旅程。

为确认复用对象，实际执行以下历史比较，输出为空：

```text
git diff 5a035a89678133afa0f2ac5c2a7eccd569503e8e 76f8b78bd334e025fc98b6c75cf4d9c7bb7b19ed -- apps/api/src/modules/identity/better-auth.ts apps/api/src/modules/identity/pg-adapter.ts apps/api/src/modules/identity/account-service.ts apps/api/src/modules/identity/crypto.ts apps/api/src/http/auth.ts apps/web/src/app/api/[...path]/route.ts infra/migrations/0001_identity_core.sql infra/migrations/0017_identity_account_access.sql
```

| 旧证据                                            | 本轮使用方式与边界                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1 标准字段/UUID、真正同 client 回滚              | 原始 identity 迁移和适配器未变，历史结论仍适用；F1/F3 在 0001—0020 的新 PG16 上另补普通 credential 和事务内库 sign-in 后失败                           |
| E2 seed 不能直接登录、明确转正保留原人            | 继续保留历史限制；本轮没有重跑 seed 或本机维护。F1/F5 的新库原管理员保持只是兼容接缝证据，不是用户旧安装升级验收                                       |
| E3 raw Cookie/HMAC                                | 原实现未变；F1 再验证非管理员真实库 Cookie 与 HMAC、resolver；没有复现已经修正的旧 adapter 错误                                                        |
| E4 库 signOut success 不能代表持久撤销            | 继续作为不能以库 success 放行的反例，不重复已知故障；F2 改用独立 PG 与正式旧 Cookie 401 验证全撤销事实                                                 |
| E5 正式 proxy Origin/DTO/no-store/body/流与 abort | proxy 源码比较未变，旧证据仅支撑其已测协议行为；本轮没有启动 production Next.js/proxy/browser，不将本地 API handler 请求称作新的 Web、HTTPS 或代理验收 |

历史构建/全套门禁仍属于其记录中的版本和范围，不迁移成“#112 已通过全部 CI/集成”标签。

## 清理与剩余验收

脚本 finally 实际完成且每项 docker 命令成功退出：

```text
docker rm -f along-112-authpg-20261103-f83a
docker volume rm along-112-authpg-20261103-f83a-data
docker network rm along-112-authpg-20261103-f83a-net
```

本次新建容器、卷、网络均移除；取证转入本文后删除本次 throwaway 目录（脚本与无敏感值 results.json）。未删除/停止既有容器、网络、卷或安装。没有修改生产代码、迁移、模型路由、原安装或凭据；没有外部邮件、DNS、飞书/本机 Lark、模型调用或 Bark。

本轮已完成：真实锁定库/PG16 的普通 credential、正式 Cookie/resolver 与现行拒绝差异、原身份/credential 保持、库本人改密能力、最小原子改密/全会话撤销、client-bound 中途回滚、正式已有服务的 COMMIT gate/失败/未知及当前锁竞争观察。

**仍未覆盖，不能据此开放邀请入口或关闭 #112**：P1 正式准入/邀请/验证/恢复/会话端点与 UI；一次凭证/联系方式/邮件 schema；真实邮件成功/失败/超时/接受未知；生产 HTTPS/Secure Cookie；两个隔离浏览器 context 的正式 Web/proxy/API 全旅程；全资源双 owner 隔离；登录/恢复/停用竞争与凭证旧代次/跨用途；持久限流；旧安装副本升级与两次正式 stop/start；本机普通账户登记；真实网络故障。外部前置见 [单独清单](invited-account-external-prerequisites-2026-11-03.md)。

本工作线程未运行仓库 suite/build/lint/format，亦没有 commit/push。最终合同/文档门禁由集成负责人统一执行；P1 实施时按新增行为另补真实集成与用户验收，不能用本 P0 临时编排代替。
