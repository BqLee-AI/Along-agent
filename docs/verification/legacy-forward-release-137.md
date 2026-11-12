# #137 历史等待与前向发布验证

## 范围与责任

本阶段集成负责人验证旧协议、隔离 PostgreSQL 数据、目标 Linux 制品、受管升级及隔离 Web 历史读取，并核对指定原安装的配置与运行容器绑定。真实原安装升级、真实 provider 和其真实资料效果仍未覆盖；本记录不是发布批准。

## 协议与恢复

- 旧源码 `76f8b78bd334e025fc98b6c75cf4d9c7bb7b19ed` 经其 Dockerfile 的 `harness-artifact` 阶段重建 v5 native，二进制 SHA-256 `ce580258c3f9985e8c876903972fda497a7d5fefc05c3939e6817a734219a320`。隔离无网络运行时，当前 schema 接受的 v6 start 令其退出 2，返回 `HARNESS_PROTOCOL_ERROR`，没有请求。相同二进制的 v5 正向控制在受控模型帧下完成 measure_context、model、answer、model_next、snapshot、finish，退出 0。重建制品不证明原安装当时的二进制身份。
- 更正此前的镜像归属：2026-11-11 离线检查的 image `sha256:74f49735a750d4d07f318e7e273b95769309a47dca76db487b2271dae15a91e5` 及其 native SHA-256 `7227e4018585fe83054da15eb050b095c179fadf5a437eec503263d66969825b` 不能归属于用户指定的原安装，不作为其制品证据。对指定受管配置和 Docker 运行元数据的只读核对显示，原安装 `22305cdc-24d5-4e05-9d6c-a4173d265c62` 的 API 容器当前绑定 image `sha256:18b65c50b87a648e7943d8ba6b63808a956152200041ec4917f86bee02191251`；配置中的安装及项目与 API、PostgreSQL 容器标签一致，配置的资料卷与数据库卷分别匹配运行容器挂载。该核对未启动服务，不证明历史二进制或升级后配套版本。
- 历史源码 `36193aa265a63cf6523aa8fceaaf018a89d9c3d4` 的 TS 和重建 native 在隔离 PG16 实际写出 `harness/v1` snapshot 1 的 `propose_task` 等待，无 workspace grant；不是将 snapshot 2 改写为 1。目标 `cd6af58d39cf8e5b220943084d89093a20ecaed3` 由 0016 前向迁移至 0027；比较的 Run 字段为 ID、会话、状态、三个等待引用、allowlist、冻结上下文与预算，并非完整旧行；checkpoint、invocation、approval 和 attempt 的完整旧字段保持，迁移后无恢复。测试用户显式准入并以原展示 hash/正文确认后，目标 TS/native 经受控模型恢复原 Run，得到一个由原批准创建的 task，Run `done`、两个 attempt、一条恢复记录；原 checkpoint、invocation、allowlist、冻结上下文及预算不变，原工具未重调。
- 该 snapshot 1 的累计 usage 原为 1 iteration、5 tokens，恢复时模型剩余预算 7995 tokens；新 snapshot 2 为 2 iterations、12 tokens，消息/工具引用和 `next_call_no=2` 不变，原 snapshot 1 保持原样。旧 native SHA-256 `bccb44325376f79160821ef03a42d7c56999e79bb856e84b1d90a0bb2fd1085b`，目标 native 为 `b36fe06c46ea3856f4c9a12731a6127f4c60ec2505e9615fd7ade5f63ec9b660`。此为隔离测试账户与受控模型，不证明原安装或真实 provider。
- 补核模板和接受结果的实际边界：task 展示模板是按批准行的冻结字段及 `presentation_version` 重建的代码，并非独立持久对象；上述 snapshot 1 样本的原批准 version/hash 和已完成调用 `accepted_result` 非空，迁移比较覆盖批准及调用的完整旧行，目标实际读取原确认正文并恢复。document 批准另持久化 version/hash、完整 preview、grant 及内容版本；上述 snapshot 2 样本在正式受管数据库迁移前后比较完整批准与所查询调用等事实，目标读取原 preview/hash 并经明确测试批准后写入和回读。历史与目标的 document 展示构造函数相同，但不声称整个文件相同。这是复核既有隔离实验，不是新一次运行，也不穷举模板分支、accepted result 类型或 grant。
- 未知冻结工具先观察到错误恢复，修复后拒绝而不裁剪 allowlist；迭代或 token 预算耗尽时先观察到 `can_resume` 错误为 true，修复后不分配 attempt。损坏的历史 snapshot 保持只读可见，不具恢复资格。这些是隔离 PG 行为测试；环境配置或缺失导出错误不算行为 Red。
- 使用旧源码在任务自有 PG16 中创建正式账户及真实旧写者产生的待批准 Run。目标 Linux x64/Bun 1.4.2 制品在迁移前报告兼容；受管数据库组件取得部署许可后将 0020 前向迁移至 0027。迁移前后比较 Run（排除新加空列）、attempt、checkpoint、工具调用和批准的完整行摘要，全部相同，恢复记录为零；目标制品迁移后仍报告兼容。
- 仅在隔离测试账户，通过真实批准用例确认该测试批准，再经目标 TS 和生产 native、受控模型继续原 Run：最终 `done`，两个 attempt、一个恢复记录，原 allowlist 和冻结上下文不变。另一次隔离拒绝旅程保持原 allowlist 和上下文，并按 `APPROVAL_rejected` 终结为 failed。它们均不是原账户操作，也不证明真实 provider 的结果。
- 另一隔离旧库没有将两位测试 owner 绑定为原管理员；清点按 0024 身份迁移后资格将两个等待标为 `FORBIDDEN`，不将缺失的身份准入当兼容。首次用旧数据库验证时发现目标读取器依赖新身份表；修复后使用仅本数据库连接可见的临时视图预测原管理员准入，连接结束即销毁，不改变存储事实。实际迁移后再次清点，不用预测替代迁移结果。
- 使用与受管入口相同的 Compose 配置和目标镜像运行一次性清点容器，隔离旧库的两个不可适配等待均被识别。容器样本不等于完整 `local:upgrade` 运行，也不证明停写、备份和失败后的处理已端到端验证。
- 在另一隔离旧写者数据库完成同一迁移后，使用实际 Next Web、目标 API 和测试账户登录并打开历史会话；页面展示原提醒、冻结时间与确认正文、待确认状态，禁止另发消息绕过等待。只读验证未点击确认，也不证明 Web 恢复或实际通知。
- 随后在同一任务自有旧库上，head `cd6af58d39cf8e5b220943084d89093a20ecaed3` 的真实 Next Web 点击“确认创建并继续”，原批准 `pending→consumed`，task/event/outbox 各从 0 到 1。首次自动继续因隔离 API 模型名与原冻结上下文不符返回 `503 HARNESS_UNAVAILABLE`；页面显示已确认、提醒已保存并允许继续，不谎报运行完成。将测试 API 的模型名设回原冻结值后，在页面点击“继续此运行”，目标 Linux native 经受控模型完成原 Run：attempt 1→2、resume 0→1，原 allowlist/冻结上下文哈希不变，未再创建 task。测试使用注入的隔离会话，不验证登录或真实 provider；未启动 worker，不证明排期或通知。
- 在另一隔离 PG16，旧 TS/native 基于单 grant 和真实文件生成文档批准等待；0020→0027 前后原 Run、attempt、checkpoint、工具调用、批准和策略事实相同。对隔离合成用户以正式本机维护显式准入后，目标制品清点兼容；使用原展示 hash 明确批准，经目标 native 应用并通过 MCP 回读验证，最终 `done`、效果 `verified`，原冻结上下文、allowlist 和等待 snapshot 不变。受控模型并非真实 provider。另一隔离目录的旧 grant 使用超出安全整数范围的舍入 inode，目标精确身份不匹配，清点返回 `PERMISSION_DENIED`，没有批准或写入；不将成功推广为所有旧 grant 可恢复。
- 另由真实旧 TS/native 在任务自有 PG 和文件上生成单 grant snapshot 2 文档等待，正式迁移 0020→0027 前后比较原 Run、attempt、4 个 checkpoint、2 个 invocation、批准及策略相同；对合成 owner 正式准入，清点兼容并以原正文/hash 明确确认。目标 image `sha256:e81f06c262fa923b3d08e33cf3578e5a92f31823fd9a91ac7c2948b803883954` 的恢复、workspace 和 document-actions 源码与 `cd6af58` 对应文件一致，native 为 `b36fe06c46ea3856f4c9a12731a6127f4c60ec2505e9615fd7ade5f63ec9b660`。
- 两个不同幂等键的目标 `resumeConversationRun` 真正重叠：隔离事务持旧 attempt 锁时，PG 同时观察到两个独立后端等锁；释放后一个取得恢复上下文，另一个函数返回 409 状态冲突（未经 HTTP 网络层）。受控模型经目标 native 提出文件应用及新读取，最终一条恢复账、一条批准决定、一条成功 `workspace_apply_replace` 调用，MCP 独立回读验证真实目标文件，Run `done`；原 snapshot、allowlist、grant 和冻结上下文不变，预算上限不变，usage 从 2 iterations/10 tokens 累计到 5/25。只证明该样本一个已接受成功调用及回读，未以系统调用跟踪证明所有故障下物理写入恰一次；不是原安装或真实 provider。
- 独立受管安装复用真实旧写者产生的两个旧等待：首次 `local:upgrade` 在 0020 清点均为 `FORBIDDEN`，阻断并停写。第一次经 TTY 明确选择和确认一个 Run 后备份、迁移到 0027，产生真实 `thread.cancelled` 和取消账回执；另一 Run 的行摘要不变，仍阻断升级且只运行 PostgreSQL。第二次独立确认另一个等待后，产生其停止事件和回执，清点为空，受管升级完成并启动配套目标 API/Web。两份原批准始终为 pending、行摘要不变，恢复记录为零。首次和第二次使用不同目标源码摘要，最终目标摘要 `0f0440a4cf8cbf2970bdc6098a5b3bfb7316b83e1f32fe7d7b980ee9337e61a1` 与验证时工作区相同；这是隔离安装，不是原安装。备份包含数据库 dump、资料归档及完整标记。停止私有回执文件只保留最近一次，之前的停止仍有数据库事件和取消账。
- 同一任务自有受管安装在 0027、已有两条目标版本取消账和两份仍 pending 的批准时，使用目标源码摘要 `0f0440a4cf8cbf2970bdc6098a5b3bfb7316b83e1f32fe7d7b980ee9337e61a1`、API image `sha256:e81f06c262fa923b3d08e33cf3578e5a92f31823fd9a91ac7c2948b803883954` 与实际 native SHA-256 `b36fe06c46ea3856f4c9a12731a6127f4c60ec2505e9615fd7ade5f63ec9b660`，人为占用隔离 Web 端口。正式 `local:upgrade` 返回 `PORT_IN_USE`，停在 `starting` 且 API 停止；普通 `local:start` 返回 `UPGRADE_INCOMPLETE`。释放任务自有监听后重新执行 `local:upgrade`，目标服务启动并记为 `complete`，没有启动旧写者。
- 该前向修复的故障前、失败后、修复后，迁移账本、Run、批准、取消账和恢复记录的全行聚合摘要和行数均不变，依次为 16、3、2、2、0 行；测试结束使用受管入口停止隔离安装，保留卷和证据。这是人为注入的启动冲突，不是原安装故障、迁移中断或真实 provider；未比较其他表、资料文件摘要或单独核对 Web build 身份。详细证据保存在任务自有实验记录。
- 另一任务自有 PG16 由真实旧 TS/native 写出 snapshot 1 等待和非空 accepted result 后停旧写者，沿原版 SQL 到达 0016。目标 `dafc432` 的正式 `DeploymentDatabase` 在部署许可下使 0017–0020 实际提交；人为持有 Run 表锁，使 0021 的 ALTER 等锁，并确认迁移会话持迁移账锁后取消该会话。组件返回 `migration_failed_reconcile_before_retry`；失败后账本止于 0020，目标列不存在。取消发生在 0021 首条 DDL 获锁前，不证明已执行部分 DDL 的回滚。
- 解除该隔离锁并重取部署许可后，正式组件从 0020 前向迁移至 0027 并报告 `target_schema_verified`；此前已提交账行及时间戳保持，故障前后与修复后的 Run、attempt、checkpoint、invocation、approval、conversation、message 旧字段全行摘要一致，恢复为零、批准仍 pending。Run 排除迁移新增的两个字段。此为数据库组件与人为故障注入，未运行完整 `local:upgrade`、备份、目标 API/Web 或真实 provider，不证明原安装发布。
- 第二个隔离数据库进一步在 0021 第一条 `ALTER TABLE` 的 `ddl_command_end` 人为注入错误；隔离 PG 日志确认新增列已在该事务内可见后触发异常。正式组件报 `migration_failed_reconcile_before_retry`，随后目标列和 0021 账行均不存在，证明该次已执行 DDL 的事务回滚。撤除仅用于实验的触发器后以正式组件重取许可，从 0020 前向完成 0027；已提交账行、时间戳及所测旧事实摘要不变，原测试批准仍 pending、恢复零次。该场景没有修改迁移文件或启动旧写者，不是进程强杀、完整受管升级或原安装故障。
- 逐项停止使用探索既有公开取消事务的策略，而非测试先行；定向 PG 回归验证等待引用不匹配时拒绝、只停止所选 Run、另一等待不变、两份批准仍 pending、保存取消事件和幂等账。实际受管旅程另验证 CLI、备份和部署流程，不以该测试代替用户路径。
- head `e1791eb75476863ba4d1b4ccc42501b3892e19b1` 的 Linux x64、Bun 1.4.2 目标容器执行 `bun run verify`，十步全部通过；隔离 PG16 的 `bun run test:integration` 为 610 pass、`bun run test:scheduler` 为 32 pass，均零失败。WSL Linux `bun run test:contracts` 重建生产 native，277 pass、0 fail，D8 和 10 项可执行门通过。后续维护入口改动须另行验证。
- 后续停止入口代码的 Linux x64/Bun 1.4.2 验证：`bun run verify` 十步通过（unit 813 pass、85 skip、0 fail）；隔离 PG16 `bun run test:integration` 611 pass、0 fail，`bun run test:scheduler` 32 pass、0 fail；WSL Linux `bun run test:contracts` 重建生产 native，277 pass、0 fail，D8 与十项可执行门通过。首次在受管构建快照内运行完整 `verify` 因快照不含 `.gitignore` 而扫描依赖失败；干净源码构建的首次完整验证因文档尚未格式化在最后一步失败，格式化后完整重跑通过。
- 第 3.2 节补充核对：`elapsed-zone-followup.test.ts` 在 head `cd6af58d39cf8e5b220943084d89093a20ecaed3`、任务自有 PG16.15、Bun 1.4.4 下 7 pass、0 fail，执行 TS gateway 的真实预约和调用；合成可信上下文下，规则不可用时显式时区拒绝且零 task/event/outbox，非显式时区可用 UTC，合法显式时区保持锚加 180 秒。不涉及 Web/native/provider 或自然通知。
- 在确认受管配置与目标 API/PG 容器、数据库连接及挂载匹配后，集成负责人经已运行的目标 PostgreSQL 容器建立单独连接，只在 `REPEATABLE READ READ ONLY` 事务中执行静态系统目录检查与聚合；事务实际设置经 SQL 检查为只读且隔离级别正确，检查普通表、无 RLS、无继承子表及列类型后才读取。2026-11-11 的事务快照中，`harness` 的 `suspended_approval` Run 有 3 条三个等待引用均非空、0 条至少一个引用为空；没有输出 Run ID、批准内容或个人信息。
- 该统计只检查引用非空形态，不验证引用是否存在或一致、批准状态、预算、快照、grant、资格或能否恢复，也不等于产品发布预检。目标 API/PG 当时已运行，计数仅适用于该事务快照，停写后发布前仍须重新清点；未消费或停止 pending。SQL 使用现有账户，另一个只读事务核实该角色具有 superuser 权限；清点只执行经审阅的静态 SELECT/只读事务控制，不创建临时视图或对象，这不是将该账户变成只读角色。隔离 PG 实测同样只读事务拒绝具有 INSERT 权限的写入（SQLSTATE `25006`），错误隔离级别、RLS、继承子表及缺列均拒绝统计；普通 SELECT 仍可能引起数据库内部统计或页面提示位变化，不能声称物理介质零写。完整 `inspectReleaseWaiting` 可能在事务外创建临时视图并返回逐 Run 数据，未在原库调用。
- 另一只读 `REPEATABLE READ` 快照采用经隔离夹具验证的静态七表关联和聚合；七表的普通表/主键/列类型、RLS 和继承关系检查通过，结果没有逐行标识或个人内容。三条均为 snapshot 2、快照等待引用与 Run 引用匹配、列出的消息和工具引用存在于限定作用域、等待调用的批准引用匹配；三条快照记录的 usage 均未达到对应预算。关联批准的**存储状态**分别为 1 条 document pending、1 条 task consumed、1 条 task superseded。这些是独立维度统计，不公布各维度之间的行级对应；它们不是完整快照验证、实时有效期或恢复资格判断。
- 扩展查询在隔离 PG 的合成数据中覆盖 snapshot 1/2/其他、引用缺失/错配及跨 owner、task/document 存储状态和预算耗尽；不支持的表结构、RLS、继承或事务模式拒绝执行。该次原库查询与引用形态统计是两个各自一致的事务快照，运行中的写者可使它们之后过期；未调用业务函数、加行锁、创建临时对象、消费批准或启动旧写者。

