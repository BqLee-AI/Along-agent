## 结论与证据

Observed：`tools/gateway.ts#invokeTool` 先执行五个本地工具，再独立写 `tool_calls`；旧 `(run_id, tool_id, args_hash)` 唯一键仅吞审计冲突。`approvals/create.ts` 已接受 query client，可复用 `db/transaction.ts`，无需新事务框架。`tool_calls` 禁 UPDATE/DELETE，不改成可更新结果账。当前没有外部文件／MCP 工具；本 change 不声称已有通用 Agent 或仓颉执行端。

Required：TS 拥有调用身份、业务结果与持久事实；同参数不等于同调用；本地原子性与非事务未知是不同保证。确认消费、时间归一、取消和回执合同不变。

## 调用身份及入口

建议内部接口（不新增 HTTP 路由）：

```ts
reserveToolInvocation(pool, context, { callKey, toolId, args }): Promise<{ invocationId }>
invokeTool(pool, context, { invocationId, toolId, args }): Promise<ToolOutcome>
```

- TS 为新预约生成 UUID，以 `(run_id, call_key)` 持久定位；预约先于副作用独立提交。预约返回丢失后，同 slot 可取回原引用；invoke 不为缺失引用隐式新建。
- v0 三个互斥分支使用固定 `v0-turn/1` slot；新逻辑动作须新 slot，未来多步分配／checkpoint 接线归 #46。不能每次重交生成随机引用，也不以 tool、hash、request_id、attempt_id 定义身份。
- context 仍仅由可信 TS 同进程提供，包含 owner、conversation、run、必填 attempt、请求追踪、allowlist 与时间上下文。通过 conversations 公共用例验证真实 owner/conversation/Run/attempt 关联；不直导其他模块 repository，也不声称实现远程鉴权或 lease/fencing。
- 同 Run 跨有效 attempt 重交保留同一逻辑引用；已完成 attempt 可读历史结果，新的执行必须仍有执行资格。跨 owner/Run/attempt 借用引用不返回他人结果；同 slot 或同引用更换 tool/args 返回 STATE_CONFLICT。request_id 可变化，分别保存首次接受与本次提交关联。
- 参数摘要采用带版本 domain 的 SHA-256，递归排序对象键、保留数组序与字符串原字节，不 trim／Unicode 归一；以 schema default 之前的 JSON 比较，缺省和显式默认可保守视为不同。只落摘要和 UTF8 字节长度，不落 raw args；未知工具也计算真实摘要。
- 预约冻结首次 receivedAt、anchor、timezone、fold 与规则版本引用，未执行重交不采用新时钟；已接受结果重放不重新归一，也不要求当前规则仍可用。缺失既有规则版本时拒绝新执行，不静默替换。

## 数据所有权、状态与迁移

tools 新增 `tool_invocations`；复用 `tool_calls` 只追加提交审计，不建第二份审计真源。

| 组别 | 必要字段／不变量                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份 | invocation_id PK、owner_id、conversation_id、run_id、call_key、first_attempt_id、first_request_id；UNIQUE(run_id,call_key)                     |
| 内容 | tool_id、args_hash、args_bytes、TS 绑定的 execution_kind（local/read_only/non_transactional）、冻结时间解析上下文                              |
| 状态 | reserved → completed（本地）；reserved → unknown → completed（非事务）；unknown 绝不回 reserved                                                |
| 结果 | outcome_kind、result_version、accepted_result 安全投影或 approval_id、accepted_attempt_id、accepted_request_id、accepted_at；必要 evidence_ref |
| 索引 | owner/run/created_at；审计 invocation/created_at；所有业务访问限定 owner 与真实运行关联                                                        |

outcome_kind 是 success／approval_pending／clarification／time_error／denied／failed。审批结果仅保存 approval_id 和必要冻结校验信息，不复制正文。approved ID 不唯一：现有取消提议可复用 pending 批准，但两次逻辑调用必须分别关联。

身份／摘要／冻结上下文建后不可改；completed 结果禁止改写和删除，未知状态只能保留或由可信结果／核对证据完成。CHECK 约束拒绝状态与结果矛盾。结果大小受现有工具输出界限及安全投影约束，不保存原始参数、secret、异常栈或任意 provider 原始响应。身份和接受结果不设短 TTL 或自动键复用。

`tool_calls` 加 nullable invocation_id、request_id、record_kind 及必要结果分类关联；旧行保持 NULL/legacy，不伪回填缺失结果。新调用可追加接受、重放、拒绝或失败的提交审计；删除旧 hash 唯一约束，保留只追加 trigger 和原字段。旧 SSE 继续补读，不从旧日志重建不存在的执行结果。

新增下一号 migration（基线下一号0014，实施时核对），不改旧迁移。更新迁移扫描范围和旧 hash 唯一性 SQL 断言；新鲜库、历史升级库、失败回滚均验证。发布停旧写者、备份、事务迁移、切新代码后恢复；旧 ON CONFLICT 代码不能在删约束后混跑。开始接受新调用后不能恢复旧写者或删结果倒退，失败保持停写并前滚修复。

## 本地事务与结果分类

