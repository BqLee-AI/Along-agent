# 04. 五缝契约（AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：五个重点能力边界、同步公共用例/DTO/读取投影、受控确认事务、可靠异步 outbox 与跨语言职责
- **不包含**：完整 R1、供应商与密钥、具体 SQL
- **阶段标签**：确定性 business 与正式仓颉 Harness 分列；不要求全模块远程化

## 引用

- B03 §2 服务划分、§3 通信、§5 存储；B04 仓颉职责边界；B05 阶段 1/4/5；B06 §6/§9/§10
- AF（harness 可替换、checkpoint、自托管）；外部产品形态（任务卡确认）只作参照

## 0. 设计结论

- [Required] 五缝是主要可替换能力边界，不是所有跨模块调用的唯五入口。同步公共用例、显式 DTO 与只读投影合法；身份/资源关联 ID-first，不共享可写存储对象（02 §1–§2）。
- [Required] 仅需事务后可靠异步投递的命令/事件经 outbox；确认消费与创建任务或取消请求保留单事务。实时网关调用、公共读取、SSE 投影不因此强制入队。
- [Required] 仓颉为唯一宿主 Harness，TS 长期保留能力/业务/存储；v0 确定性 turn 不是已实现的 TS 通用 Agent 或仓颉第二实现基线（09/11；ADR 0009）。
- [Required] 仓颉永不直连业务库、不做时间归一；需排期必须回调 `propose_task`，由 TS 走 time-core（见 05）。
- [Deferred] 连接器真实授权（OAuth/密钥托管）、向量库选型、Redis 队列：本篇只定引用形状，不定供应商字段。

## 1. 总览与选型

| 缝             | 职责一句话                                                  | v0 落点                                                                          | P1+                                                  |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| AgentRuntime   | 仓颉唯一组织模型/工具循环、当前上下文、预算、等待/恢复/停止 | 显式 execution 分派；business 确定性业务、harness 正式 native；TS 存储与资格裁决 | 真实 provider/完整 R1 分别验收，不保留 TS 第二 Agent |
| ToolGateway    | 白名单 + 校验 + 风险分级 + 审计                             | 本地 5 工具：提醒提议、取消请求、任务列表、简报卡片、用户偏好；无外部 MCP        | MCP 经网关聚合，仓颉只认网关                         |
| Scheduler      | 登记 schedule / 认领 lease + fencing / cancel               | PG lease（见 08），无 Redis                                                      | 量大再议 Redis 延后项                                |
| Notifier       | send → 回执 + 幂等                                          | 站内信（应用内通知）先行                                                         | 邮件/推送后期，接口不变                              |
| ConnectorVault | secret 引用不出明文                                         | 仅接口 + Fake，无真实连接                                                        | 第 1~2 真实连接按评审接入                            |

## 2. AgentRuntime（正式 native 与 TS 可信边界）

[Required] 用户 API 见 conversations 路由，内部 `harness/v1` strict NDJSON 见共享 contracts/harness.ts。每有效 attempt 一个固定原生进程；model/reserve/invoke/snapshot/suspend/answer/finish 仅请求动作，TS 恢复可信 owner/Run/权限，不发布可自报授权的同进程 ctx。不另保留目标示意 API 或第二份状态机（design/09 §2–§4）。

- [Required] 仓颉组织本次上下文和执行转移，经 TS 接口保存/读取运行快照与已接受结果；TS 存储不独立选择下一模型/工具步骤，仓颉不另建可独立裁决的事实库。
- [Required] 仓颉强制累计迭代/可得 usage，缺 usage 保留未知；TS 冻结预算和执行资格，不复制循环、不字符估算。时间/费用 SLA 随真实 provider/负载单独验收。
- [Required] 敏感工具经 TS 冻结批准门。harness 在有限快照后挂起，同 Run 显式恢复原调用及真实决议；拒绝/过期/替代不跟 successor 或同义绕拒绝。确定性 business 提议后结束，不伪称同 Run 模型等待。
- [Required] 跨语言消费者门复用 contracts-dual；D8 按实际 fresh 构建/生产者消费者/结果纳入/执行资格拒绝证据限定升级，最小 healthz 双跑本身仍只证明 partial。
- [Deferred] 多 Agent 线性协同、`@execution` 自定义 plan：远期，不在本契约加方法。

