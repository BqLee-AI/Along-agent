# 04. 五缝契约（AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：五个重点能力边界、同步公共用例/DTO/读取投影、受控确认事务、可靠异步 outbox 与跨语言职责
- **不包含**：真实模型/用户材料/产物验收结论、供应商与密钥、具体 SQL；R1 文档闭环规范见 14
- **阶段标签**：确定性 business 与正式仓颉 Harness 分列；不要求全模块远程化

> 授权作用域：本文 propose_task/逐项批准及单 workspace 是现行与 legacy 合同。新 profile 的目标工具、领域公共事务和直接文件绑定见 [design/20 §2、§6–§7](20-goal-scoped-delegation.md)（Proposed）；稳定调用、接受结果及 unknown 边界保留，本次不启用权限。

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
| ToolGateway    | 白名单 + 校验 + 风险分级 + 审计                             | 既有5业务工具；选workspace的Harness另授5有限工具，纯读经TS MCP，写回需文档授权   | 外部 MCP 经网关聚合，仓颉只认网关                    |
| Scheduler      | 登记 schedule / 认领 lease + fencing / cancel               | PG lease（见 08），无 Redis                                                      | 量大再议 Redis 延后项                                |
| Notifier       | send → 回执 + 幂等                                          | 站内信（应用内通知）先行                                                         | 邮件/推送后期，接口不变                              |
| ConnectorVault | secret 引用不出明文                                         | 仅接口 + Fake，无真实连接                                                        | 第 1~2 真实连接按评审接入                            |

## 2. AgentRuntime（正式 native 与 TS 可信边界）

[Required] 用户 API 见 conversations 路由，内部 `harness/v5` strict NDJSON（含只读路由帧，路由默认 off）见共享 contracts/harness.ts，新快照仅version=2。历史task snapshot1仅经限定读取迁移，不混跑旧writer。每有效 attempt 一个固定原生进程；model/model_next/measure_context/context_source/reserve/invoke/snapshot/suspend/answer/finish 仅请求动作，TS 恢复可信 owner/Run/权限，不发布可自报授权的同进程 ctx。模型正文逐次经原生与TS接受后投影，拉取增量不创建第二份循环或状态机（design/09 §2–§4、14、18）。

- [Required] 仓颉组织本次上下文和执行转移，经 TS 接口保存/读取运行快照与已接受结果；TS 存储不独立选择下一模型/工具步骤，仓颉不另建可独立裁决的事实库。
- [Required] 仓颉强制累计迭代/可得 usage，缺 usage 保留未知；TS 冻结预算和执行资格，不复制循环、不字符估算。时间/费用 SLA 随真实 provider/负载单独验收。
- [Required] 敏感工具经 TS 冻结批准门。harness 在有限快照后挂起，同 Run 显式恢复原调用及可信typed决议：task consumed带真实task_id，document approved仅授权原批准的唯一apply。拒绝/过期/替代不跟 successor 或同义绕拒绝；确定零写文档冲突后的新读/新批准是14限定路径。确定性 business 提议后结束，不伪称同 Run 模型等待。
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

- [Observed] 既有五业务工具为propose_task、request_cancel_task、list_tasks、read_brief_cards、get_user_prefs；带受管workspace的Harness另有workspace_list/grep/read/propose_replace/apply_replace（见末节）。三个v0分支互斥，使用持久 `v0-turn/1` slot；新逻辑动作新slot，同参数不能充当身份。`(run_id,call_key)`竞争只产生一个引用；更换tool/原始参数为STATE_CONFLICT，不执行。
- [Required] 预约先于副作用独立提交；首次冻结接收时间、anchor、timezone、fold 与规则版本。参数做带版本 domain 的 SHA-256，对象键排序、数组序及字符串字节不改；缺省与显式 default 可不同。只存摘要/字节数，不存 raw args。
- [Required] 本地 `reserved → completed`；锁序为 attempt → Run → invocation，沿公共用例取得执行资格，与取消/终结串行。已取消 Run/无效 attempt 不获新执行资格；当前权限遮蔽历史结果但不覆盖它，最初接受的 denied 不因放权变成执行。
- [Required] 批准创建/取得、接受结果和审计共用同一 client/事务。审计、结果或提交失败全回滚，预约保留；明确领域失败回滚工具效果后保存脱敏 failed。提交回答丢失后查同引用，不另造调用；completed 结果不可改删。
- [Required] 接受结果分类仍为 success、approval_pending、clarification、time_error、denied、failed，不因文档新增事件词或结果账。task批准保存冻结校验引用；document提议保存typed receipt引用，经所属公共读取恢复原完整冻结预览，不因动态批准状态重建。只读工具重放原安全快照，新引用才刷新；接受结果应用JSON上限240000字节。
- [Observed] `tools/invocations.ts#executeNonTransactionalInvocation` 为可信TS一次许可/只读核对边界，R1产品写工具workspace_apply_replace复用它。独立提交 `reserved→unknown` 及dispatch审计，仅明确取得COMMIT回答的当前栈可执行。并发、重启、丢回答及未知效果不重发；引用/摘要绑定的可信只读证据才能完成，未证实为TOOL_EFFECT_UNKNOWN。普通内容相等不是效果证据，不证明外部通用exactly-once。
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

## R1 文件与 MCP 增量 [Required]

规范详情见 [14](14-r1-document-task-loop.md)，HTTP/DTO见 [API 索引 §8](../api/README.md#8-r1-工作区与文档批准-required)，存储见 [Schema 索引](../schema/README.md#r1-文档批准)；既有task确认/审计合同不变。

- 有效部署登记是workspace授权来源；新Harness请求可选workspace_id并进入请求hash，冻结精确grant和独立安全摘要。历史Run/取消/冻结文档批准详情按owner可读，摘要不随当前登记重建；新批准/拒绝、resume、工具动作仍核对当前登记。普通用户不配置provider/BYOK，部署固定provider。
- 五个有限工具中workspace_list/grep/read为read_only：短事务验资格、事务外TS MCP IO、短事务首次接受，不持Run锁等待Server；workspace_propose_replace为local，批准/receipt/接受结果/审计同事务。仓颉只组织循环，TS工具不藏第二个循环；不是开放任意MCP/浏览器/Office能力。
- workspace_apply_replace为non_transactional：预约事务绑定唯一apply_invocation_id，在同一dispatch许可事务复验原Run、精确grant、approved状态及原绑定。取消先提交则不获许可；许可先提交则既成或迟到效果可记录，不能假撤销文件。
- 文档批准独立存储，按钮只授权，既有approval_required带document种类即可跳转；不造task/时间卡或调度事件。可信提议receipt决定typed decision，native不能自报批准种类/权限。
- 只有已接受绑定的applied加之后新创建且新接受的完整read才能证明完成；conflict须明确zero_write并经新读/新批准形成唯一后继。unknown正常失败终结，不重写、不用同hash补成功、不制造可恢复unknown checkpoint。
- HTTP原始JSON限131072字节；提议必须保证完整确认body再次序列化（含转义preview.body、hash、UUID键）也不超过131072，完整工具结果不超过240000字节；超限不截断预览。上述实现合同不替代真实模型/真实材料与产物的独立验收。
