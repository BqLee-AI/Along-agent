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
- 确定性扫描回归位于 `scripts/test/scripts.test.ts`；真实 PG16 升级烟测沿用 `scripts/local/database-smoke.mjs`，通过 stdin JSON 的 `connectionString` 显式注入一次性管理连接，不放入 argv、环境或仓库。该入口保留原 `0016`/`0017` 场景，覆盖 `0017→0018`、事实保留、重复升级、两次零 DDL 重启、缺失/错序/错误谓词/无效索引及伪版本拒绝，并保留连接失败不当空库；新增 run_id 索引缺失、错键、错误唯一性、错表、无效和未就绪拒绝，比较索引 catalog/定义及非空历史事实不变，不只确认返回拒绝。无效索引夹具仅在本次新建随机数据库内修改 `pg_index`，管理账号需具备相应 catalog 更新权限。三索引与四索引状态的运行结果分别取证，四索引 EXPLAIN 与生命周期验证见[2026-10-28 验证记录](../../docs/conversation-history-verification-2026-10-28.md)。