1. 预约提交后，业务事务锁 invocation；经 conversations 公共入口核对并锁定 Run 执行资格，与 Run 取消／终结写者串行。
2. 对已有结果只读；对未执行项重验权限／strict schema／风险门。五工具共用既有 schema，含 get_user_prefs，不能保留绕过校验的旧路径。
3. 同一 PoolClient 执行本地工具、创建／取得批准、写接受结果、append 审计；COMMIT 后才返回。事务内 helper 只用传入 query client，不偷用 pool。
4. 明确本地工具异常可用 SAVEPOINT 回滚业务效果，再保存脱敏 failed／TOOL_ERROR 和审计。失败重交返回原失败，不自动再执行；明确新动作须新引用。
5. 结果写／审计写／事务提交失败不当成工具业务失败吞掉；全事务回滚，批准随之回滚，预约保留 reserved。数据库不可用不宣称失败审计已写。
6. COMMIT 回答丢失后，以数据库判定：completed 取原结果；reserved 说明本地业务事务未提交，可再执行本地事务。不能在不知结果时另生成调用。

ToolOutcome 保留 ok＋既有 payload、denied，增加 invocationId/replayed 和脱敏 failed/unknown 分类。success 是工具成功；approval_pending 是“已建立/取得此批准”，不等于建任务或完成外部动作。澄清和类型化时间错误也接受并重放原结构，不能因重交重跑规则。

## 历史结果与当前权限

- owner/Run/attempt 真实关联始终先验，不可因有已存结果跳过。本人有效引用仍重验当前可信 allowlist／资源访问资格；撤销后返回当前 denied 并追加提交审计，不覆盖原接受结果。恢复访问后仍可读取原结果。
- 最初已接受 denied 的调用不会因后来放权而变成执行；需新调用。当前访问门禁失败与已接受 denied 区分。
- reserved 新执行只允许仍有效的 Run/attempt；取消已提交则不得新执行。历史结果读取不使 cancelled/done/failed Run 继续运行。
- 批准经 approvals 公共冻结快照读取用例恢复原 CreatedApproval/echo，不使用含动态状态／剩余秒数的详情 DTO。已 consumed/rejected/expired/superseded 仍关联原批准与原版本，不延有效期、不改 hash/echo、不再建或消费批准；当前状态另经详情读取。缺失快照显式失败，不重新执行弥补。
- 只读工具保存其已输出的有界安全投影；同引用回原查询快照，新引用才刷新。预览和冻结展示按现有输出合同保留，不能把整个业务行／原始参数复制入账。

## 非事务动作的最小真实边界

只实现内部协调函数，供可信 TS 代码绑定 execute／只读 reconcile 能力；不建立工具注册器、任意命令入口、生产文件工具或供应商协议。五个现有产品工具仍 local/read_only。该函数必须与网关共用身份、访问校验、接受结果和只追加审计，不是测试专用的假执行器。

- 执行前独立事务将 reserved → unknown 并提交 dispatch 审计。只有成功取得这次转换且获得成功提交回答的当前执行栈可调用一次 execute；不确定提交者不取得调用资格。
- 并发输家、重启或重交见 unknown，返回 TOOL_EFFECT_UNKNOWN，不再执行。许可后动作前死亡即使实际效果为零也不补写；抛错、超时、无回答都不据此断言未执行。
- 当前原执行栈获得成功可接受 completed；明确失败仅在可信动作能证明未生效时记 failed/not_applied。失败不自动重试。结果写失败则保留 unknown，不把副作用再发一次。
- 可查询时仅只读核对同 invocation／内容摘要绑定的事实，确证后完成；查不到或无查询能力则继续 unknown，不伪造成功。未完成的原执行者与核对并发时也只能接受同一个不变结果，冲突证据显式失败。
- 验收用真实临时文件 append/fsync 与独立进程：许可后动作前强杀（零写）、实际写后结果提交前强杀（一次写）、已接受成功重交（一次写）、明确写前失败（零写）；重启并发重交不增写。可查询记录绑定引用与摘要，只读核对后完成；不可查询持续未知。

该证据只证明共同边界在真实非 PG 效果下的行为，不证明不存在的 MCP/provider、任意外部 exactly-once、跨语言消费者或无人值守恢复。

## 调用链和切换

conversations/service 的三个 caller 全部迁移为预约＋新 invoke envelope，不留旧签名 shim。v0 入站幂等、运行中409、完成后事件重放、GET after_seq、每帧先落库再发全部保留。工具结果提交后 SSE/checkpoint 失败，不重做工具；#45 不自动修复或重启该 Run。failed/unknown 不当作成功终结，不新增 SSE event 类型。

建议实现边界：tools/invocations 负责身份／状态／接受结果与协调，gateway 负责五工具 gate 与业务调用；conversations/tool-binding 公共用例独占 Run/attempt 查询／加锁，避免反向导入 service 形成环；approvals 公共快照用例独占批准读取。保留已明确的 owner-scoped 只读投影，不借机拆整个网关读取层。

实施同步长期 design/02/04/06/09、agent/02、schema、迁移索引、PRD和文档索引。独立 reviewer 审合同及实现，原五门全绿后分别合并；不提前提升 D8，不将本边界当 #46/#47 或 R1 已完成。