## 隔离执行护栏实验

- 在仅含任务数据、tmpfs 的隔离 PG16（head `cd6af58d39cf8e5b220943084d89093a20ecaed3`）实测可逆防护候选：非 owner、非 superuser 的 SELECT-only 角色可直接读用户偏好，但对用户表 UPDATE 及有效预约的 `set_user_timezone` 直接 `invokeTool` 均返回权限错误、时区不变；恢复管理员连接后同一预约真实写入。17 个工具 ID 与未知 ID 的直接派发探针均在公共 `run_attempts` 门遇到权限错误，但使用合成 invocation 和空参数，不证明各工具的有效调用均已防住。
- 同一隔离库以真实 worker tick 验证六个 scheduler phase 遇权限错误，任务保持 `saved`、无回执；恢复管理员连接后变为 `scheduled` 并产生回执。独立隔离 `server-owned` Run 经实际 `ROLE=api` 启动：受限连接保持 `running/running`，管理员连接则触发恢复扫描并变为 `failed/fenced_out`。受限 API `/healthz` 为 200、`/readyz` 因 TZDB 不可用为 503；identity-mail 不在该验证范围。
- 另在以 root 运行的隔离容器上验证 `--read-only` 根文件系统：产品 `publishWorkspaceCreate` 在真实 PG advisory lock 下返回零写，目标文件不存在；撤销只读后同路径真实创建并回读。该实验不是原安装的 workspace 只读挂载。受限 DB 角色同时阻断合法工具读取，不能构成可用的完整护栏；其他连接、可写挂载、已派发的网络操作和宿主进程均未覆盖。这些均为隔离实验，未为实验启动原安装或连接原库。
- 第二种候选在隔离库中给非 owner API 角色运行态读写及业务表行锁所需权限，对 21 个指定业务/身份表加 owner 控制、可启停的写阻断触发器。真实预约的 `get_user_prefs` 成功，运行账实际增加；启用时有效 `set_user_timezone` 被 `P0001` 阻断、时区不变，禁用后同一预约真实写入，再启用后另一有效预约再次阻断。隔离 pending 的 UPDATE 也被阻断并保持 pending；该角色无 TRUNCATE 权限且不能禁用触发器。
  覆盖表为 `users`、`auth_accounts`、`sessions`、`approvals`、`approval_revision_requests`、`document_approvals`、`document_approval_decisions`、`tasks`、`task_events`、`outbox`、`notifications`、`task_leases`、`security_events`、`installation_admin`、`identity_invitations`、`identity_account_admissions`、`identity_contacts`、`identity_challenges`、`identity_mail_deliveries`、`identity_action_keys`、`identity_rate_limits`；该清单不是已证实覆盖全部业务写路径。
