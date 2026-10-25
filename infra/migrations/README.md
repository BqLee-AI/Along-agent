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
