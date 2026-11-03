# productize-invited-accounts 任务与证据

> Proposed；P0 是合同/实验准备，不是 #112 完成。勾选只说明对应交付已存在，不代表评审通过或生产能力生效。P1 未实施；外部缺口不冒充绿色。完整真源见 design/21 §1–§9。

## P0：合同、隔离可行性和外部前置

- [x] 1.1 静态核对 identity 正式登录、crypto、resolver、库适配、原实验和有效合同；在 design/21 区分 Observed/Required/Proposed，不替换 design/16 Required。
- [x] 1.2 形成准入/邮箱/邀请/验证/恢复/会话/停用、窄 API/DTO/错误与 schema 增量，明确代次/TTL/原子竞争/幂等/匿名限流、生产 proxy 和前向升级，不写生产代码或预占迁移号。
- [x] 1.3 创建 identity/workspaces/scheduler-delivery/notifications 行为 delta（SHALL + 可观察场景），不修改有效 specs、不 archive。
- [x] 1.4 集成负责人同步 PRD、索引及外部待决/证据导航，对照真实代码与实验独立核对 Proposed 参数、查找密钥跨代唯一、锁序、提交边界及跨模块职责；合同批准仍留评审者。
- [x] 1.5 在锁定 Better Auth 1.7.10 + 真实隔离 PG16.15 实跑普通 credential、原身份/credential 保留、库改密/最小全撤销、真实回滚及正式 HTTP COMMIT 前无响应/失败和受控 ACK 未知零 Cookie；方法、版本与限制见 [F1–F5](../../../docs/verification/invited-account-feasibility-2026-11-03.md)。这不是 P1 端点、逐用户竞态或正式 Web/邮件/HTTPS 验收。
- [x] 1.6 [外部前置记录](../../../docs/verification/invited-account-external-prerequisites-2026-11-03.md) 已明确邮件/域名/DNS/受控收件箱/APP_ORIGIN HTTPS/密钥托管和保留批准均无确认取值；未使用原凭据/安装、未发送外部邮件。已完成的是缺口登记，真实外部证据仍受阻，不以此勾选 P1。
- [x] 1.7 集成负责人执行本次适用检查与 OpenSpec strict，记录实际范围及未跑项，独立合同 PR 仅 Refs #112。

## P1：正式完整切片（全部未实施）

- [ ] 2.1 按明确行为先观察目标缺失 Red，再实现准入及管理员保护；保留空安装门、原 ID/auth_email/credential/secret 和历史 owner，不自动激活旧 owner；新增迁移由集成时分配并同步结构核验/扫描规则。
- [ ] 2.2 同批实现加密联系邮箱/规范化唯一、本人验证换绑、邀请创建/重发/撤销/接受与持久限流，正式窄名单/共享 DTO/API/页面共同可用，不挂全量库 handler。
- [ ] 2.3 实现提交后 identity 窄邮件消费者，真实 queued/submitting/submitted/failed/unknown/suppressed、新代/旧代、payload 清理；真实供应商和接受未知不盲重投。
- [ ] 2.4 实现库改密/恢复、credential revision、用户级锁序及全部会话撤销，提交确认后库 Cookie 发布/清除；本人单个/others/all 会话管理，无 raw token 或完整 IP 泄漏。
- [ ] 2.5 实现 disabled/deleted_requested、唯一管理员拒绝、resolver/当前资格、scheduler 原子许可与 notifications 独立接收门；保持取消/回执/unknown，identity 不反向写 Run/task 状态。
- [ ] 2.6 正式 Web/proxy 保留实际 Origin、多 Cookie/流式/有界上传及 no-store；安全链接 fragment/GET 零消费、键盘/粘贴/密码管理器、401 仅只读重登，403/503 不误跳、不重放 POST。
- [ ] 2.7 本机维护明确选取普通准入账户，合并有限独立登记并保留他人原 ID/root/权限；无 workspace 新用户可完整管理账户/使用真实已配置基础能力，不虚报模型可用。
- [ ] 2.8 受授权旧安装副本执行前向升级、故障收尾和两次正式 stop/start，原用户/credential/secret/owner/history/登记/root identity/会话固定期限保持；新事实后不回旧写者。

## A/D：最终验收与独立收口（未执行，不以 P0 关闭）