### 实施与验证边界

[Required] 最小正式接入、跨语言 CI 消费者门与完整 R1 分级取证（11 §4），不能把受控模型 transport/本地结果原子性当成真实 provider、模型质量或 R1 产物验收。

## 3. ToolGateway（稳定调用身份、本地原子结果与审计）

```text
reserveToolInvocation(pool, trustedContext, {callKey, toolId, args})
  -> 持久预约 invocationId，绑定 Run/slot、原始 JSON 摘要与首次时间上下文
invokeTool(pool, trustedContext, {invocationId, toolId, args})
  -> 校验真实 owner/conversation/Run/attempt 及当前 allowlist
  -> 已接受结果只读重放；未执行项核对 Run/attempt 资格与 strict schema
  -> 本地工具、批准、接受结果、只追加审计同事务提交后返回
```

- [Observed] 五个产品工具为本地实现：propose_task、request_cancel_task、list_tasks、read_brief_cards、get_user_prefs。三个 v0 分支互斥，使用持久 `v0-turn/1` slot；新逻辑动作新 slot，同参数不能充当身份。`(run_id, call_key)` 竞争只产生一个引用；更换 tool/原始参数为 STATE_CONFLICT，不执行。
- [Required] 预约先于副作用独立提交；首次冻结接收时间、anchor、timezone、fold 与规则版本。参数做带版本 domain 的 SHA-256，对象键排序、数组序及字符串字节不改；缺省与显式 default 可不同。只存摘要/字节数，不存 raw args。
- [Required] 本地 `reserved → completed`；锁序为 attempt → Run → invocation，沿公共用例取得执行资格，与取消/终结串行。已取消 Run/无效 attempt 不获新执行资格；当前权限遮蔽历史结果但不覆盖它，最初接受的 denied 不因放权变成执行。
- [Required] 批准创建/取得、接受结果和审计共用同一 client/事务。审计、结果或提交失败全回滚，预约保留；明确领域失败回滚工具效果后保存脱敏 failed。提交回答丢失后查同引用，不另造调用；completed 结果不可改删。
- [Required] 接受结果分类为 success、approval_pending、clarification、time_error、denied、failed。批准仅存引用及冻结校验材料，经 approvals 公共快照恢复原回显/期限/hash；不读动态详情，不因批准已 consumed/rejected/expired/superseded 重建。只读工具重放原安全快照，新引用才刷新。
- [Observed] `tools/invocations.ts#executeNonTransactionalInvocation` 是可信 TS 内部的一次许可/只读核对边界，不是新增产品工具。独立提交 `reserved → unknown` 及 dispatch 审计；仅得到成功提交回答的当前栈可执行。并发、重启、丢回答及未知效果不重发；同引用/摘要绑定的只读证据才能完成，未证实继续 TOOL_EFFECT_UNKNOWN。临时文件 fsync/强杀只证明此共同边界，不证明不存在的 MCP/provider 或通用 external exactly-once。
- [Required] tool_invocations 是身份/结果事实，tool_calls 仍只追加审计；不把 legacy args_hash 唯一键当调用去重。字段和迁移停写切换见 [schema](../schema/conversation-and-runs-schema.md#tool_invocations) 与 infra/migrations。failed/unknown 不能被 caller 当成功终结；事件补读不重做工具，也不自动恢复 Run。
- [Required] TS 保留工具定义、校验、授权、记录；memory/grep、MCP、PC/browser、办公 connector 仍为 TS 能力。v0 不给任意代码执行/网页浏览；MCP 必须经网关，工具不隐藏完整模型/工具循环。既有确认消费、确定性时间、冻结展示、取消与回执合同不变。

## 4. Scheduler（schedule / claim lease + fencing / cancel）

```text
Scheduler.schedule(task_id, fire_at_utc, idempotency_key) -> schedule_receipt
Scheduler.claim(due_tasks) -> lease（PG 行锁 + lease_owner + lease_expires，见 08）
Scheduler.cancel(task_id, idempotency_key) -> cancel_receipt | PENDING（无回执即 PENDING）
```

- [Required] 登记成功以回执为准；无回执不标 `scheduled`，未过窗时停 `pending_schedule`。未完成排期的 `saved/pending_schedule` 超原到点 15min 按 08 §5 原子终结为 `missed`，不伪造回执、不调用 provider；取消分支仍遵守撤销回执门。
- [Required] 认领 fencing：`expected_state_version` 对不上不发；版本变/已取消标 SUPERSEDED 不发。
- [Required] 取消优先：cancel 提交后排队重试全作废；触发门禁照拦。

## 5. Notifier（send → 回执 + 幂等）

```text
Notifier.send(task_id, fire_at_utc, idempotency_key, attempt_no) -> receipt | ACK_UNKNOWN
  receipt含 provider_receipt_id；ACK_UNKNOWN 只核对不重发（30s/2min/5min 各核一次，仍未知转持久对账）
```

- [Required] 仅明确拒绝且能证明未接收的通道可按通道合同退避；本地 inapp 异常/无回答只核对，不盲重发。超原到点 15min 不发新请求，历史接收核对不算补发；许可、退避与未知核对以 08 §4/§7–§8 为准。
- [Required] 口径天花板：receipt 只证明接口收了，不证明用户看见；对外只说“已记录的步骤可核对”。
- [Observed] v0 通道 = 应用内通知；系统通知三问（认幂等键？可按键查？取消可拦？）答不上就按降级写，不假设。

## 6. ConnectorVault（引用 + Fake）

```text
ConnectorVault.resolve(connection_ref, owner_id, purpose) -> secret_handle（不出明文）
  connection_ref  连接引用（用户+应用+授权版本）
  secret_handle   一次性句柄（网关内用即焚，不落业务表）
ConnectorVault.fake() -> 本地假连接（v0 联调用）
```

- [Required] secret 明文不出 Vault、不进业务表、不进日志；业务侧只存 `connection_ref`。
- [Required] v0 仅接口 + Fake；真实连接需过白名单评审（B05 阶段 4），不改仓颉代码、只配网关即可接新 MCP 工具是验收线。
- [Deferred] 具体授权协议、日历/邮箱二选一先做哪个：P0 定，本篇不定。

## 7. 跨模块数据规则

```text
agent_runs / run_attempts / run_checkpoints + lease（a13n checkpoint 落点）
  run_id / attempt_no / checkpoint_seq / event_ref / lease_owner / lease_expires
outbox（可靠异步命令/事件；投递状态可变，非只追加账本）
  event_id / aggregate（task|approval|run）/ aggregate_id / type / payload_ref / request_id / idempotency_key
```

- [Required] 模块归属、ID-first/DTO/投影及确认创建/取消事务遵循 02 §1–§2。D1 检测存储实现导入，不证明 SQL 所有权；outbox 自身状态可变，不能把它等同于只追加 task_events。
- [Required] 不可变 revision：agent / skill / prompt + `presentation_version` + `tzdb_version` + `ruleset_id` 进快照；DB 禁改，错了发新版。
- [Required] AG-UI 投影：`packages/stream-protocol` 版本化 zod；事件名开工对照 `thread-stream.schema.json`。
- [Required] 不支持组合 → `/readyz` 类型化错误不降级（缺规则/tzdb 直接 503 不开张）。

## 8. 反事实检查表

| 反事实             | 后果                    | 契约对策                                                      |
| ------------------ | ----------------------- | ------------------------------------------------------------- |
| 写侧任意读写他人表 | 规则/权限绕过、改表耦合 | [Required] 所属公共用例；明确只读投影与确认事务例外；SQL 另审 |
| 网关外直调 MCP     | 白名单/审计被绕过       | [Required] 仓颉只认网关                                       |
| 仓颉直连业务库     | 鉴权/隔离击穿           | [Required] 上下文由调用方传入                                 |
| LLM 算时间         | DST/歧义不可复现        | [Required] 时间只经 time-core（见 05）                        |
| 展示层换算时间     | 摆与存对不上            | [Required] 展示只读冻结字段（见 06）                          |
| cancel 可复活      | 取消后仍响              | [Required] 取消终态，核对“曾排上”也不复活                     |