- 对同一候选，真实 worker tick 在启用时被 tasks 触发器阻断并保留 `saved`，禁用后同一任务实际进入 `scheduled`，再启用后另一任务保持 `saved`。但真实 run-driver 扫描仍将隔离 `server-owned` Run 从 `running/running` 改为 `failed/fenced_out`：业务表护栏不保护运行历史，不能启动原 API 并据此声称安全。原受管 Compose 以同一数据库账户作为 PostgreSQL 初始用户和 API 连接；它具有初始管理员权限，实验的非 owner 角色及触发器不能直接套用。owner/superuser、其他连接、有效全部工具派发、identity-mail、真实 workspace 挂载和在途效果仍需覆盖；部署到原库也会改变数据库对象。没有在原库安装这些触发器或发起原账户 provider 请求。
- 对触发器的绕过正反例：受限角色设置 `session_replication_role=replica` 被权限拒绝；隔离 superuser 在事务内设置后可绕过普通触发器更新 users，随后回滚。故这类触发器不能作为 superuser 的独立安全边界；换受限角色、控制全部连接及约束 driver 后仍须重新验证。
- 隔离触发器逐表启停并非原子操作；还会阻断会话、准入、邀请和身份邮件等正常写入。若要复用该思路，必须先证明所有连接切换及 driver 隔离、启停期间无写窗口、保留所需登录路径，再以有效参数覆盖所有实际派发与真实 workspace 挂载；仅将触发器加到原库既不满足这些条件，也会改变原库对象。

