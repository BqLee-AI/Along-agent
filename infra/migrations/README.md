# infra/migrations

编号为`<seq>_<group>_*.sql`，已合并SQL冻结；修复新增迁移，不修改旧文件。`scripts/check-migrations.mjs`校验领域编号范围、重复编号与只追加禁写规则；实际物理布局以迁移为准。

`scripts/db/apply.sh`使用显式DATABASE_URL按序通过psql应用；验收使用新隔离库，不用清空用户数据库替代升级。0012起有`schema_migrations`版本账；0014在同事务锁账、校验0013前置，已应用0014则跳过。

## 0014：工具调用身份与结果

- tools新增`tool_invocations`，保留legacy `tool_calls`原行和只追加trigger；不从缺失结果的旧审计伪回填结果。
- `tool_calls`增加调用/request/提交种类关联，删除旧`(run_id,tool_id,args_hash)`唯一约束。唯一逻辑身份为`tool_invocations(run_id,call_key)`，相同参数新动作及重放审计均合法。
- 预约先提交；本地批准、结果与审计同事务。DB固定身份/上下文、结果一致性和合法状态，completed不可改删；非事务unknown不回reserved，不盲重发。

### 停写切换与失败处理

1. 停止旧API/工具写者及相关处理，备份并核对版本，不混跑仍使用旧ON CONFLICT约束的程序。
2. 在停写状态事务性应用0014；失败全回滚DDL/索引/版本账，保留原数据和旧约束，修复后重试。
3. schema成功后切换新程序，再恢复流量。schema变化后旧写者不再兼容；不能以旧进程能启动当作可回退证据。
4. 接受新调用后保持结果账与审计，发布失败停写并前滚修复，不删除账、重置unknown或恢复旧二进制；旧SSE仍可补读，不据旧日志重新执行。