- [ ] 3.1 D3/D6/D8：真实 PG 双连接覆盖接受/撤销/重发、邮箱唯一竞争、过期/错用途/旧代、逐写点失败全回滚与 COMMIT 未知、丢响应唯一开户，恢复与旧密码登录两种取得锁后屏障顺序；匿名一致性与多进程持久配额具有真实 Red/Green 或诚实替代证据。
- [ ] 3.2 A1/A2/A3、D1/D6/D8：两个真实浏览器 context 经真实邮件/正式 Web/proxy/API/PG 完成原管理员邮箱验证、邀请、新人设密/登录、本人恢复/改密、会话撤销后旧 Cookie 401。互换 tasks/events/approvals/conversations/Run/SSE/tool-results/notifications/workspace 的 ID/parent/游标/幂等键，管理员同样不能越 owner；无 workspace 路径独立可用。
- [ ] 3.3 A3、D1/D3/D9：真实多连接/进程验证停用先提交无新许可/接收，许可先提交如实在途；独立接收无锁环，取消门/真实回执/unknown 不重发不回归，历史匹配接收只核对。
- [ ] 3.4 D6/D8/D10：真实成功/拒绝/超时/接受未知的邮件状态准确，预览/GET 零消费，日志/URL/浏览器持久存储无秘密；生产域 HTTPS/Secure Cookie 与 localhost 分开取证；403/503 不跳、重登后只有 GET，真实可访问页面/密码管理器属性与键盘粘贴可用。
- [ ] 3.5 D7/D8：旧副本升级与两次正式启停、前向修复和原事实保留证据齐全；不得以本轮隔离库实验代替旧安装生命周期。
- [ ] 3.6 集成负责人在最终版本统一执行 `bun run verify`、`bun run test:contracts`、相关 `bun run test:integration`、`bun run test:scheduler`、OpenSpec strict 和 CI 五门，分别关联本地/隔离/生产证据及未覆盖项。
- [ ] 3.7 全部旅程/隔离/旧安装/外部证据与独立评审齐全后才放行邀请入口；独立收口 PR 执行 `openspec archive productize-invited-accounts`、同步有效 specs 与索引，最后关闭 #112。P0 不勾选此项。

## P0 Verification（2026-11-03）

源码基线 `76f8b78bd334e025fc98b6c75cf4d9c7bb7b19ed`；本 PR 仅合同和证据文档，未修改生产代码/依赖/迁移/安装。纯合同不适用运行时 TDD；库未知先真实实验，不将故障注入或事后覆盖称为 Red→Green。

- 锁定库/自有真实 PG16.15：见 [F1–F5](../../../docs/verification/invited-account-feasibility-2026-11-03.md)，包含正式现有 HTTP/resolver 行为、改密/撤销与提交故障；不是 P1 端点/页面或邮件验收。
- WSL/Linux x64：`TMPDIR=/mnt/d/Temp bun --no-env-file run test:contracts`，由根脚本构建正式 native/Bun 镜像及自有全新 PG16，149 pass、0 fail、2119 assertions，20 files；本次 D8 必需 case 与十项可执行门核验通过，脚本清理本次容器/网络/镜像。
- 自有独立 Docker 网络及全新 PG16，在当前正式镜像内执行根 `bun --no-env-file run test:integration`：352 pass、0 fail、3713 assertions，37 files；包含当前 identity/会话、真实 HTTP 有限上传及原业务隔离覆盖。容器/网络/临时镜像已清理，不使用原安装。
- 当前树正式镜像、Linux x64 自有隔离容器 `--network none` 内执行 `bun --no-env-file run verify`：十步全部通过；unit 647 pass、5 skip、0 fail、2738 assertions，61 files。五个 skip 是需另配 PG 的本机 routing schema 准入测试，不是本次旧安装升级证据。lint 保留源码既有24条 warning，零 error；typecheck/depcruise/治理门、全部11个 OpenSpec strict 项和 format:check 通过。
- Windows 宿主首次根 verify 在 unit 阶段为 644 pass、7 skip、1 fail：`local-lock.test.ts` 同进程锁用例监听触发 EADDRINUSE→LOCK_UNAVAILABLE，中止后续步骤。宿主高位监听与锁端口哈希范围重叠，但未取得失败端口和具体监听者的对应关系；未停止未知进程、未改锁代码、未把 Windows 失败记成通过。以上 Linux 验证通过隔离网络命名空间消除共享宿主监听影响。
- `openspec validate productize-invited-accounts --strict` 单项通过；临时相对链接/heading 检查18份受影响文档、266个链接，零缺失/断锚。该轻量检查不替代评审，执行后删除临时脚本。
- 核对并行 #111：共享 docs/README、PRD、auth API、identity schema，但该 PR 不改变 `isActiveOwner(client,ownerId)` 签名；本 Proposed 仅追加身份门职责，不改其本人时区用例或占用迁移号，合并时保留双方独立增量。
- 本地基线检查后，#111 合入 main `b433e302fb08d238cd1120e4f28efcd7978cc2bb`，使首提交 `6ee93414c1ad0a9dc3f47b15565788ea0a8c497e` 的 #113 发生索引冲突，五项 Actions 未启动（只有 CodeRabbit 检查通过）。集成时合入该 main，仅组合双方索引增量，保留 #107 正式时区与 v6 说明及本 Proposed 第21篇；其余共享接口/schema/PRD 自动合并后逐节核对。上述本地数量仍属于原源码基线，不冒充合并后重跑；合并版本以 PR 正文关联的精确 head 五门结果为准。
- 外部真实邮件、生产 HTTPS、两个浏览器完整受邀旅程、P1 一次凭证/逐用户竞态/持久限流及旧安装副本升级未执行：P1 未获实施授权，外部授权配置缺项见 [PRD](../../../docs/prd/04-acceptance-open-questions.md#受邀账户外部前置112) 和 [外部取证](../../../docs/verification/invited-account-external-prerequisites-2026-11-03.md)。现有集成绿色不替代这些新增行为的验收。
- `test:scheduler` 未另重复本地执行：本 PR 不修改调度运行代码；完整 `test:integration` 已涵盖 D9 四个文件，精确提交的 scheduler-fault CI 单列。后续 P1 新账户许可门仍须两种提交顺序的真实竞争证明。