## 2.8 与第 3 节的边界

- 2.8 的旧协议、受限恢复和前向发布由上述隔离证据逐项支持；其中 snapshot 1 旧批准的完整旧行包含非空 presentation version/hash，旧 completed invocation 含非空 accepted result，迁移比较了这两行的全部旧字段。这只证明所测样本，不推广到全部模板与历史结果；隔离受管升级也不能代替原安装实际发布。
- #137 要求在隔离旧版真实数据和正式构件上验证升级、恢复与前向修复。上述旅程覆盖旧数据升级、受控恢复、启动冲突前向修复和迁移 DDL 后的人为失败回滚及组件前向重试；不证明进程强杀或所有失败的修复。实际发布须遵守 design/20 §9 的安装归属、旧运行清点、停写、配套制品和身份核验，不回退不理解新事实的写者。
- 第 3 节独立核对整体行为；3.5 要求在已有产品安装完成真实混合目标，其原账户完整写护栏和真实 provider 旅程缺口不是 2.8 文字合同的附加门槛。2.8 已按受测合同勾选，不因其通过代替第 3 节的未验证项。

### #137 验收对照

1. **冻结权限与不兼容等待**：旧 task/document 样本保留原 allowlist、grant、批准、快照引用与累计预算；未知工具、耗尽预算和不匹配 grant 阻断而不扩权。隔离受管安装通过逐项明确确认停止不兼容等待，未自动消费批准。
2. **协议与配套**：重建 v5 native 拒绝 v6，v5 正向控制通过；目标 TS/native 和真实 Web 的隔离旧等待继续有对应证据。旧历史可读并不保证每个等待可恢复；旧制品重建身份不代表原安装身份。
3. **历史事实与重复恢复**：旧 task 的非空版本/hash、accepted result 及旧 document 的版本/hash/preview 随所测旧行保留；单 grant 文档等待经迁移后，两个重叠恢复只有一个接纳并产生一个成功应用调用及回读。样本不穷举模板、结果、grant 或故障。
4. **前向发布与修复**：任务自有隔离安装使用真实旧写者数据和目标制品完成受管备份、迁移、停止与启动；另有真实 Web、数据库和文件证据。人为启动故障通过正式受管升级恢复，DDL 后人为迁移故障经正式数据库组件回滚并前向重试；后者并非完整受管升级或进程强杀。
5. **第 3 节及剩余风险**：[证据矩阵](assistant-delegation-104-evidence-matrix.md)分别映射 3.1–3.6；真实安装混合目标、护栏和整体验收仍缺。隔离样本不替代目标安装停写后的完整资格检查与制品身份核验。