字段与行为见[调用schema](../../docs/schema/conversation-and-runs-schema.md#tool_invocations)、[ToolGateway](../../docs/design/04-five-seams-contract.md)。新鲜库、历史0013升级、事务异常回滚与数据库拒绝非法变更由真实PG集成和SQL合同验证。

## 0015：正式 Harness 可信运行与有限等待

- agent_runs 增加冻结 execution/工具范围/启动上下文/输入引用与有效等待引用；旧行默认 business，不伪造快照。trigger 禁改接受权威与终态；harness 挂起必须具备完整等待引用。
- checkpoints 保持只追加，增加内部 harness_snapshot；读取外部流显式过滤。before-insert 先持 conversation 的 NO KEY UPDATE 锁再分配 event_seq，锁至提交，防止小游标晚提交漏读且与终态消息的外键 KEY SHARE 兼容；游标间隙合法。
- harness_resumes / harness_cancellations 保存最小只追加动作身份；同等待 checkpoint、恢复 attempt 唯一，不复制工具结果账。实际 owner/Run/决议/最新 attempt 由公共运行用例验证。
- 停止旧运行写者后事务应用0015，失败保留原 schema/version；成功切同次构建 TS/native 产物再接流量。接纳新事实后前滚修复，不回退混合执行器、不删除调用/动作事实或恢复旧 pipe。
- 历史业务与事件可读；仅最后有效批准等待点支持显式 resume。任意 checkpoint、无人值守崩溃恢复及通用外部 exactly-once 不在该迁移保证内。

字段与路由见[运行 schema](../../docs/schema/conversation-and-runs-schema.md)、[Harness 设计](../../docs/design/09-agent-runtime-and-checkpoint.md)、[运行说明](../../apps/harness/README.md)。新鲜库、0014 升级、重复执行及 DDL 故障回滚由真实 PG 合同覆盖。

## 0018：本人会话历史 keyset 与旧原话回退索引

- 仅新增四个非唯一普通 B-tree 索引：`conversations_owner_history_idx` 对应 `(owner_id, created_at DESC, id DESC)`；`messages_owner_conversation_history_idx` 对应 `(owner_id, conversation_id, created_at, id) WHERE role IN ('user', 'assistant')`；`agent_runs_owner_conversation_history_idx` 对应 `(owner_id, conversation_id, created_at, id)`；`conversation_idempotency_run_id_idx` 对应 `conversation_idempotency(run_id)`。最后一个支撑旧 Run 缺少 `input_message_id` 的回退查找，保留全部同 Run 引用供既有 scope/歧义检测，不新增唯一性要求或更改读取语义。
- 不新增表、原话关联或历史副本，不修改 owner、消息、Run 或旧 baseline 对象。四个索引与 `0018` 版本账同事务提交；要求已存在 `0017`，已记账的迁移不重复应用。`0001`–`0017` 保持不变。
- 使用原显式 `bun --no-env-file run local:upgrade` 停旧写者、备份并升级至 `0018`，同批部署 API/Web/contracts。普通启动只核验，不从 `0017` 自动迁移；失败保持停写，按原版本分类与显式修复流程处理，不删卷/账本或降版。
- `scripts/check-migrations.mjs` 仅放行 `0018_conversation_history.sql`，不扩大 conversation 领域编号范围。`scripts/local/baselines/0018.sql` 使用现有 SQL verifier 扩展，在只读事务内验证版本账和 `pg_catalog` 中四个实际索引的表/列顺序、非唯一性、方向与 NULL 排序、普通 B-tree 属性、谓词、有效/就绪/存活状态、默认 operator class 与 collation；保留原 `0016`、`0017` 核验。
- 确定性扫描回归位于 `scripts/test/scripts.test.ts`；真实 PG16 升级烟测沿用 `scripts/local/database-smoke.mjs`，通过 stdin JSON 的 `connectionString` 显式注入一次性管理连接，不放入 argv、环境或仓库。该入口保留原 `0016`/`0017` 场景，覆盖 `0017→0018`、事实保留、重复升级、两次零 DDL 重启、缺失/错序/错误谓词/无效索引及伪版本拒绝，并保留连接失败不当空库；新增 run_id 索引缺失、错键、错误唯一性、错表、无效和未就绪拒绝，比较索引 catalog/定义及非空历史事实不变，不只确认返回拒绝。无效索引夹具仅在本次新建随机数据库内修改 `pg_index`，管理账号需具备相应 catalog 更新权限。三索引与四索引状态的运行结果分别取证，四索引 EXPLAIN 与生命周期验证见[2026-10-28 验证记录](../../docs/verification/conversation-history-verification-2026-10-28.md)。

## 0019：R2-A 不可变 Run 上下文策略

- 新增 conversations 所有的 `run_context_policies(run_id PK, owner_id, policy, policy_hash, created_at)`；不改旧迁移、旧 Run、完整输入、冻结历史引用、预算或 allowlist。数据库校验 strict policy 的版本、字段、整数/枚举/null 语义，插入 trigger 验证 owner 与 harness Run 一致；UPDATE/DELETE 一律拒绝。PK 已服务恢复点查，不另建无查询依据的索引。
- 新 harness Run 在原接纳事务插入策略；旧 Run 仅在有效显式批准恢复与唯一新 attempt 的同一事务 `ensure` 一次。并发只保留首个已提交值，恢复或接纳失败不留下策略。business、GET、历史补读与同入站重放不补录、不授新工具。63＋1 历史引用在接纳时冻结，完整消息按原引用读取，后续消息不混入。
- `policy_hash` 为 `SHA-256(UTF8("harness/context-policy/v1\\0" + canonical_json))` 的64位小写十六进制；域末尾为实际 NUL。规范 JSON 对所有 policy 字段及嵌套 `model_binding` 使用字典序键、无格式空格，字符串不做 Unicode/空白归一化。应用 strict 解析并核验摘要，DB 固定摘要格式与行不可变性；不能用部署新值覆盖原策略。
- 停旧写者、备份后通过原显式 `local:upgrade` 升级至0019，再同批发布 harness/v4 TS/native 消费者。事务失败保持0018原事实，修复后重试；接纳新事实后停写并前滚，不删策略或接受结果兼容旧二进制。
- `scripts/local/baselines/0019-checks.json` 延续原增量只读核验，检查真实列、PK/FK/check、函数原文/属性、owner与禁改trigger；无版本对象、伪版本、禁用/缺失trigger、弱化validator或错误FK均拒绝，不自动修复。扫描只放行精确文件名 `0019_conversation_context_policies.sql`。生命周期烟测保留0016/0017/0018固定目录，新增0018→0019事实保留、零策略回填、两次零DDL重启及损坏拒绝场景；集成测试覆盖并发唯一、回滚、只读零写与63＋1完整冻结。新增检查尚须主线程统一执行，不将测试存在视为已通过。

## 0021/0022：可信委托目标结果

- 0021 在 `agent_runs` 增加可空 `goal_result`，不回填历史 Run、消息、批准或接受结果。非空结果只属于冻结 `delegation/1` 的终态 Run；目标内容、成功回执归属与完整性由 conversations 验证，不以 Run 终态替代目标结果。
- 0022 前向替换结果 CHECK，要求条件 `IS TRUE`，避免缺少授权修订或目标状态时 SQL NULL 被 CHECK 放过；0021 已应用也不回改旧迁移。缺字段、JSON null、非终态和错误修订均不能取得非空结果资格。
- 原显式 `local:upgrade` 支持已核实0016–0021升级至0022；原目录/账本与只读 baseline 核验保留，历史事实不迁写，漂移仍拒绝。版本账、DDL与新约束同事务提交，失败停写，不删除既成结果或降版。
- API/native/shared/Web 配套使用 `harness/v6`、snapshot2和新委托 SSE v2，legacy保持冻结范围与严格v1历史。真实 PG 生命周期覆盖逐版本升级、零回填、重启及NULL边界；偏好领域写入、接受结果与审计原子性由工具集成覆盖。

## 0023：直接创建提醒的真实来源

- 新增 `tasks.source_invocation_id`，外键引用 `tool_invocations(invocation_id)`、非空值唯一且 `ON DELETE RESTRICT`。旧 `source_approval_id` 继续可空、保留原有逻辑引用；不伪造批准、不回填或修改旧批准、任务、时间快照与接受结果。
- `tasks_source_xor_check` 禁止双来源；`tasks_creation_source_required` 在新 INSERT 或显式更新来源列时要求恰好一个来源，并以同名 CHECK 错误拒绝全空。历史无来源行是原 schema 允许的未知来源，不修造来源；读取与仅更新状态/回执仍可正常进行，不能将未知历史当作新的直接创建回执。
- `tasks/create.ts` 的公共事务用例由 legacy confirm 和直接工具共用，原子写入 saved task、created 事件及 schedule outbox；工具接受结果/审计或旧批准 consumed 由调用方在同一事务提交。写入前后均按数据库实时钟验证冻结触发时刻仍在未来，过窗错误必须逃出外层事务，不重新归一或部分提交。
- 先停旧写者并备份，显式升级 `0022→0023` 后再部署配套 API/Web；DDL、约束、触发器与版本账同事务提交，失败保留0022原事实。重复执行已记账0023不再做DDL。新接受结果产生后仅停写前滚，不删来源/任务/事件/审计或降级旧写者；旧有效 pending 仍只由原确认门消费。
- 专用真实 PG 消费者覆盖位于 `apps/api/test/integration/task-creation.test.ts`；legacy owner/hash/过期/consumed 重放继续由 `approvals-confirm.test.ts` 保护。测试代码存在不表示已执行或升级已验收。

## 0024：受邀账户显式准入

- 在完整0023基线上事务性新增 `identity_account_admissions`、`identity_contacts`、`identity_invitations`、`identity_challenges`、`identity_mail_deliveries`、`identity_action_keys`、`identity_rate_limits`。摘要固定32字节，AEAD nonce/tag固定12/16字节，加密组全有或全空；联系人密钥版本必填，pending邀请地址必填，challenge用途/绑定/revision互斥。邀请pending地址partial UNIQUE不使用时钟；凭证用途/代次、联系人owner/地址、动作幂等键及固定配额窗口由唯一约束兜底。字段合同见 [identity schema](../../docs/schema/identity-schema.md)。
- 新增 `auth_accounts_user_id_key UNIQUE(user_id)` 前持原identity表锁，拒绝旧重复credential、错误provider/account_id、空/损坏哈希、带密码seed及缺可用credential的管理员绑定。非空哈希格式按锁定Better Auth的32位hex盐与128位hex scrypt结果预检；不以格式检查替代本人密码验证。异常整笔回滚DDL和版本账，原user/credential/session/业务owner/secret不改，不自动删行、合并或修复。
- 只从原明确 `installation_admin` 插入一条准入；普通active历史用户不自动获准，disabled/deleted_requested状态不变。普通旧owner须经 `local:account --admit` 明确选择并验证本人原口令（非空哈希不覆盖），或在合法无密码原身份上显式设密；工作区另经 `--workspace` 维护。迁移不发邮件、不生成生产密钥、不改宿主配置。
- 停旧API/worker/Web写者、核实备份后走原显式 `local:upgrade`；普通 `start` 仅核验，不隐式升级。DDL/预检失败保持停写并保留原事实，修复来源后显式前滚。新准入/邮件事实写入后禁止降回不理解它们的旧写者，不删版本账/准入/邮件记录恢复旧版。
- `0024-checks.json` 合并主线0023结构事实与账户新表的列/类型/默认值、PK/FK/UNIQUE/CHECK及索引；原0016–0023核验继续有效。账户事实源于此前隔离PG16 catalog，合并后的基线尚须统一验证。核验包含新credential唯一索引、partial谓词、索引方向/null顺序、valid/ready/live；损坏只读拒绝，不自动修复。`local-invited-database.test.ts` 覆盖旧0023隔离副本升级、准入数量/原事实保持、预检/真实DDL故障回滚、损坏拒绝及两次零DDL数据库重连；数据库重连不冒充正式Docker/API/Web两次实际启停，生产邮件/HTTPS和真实旧用户安装复制也不由该测试证明。

## 0025：严格 UTC 提醒的取消批准

- 取消批准保留目标任务真实的空 `tzdb_version`；仅同 owner、冻结时间一致的严格 UTC elapsed 目标可使用空版本。创建批准和其他取消批准仍须有原规则版本。
- 迁移不改写历史批准或 hash。确认消费、取消命令和撤销回执继续遵循原事务及状态机；升级后不应重新启用不能处理空版本的旧写者。

## 0026：两条 0024 历史收敛

- 主线 0024 为受邀账户；已部署的另一条 0024 为经过时长提醒，并已有取消批准 0025。版本号本身不足以识别来源；受管升级须完整核验相应结构，拒绝部分、混合或漂移的库。
- 0026 保留原版本行及其时间，不回填或改写任务、批准、用户和凭据。账户路径补经过时长结构；提醒路径按原账户迁移预检和管理员准入规则补账户结构。仅明确绑定的原管理员取得准入，停权状态不变。
- 必须通过受管升级入口停写、备份并核验；迁移 SQL 自身只做有限结构检查，不替代完整基线检查。升级期间禁止其他 DDL 和旧写者，失败保留原事实并按原流程前滚。
- 函数体比较仅将 CRLF 归一为 LF，其他正文及触发器属性仍按基线核验；不同换行形式的历史不构成漂移。版本账记录版本和时间而非迁移源码摘要：已执行 0026 的库不会重新执行该迁移，受管入口仍对最终结构执行完整基线核验，不能仅凭版本号证明历史 SQL 字节。

## 0029：用户安全点暂停

- `agent_runs` 支持 `paused`；`harness_pauses` 保存用户请求与安全点快照，部分唯一索引限制每个 Run 同时只有一个有效暂停。`harness_pause_resumes` 保存唯一后继 attempt 和幂等身份，只追加不改删。
- 停止旧写者并备份后通过显式 `local:upgrade` 升级至 0029，再部署配套 API、Web 和 `harness/v7`；旧 Run 与批准快照不回填。产生暂停事实后停写并前滚修复，不删除账目或退回不理解 `paused` 的旧写者。
- 迁移不声明任意崩溃恢复，取消与待处理效果按 Run 及工具事实裁决；本人暂停和批准等待是不同资格。

## 0030–0032：本人记忆与派生索引

- 0030 增加本人记忆、不可修改的修订及保存请求账本；0031 增加不可修改的召回修订回执；0032 增加可重建的向量数据，不安装数据库扩展。
- 按顺序显式升级并验证各版本基线。升级前停写并备份数据库和工作区；记忆与原消息、工具回执均为需要保留的事实。产生新版本数据后前滚修复，不以删除记忆或覆盖旧迁移实现回退。

## 0033–0036：compact 与冻结上下文

- 依赖 PR3 的 0030 本人记忆、0031 召回回执及 0032 可重建向量。0033 对应原完整实现 0031，新增 compact 冻结、来源、摘要和 head，并以前向 ALTER 扩展 0029 暂停约束：原 user/none/user 合同不变，新增 runtime/manual_compact 或 automatic_compact/runtime；不改写既有暂停或回填历史。0034 对应原 0032，新增操作账和不可变 continuation；0035 对应原 0033，新增不可变 Run 上下文；0036 对应原 0035，允许受控 compact 输入并新增不可变 idle 请求账。原 0034 向量与 0036 召回回执分别已迁至 PR3 的 0032 和 0031。
- 每个版本单独按前置版本锁账、事务提交，升级前停写并备份；先完成 PR3，再显式逐版本升级，失败停写并保留既有事实，新事实产生后只前滚。各版本 baseline 校验列、约束、索引和触发器，按版本核验旧暂停约束扩展与上下文可空变化；版本账不能代替结构核验。
- PG16 生命周期测试覆盖 0032 起逐版本升级、原暂停事实保留、无 compact 回填、合法 runtime 与非法组合、冻结上下文不可变，以及逐版本篡改拒绝。测试代码不表示已执行。

## 0037：模型上下文窗口

- 在模型表和不可变 Run 绑定表各增加可空的正整数 `context_window_tokens`；历史行保持 null，不回填或改写 Run 事实。每次新 Run 接纳时将已选模型窗口随绑定一起冻结；null 使用现有全局策略。
- 停止旧写者并备份后通过显式 `local:upgrade` 升级至 0036，再应用 0037；DDL 与版本账同事务，失败回滚，已记账时重复应用不修改数据。升级后部署配套 API 和消费者，已有 Run 的绑定不可修改。
- `0037-checks.json` 供受管部署校验新列和正数约束；受管分类同时检查已有模型表的原有对象和后续新增对象，拒绝未记账或不匹配的结构。

## 0038：接入默认模型

- 依赖 0037；为每个接入增加默认模型外键，将已有全局默认复制到所属接入，不改写全局默认。`0038-checks.json` 核验新增列和外键。
- 旧实验库若以 0029/0030 记录模型迁移，版本号与主线暂停和记忆迁移冲突，不是受支持的主线升级基线；不要改写版本账或主线迁移。停写并备份后，从可信主线备份恢复或新建主线库，再按需单独迁移经核验的数据；本迁移不提供旧实验库的自动转换。

## 0042：个人 Bot 与会话归属

- `personal_bots` 按 owner 保存完整配置和修订。每条会话必须绑定同 owner 的 Bot，绑定建立后不可更改。迁移发现任何旧会话时回滚，保留旧结构和全部数据。
- 停止旧 API、worker 和所有写入进程。备份并在隔离的 PostgreSQL 副本核对版本、会话、Run 与批准。通过旧系统先收尾运行中、暂停中、待批准或效果未确定的记录。保持旧进程停写直至切换完成。
- 仅对确认为可丢弃测试数据的会话执行显式维护。副本数据库名使用 `along_bot_cutover_<suffix>`，版本应为 `0041`。在同一 psql 会话中为 `along.bot_cutover_ids` 设置逐条审核后的会话 UUID 列表，然后执行 `scripts/local/clean-disposable-bot-cutover.sql`，例如：

  ```sql
  \set ON_ERROR_STOP on
  SET along.bot_cutover_ids = '<confirmed-test-conversation-uuid>,<another-confirmed-uuid>';
  \i scripts/local/clean-disposable-bot-cutover.sql
  ```

- 清理按明确 ID 和持久关联圈定会话专属记录，在事务内核对仍保留的事实及其 UUID 引用。保留的任务、事件、账户、模型、资料或记忆引用清理目标时停止并报告依赖。已有提醒效果的批准也阻止清理。若仍有旧会话，保持停写及备份并停止升级。
- 在已核对的副本上验证清理前后记录、已清理深链的不存在行为和 `0042` 升级。显式升级通过后，部署配套 Host、API 与 Web；恢复旧版本使用切换前快照。