## 仍未覆盖

- 真实安装的完整等待资格清点和受管升级、升级后配套制品验证仍缺；上述引用形态统计不能代替它们。目标原 API 和 PostgreSQL 在核对时已运行；启动或重启可能推进旧提醒，不能把隔离 PG 升级当成无副作用证明。
- 不兼容等待的逐项受管停止与前向升级已在隔离安装验证；原安装中的等待只能由有权用户明确选择处置，本次没有替用户确认或停止。
- snapshot 1 文档批准组合不是验收要求：design/20 §9、design/09 §3 和 `readSnapshot` 将 snapshot 1 限于无 workspace grant、已完成的旧业务/task 引用，不含 document 批准；旧文档批准按 snapshot 2 的原合同验证。上述合法 snapshot 1 旧业务恢复已在隔离旧写者及目标 native 验证，不代表原安装中所有旧等待可恢复。
- 原账户真实 provider 的独立执行层全写工具护栏尚未建立及正反验证，不发送可能写入原账户的请求；自然通知、Web 和文件的本次真实混合目标仍缺。
- 原安装护栏评估：过滤 native 的工具集合可约束模型工具调用，但不覆盖后台 scheduler 和 API 启动时的 run-driver 恢复写入。要安全运行原账户真实目标，仍须独立限制数据库业务写、工作区文件和后台服务，并对实际派发与效果做正反验证；当前未建立该完整护栏，也未启动原安装进行此项测试。
- 2.8 的隔离验收证据不等于 #104 第 3 节整体完成；既有切片证据与缺口见 [证据矩阵](assistant-delegation-104-evidence-matrix.md)。
