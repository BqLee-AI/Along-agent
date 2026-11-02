# 11. 仓颉宿主 Harness 与 TS 能力层

## 文档状态

- **状态**：唯一 Harness、正式接入与 R1 有限文档任务合同
- **范围**：语言/状态责任、Web→TS→仓颉→TS 工具、文档批准/回读、固定工具链及分级验证
- **不包含**：实际供应商选型、完整 R1 产物验收、全 TS 后端迁移或通用恢复
- **阶段标签**：正式 native 核心与 TS 能力层；验收按覆盖行为和环境分别声明

> 协议与授权作用域：本文正式 v5/逐项按钮是现行/legacy；拟议 v6、新 profile、GoalResult 与受限旧恢复见 [design/20 §6、§8–§9](20-goal-scoped-delegation.md)。旧 native 严格拒绝 v6，不能换 wire 就扩旧 Run 权限；新 TS/native/Web 配套后才接纳新 profile。本次只定合同，不升级产物/安装。

## 1. 位置与分工（Required）

仓颉从第一条真实 Agent 闭环起就是唯一宿主 Harness，不是 TS 通用 Agent 的候选第二实现。TS 是长期能力/业务层，不退役 API/worker，也不在工具内部隐藏完整 Agent。原因见 [ADR0009](../adr/0009-cangjie-harness-ts-capabilities.md)。

| 责任                                                                 | 唯一所有者                    |
| -------------------------------------------------------------------- | ----------------------------- |
| 模型消息/工具提议解析与循环、本次上下文、工具结果纳入、行动选择      | 仓颉 Harness                  |
| 累计迭代/usage、等待/继续/恢复与停止决策                             | 仓颉 Harness                  |
| 工具定义/实现、schema、权限、批准与执行资格、接受结果                | TS                            |
| 长期 memory/检索/grep/修订/删除、MCP/办公、PC/browser/文件执行       | TS 能力模块，不在仓颉重建生态 |
| auth/凭据、冻结批准/time-core/tasks/scheduler/notifier/outbox/worker | TS 产品后端                   |
| PostgreSQL、Run/checkpoint/消息/事件持久化、SSE/补读与 Web           | TS                            |

本次上下文不是长期 memory；仓颉决定接下来尝试什么，TS 裁决动作是否允许、已发生什么。纯模型 HTTP transport 可以在 TS 持有凭据并转换协议，但不得选择工具、组织通用循环或推进 Run。

当前 attempt 的函数历史也归 native：提议使用标准 `assistant.tool_calls`，结果使用配对原 `tool_call_id` 的 `role=tool` 消息，不把调用序列拼成普通 assistant 回答。TS 仅原样传输结构化消息；批准恢复 bootstrap 可使用明确数据摘要承载已接受观察，snapshot 仍只引用持久事实。

## 2. 一次请求的责任链

```text
Web 明确选择 execution=harness
  → TS 认证/CSRF/输入/幂等，冻结可信 Run 与 attempt
  → 同容器固定仓颉子进程：上下文、模型请求、提议、预算
  → TS 固定 model transport 或公共 ToolGateway
  → TS 重验当前权限/attempt/取消及工具参数，持久预约和接受结果
  → 仓颉观察真实结果，继续 / 保存等待点 / 结束
TS 事实与只追加事件 → SSE / GET 补读 → Web
```

- 传输是每 attempt 一条 `harness/v5` UTF-8 NDJSON pipe（含只读路由帧，路由默认 off），native 只执行/输出 snapshot2，不增加 RPC 服务、远程 bearer 或 FFI。模型正文以真实增量经 native answer/TS接受后投影，native 以相关 model_next 串行拉取后续，最终内容不重复发送。具体帧见 [共享 schema](../../packages/contracts/src/harness.ts) 和 design/09 §2、design/18 §6。旧 snapshot1 仅限 TS 读取已完成的旧业务/task 引用：不得带 workspace grant 或 document 批准；校验后构造 snapshot2 bootstrap，不改历史行、不回退旧 wire 执行器。
- native 不接收数据库/会话/模型密钥，不自报 owner 或 allowlist。每次工具动作从进程闭包和持久事实恢复可信 `ToolContext`；TS 不把内部对象原样暴露为远程合同。
- business 是既有确定性提醒/取消/查询路径，不是另一个 Agent，也不作为 harness 失败回退。默认兼容 business，消息 `mode` 不承担执行器分派。
- 批准等待保存有限引用和进度；显式恢复仍是同 Run、新 attempt、原 invocation/批准和真实当前决议。GET 与同入站键只补读，不能从事件行推导恢复授权。
- 文档批准只授权本 Run 原冻结替换，不是完成写入：仓颉观察 `kind=document` 当前决议后，自行选择原批准的 apply 和新的 read。每个批准只绑定一个 `non_transactional` apply invocation；done 前 TS 验证真实 apply/新回读效果链，不伪造 task ID/卡片，也不代跑固定工具链。
- native 每响应只接受零或一个工具调用；即使独立读取也逐次等待真实观察再选择。TS transport 发送 `parallel_tool_calls:false`，该参数不保证供应商遵守，provider/共享 schema 与 native 仍严格拒绝单响应多个调用，不只取第一项。
- cancel 在 TS 提交资格撤销与唯一取消事件后才 abort HTTP/终止进程；既成工具/按钮确认事实保留。

## 3. 工具链与生产配置

正式项目 `apps/harness` 使用官方 Linux x64 SDK1.0.5 LTS/stdx1.0.5.1。`artifacts.lock` 记录来源和固定 SHA256；SDK hash 与官网元数据匹配，stdx hash 是官方 release 下载后本地计算值，不冒称独立发行 checksum。

- `bun run harness:prepare` 准备锁定工具链；`bun run build:harness` 构建正式源。完整用法、平台前置与运行库位置见 [README](../../apps/harness/README.md)。
- 镜像采用独立 Debian 编译阶段，真实安装 binutils/GCC/C++/libc 开发闭包；不能把裸 Bun runtime 能执行旧 ELF 当作 fresh 编译成功。runtime 只复制生产产物、必要动态库和适用 SDK/stdx/第三方 notices。
- TS 固定 OpenAI-compatible chat-completions transport；`HARNESS_MODEL_BASE_URL/HARNESS_MODEL` 由部署服务端指定兼容端点和模型，`HARNESS_MODEL_API_KEY` 可选且只留 TS。普通用户不配置 provider/BYOK；实际供应商、计费与质量不在此决定。
- `HARNESS_BINARY` 默认 `/app/harness/bin/along-harness`，`HARNESS_LIBRARY_PATH` 默认 `/app/harness/lib`。缺配置或不可执行时新 harness Run 返回503，无写入/SSE、无 fixture 回退。部署者设置变量，不写真实值到仓库 `.env`。
- `HARNESS_MAX_ITERATIONS/HARNESS_MAX_TOKENS` 是部署服务配置，默认24/64000，均须为正安全整数；不是 Web/模型请求字段。预算在 Run 接纳时冻结、持久化，native 跨批准恢复 attempt 累计，恢复不重置，也不读取新的部署额度。缺失 usage 的累计值保持未知；默认值不代替真实 R1 负载校准。
- 帧/HTTP 模型响应实施1MiB字节边界，协议/进程/provider错误脱敏；不记录原始 stderr、请求/响应或完整推理链。未知 usage 保留未知，不承诺不可证明的 token/费用上限。

部署先停旧运行写者，事务应用新增迁移，再切同次构建的 native/TS 进程。新事实接纳后只前滚，不删除调用账、不复活旧 attempt 或让旧二进制混写。历史 business/task 事实按受限读取合同保留，不伪造可恢复快照；冻结文档历史仍可审阅，但恢复和新动作必须重新核验当前 workspace 登记及权限。

## 4. 分级验收边界（Required）

#46/#47 下述条目保留各自接入与消费者门的适用证据边界；其历史 v1/task 验收不能推定本次 v2/document/R1 已通过。当前入口执行新协议不等于既有真实验收记录自动升级。

### 最小正式接入（#46）

在新的隔离 PG16 上，通过真实签名会话/CSRF、HTTP/Web、当前正式 native 与真实工具/批准事实，验证可信权限、生命周期、有限等待恢复、补读隔离、五工具公共端口和原业务不变量。native 独立 CLI 不能替代集成。

仅在服务端依赖注入点控制模型 transport 响应；fixture 不得自选动作/slot、执行 reserve/invoke、编排 Run 状态或替换 native。正式核心仍负责上下文、选择解析、实际工具观察、预算、等待和停止。该证据可以覆盖接入合同，但不证明真实 provider/模型质量或完整 R1。

### 跨语言消费者门（#47）

沿用五个 required checks，不新增门。根 `test:contracts` 与既有 `contracts-dual` 从当前树构建正式生产镜像，在相同 Bun/native runtime 和隔离 PG16 上运行真实生产者/消费者的本地与签名 HTTP 成功、拒绝合同；本次报告逐项验证必需消费者实际通过，不能用旧报告或跳过补足。省略构建/消费者执行、真实结果纳入或资格裁决分别有对应失败证据。D8 只按实测 Run/工具/有限批准恢复范围 enforced；unknown 核心→native 子合同不证明 HTTP 外部工具或跨请求恢复，更不能据此制造生产 unknown 恢复快照。其余范围继续 partial/Deferred，最小 healthz 双跑本身仍只证明 partial；具体入口、隔离和证据规则见 [design/13 §4.2](13-p0-bootstrap-and-ci-rules.md#42-d8-正式-harness-消费者合同required)。

### 完整 R1 与后续恢复

真实 Web→TS→仓颉→TS 工具→实际产物/新回读证明目标闭环，选择随输入/观察变化；固定回放和 mock 不代替真实模型和产物。受控模型消费者合同只能证明对应合同，真实模型隔离探针也只能证明该次模型/传输行为，不能冒充全链验收。真实供应商、模型质量、R1 产物、性能/内存需分别以实际环境举证，不沿用旧 S1–S3 实验数字作为主 Harness 转正门。

有限批准等待不等于任意崩溃自动恢复。已接受结果不重执行；native 收到 unknown 即正常 `finish(failed,TOOL_EFFECT_UNKNOWN)`，不推进调用号、不纳入 accepted 引用、不造 snapshot/checkpoint 或 suspend、不再模型/预约/重写；failed 终态仍须持久化。checkpoint/lease/fencing 不单独保证 external exactly-once。design/08 通知专属许可/回执证据不泛化至所有连接器。

## 5. 红线（Required）

1. 仓颉不直连 PostgreSQL 业务库，存储权威继续 TS 所有。
2. 时间归一只在 TS/time-core；排期经 propose_task 与冻结按钮确认，不自行计算 UTC。
3. MCP、PC/browser、memory/grep 与办公经 TS 能力边界；工具不内藏另一套 Agent。
4. 同容器/内网不是免鉴权，快照和 reply 不能提升 Run 权限。
5. 只追加事件、冻结展示、确认创建/取消单事务、取消优先、回执门与未知不盲重发不变。

## 6. R1 用户任务合同（Observed / Required）

[14 §1–§11](14-r1-document-task-loop.md) 将 R1 收敛为受管项目资料到简报的真实任务。当前实现由仓颉决定检索/查证/修改/回读，TS 提供有限 workspace 和基于官方 SDK 的薄只读 MCP Server；workspace 工具只含 `workspace_list/workspace_grep/workspace_read/workspace_propose_replace/workspace_apply_replace`，读写权限不因模型建议或旧批准提升。

文档按钮授权后显式继续同 Run、新 attempt；approved 只提供授权观察，原冻结替换由唯一 apply invocation 执行，新的 read 证明完成，冲突/未知不能假称已写。该协议与执行路径已存在，不再作为 Proposed 或第二套执行器保留。SDK/Bun 镜像兼容、正式消费者合同、真实模型任务和位置/冲突/读失败变体须分别按实测范围举证；实现存在不等于实际材料或完整 R1 真模型验收成功。既有最小接入与 #47 有限 D8 不替代该矩阵。

## 7. R2-B 路由与部署边界（已实现，默认 off，#88）

本节不改变 §1–§6 的现有 Required 合同：当前正式 wire 为 `harness/v5`（R2-B 后继），R2-A 上下文管理仍沿 [design/18](18-r2a-harness-context.md)。只读路由已接入同一 native 循环的首模型前有界分支，默认 off、未启用接管；内部协议、记录、工具/展示和失败处理以 [design/19](19-r2b-readonly-intent-routing.md) §7、§8、§9、§10 为真源。

- 新流程仅插在 fresh 首 attempt 首模型前，仓颉决定 direct/fallback，TS 提供事实、来源与编码/打分，不拥有通用循环。默认 off、旧 Run 缺策略、GET/同键重放/批准 resume 均零分类；shadow 不调用候选旁路业务工具，仍交原模型。business 及公开 execution/SSE 不变，主 Harness 依赖坏仍原类型化失败，不能借路由绕过接纳。
- v5 已与共享 schema、TS/native 和消费者同批切换，新增内部 probe/decide/render 帧及三种 routing checkpoint（迁移 0020），保留 snapshot2。通过新增迁移扩充封闭 kind 与唯一/来源约束，不改旧迁移；不建新路由表或 Run JSON 列，不让内部记录泄漏到 SSE。
- direct 仍经原 reserve/invoke，只允许一个冻结目标/参数的只读调用；TS 由真实成功 accepted_result 和已接受 snapshot 固定渲染，同事务持久 delta/render 回执，不假造模型正文、函数调用或 usage。接纳后失败不切 LLM/新 slot；原取消先提交、当前权限、幂等及只读补读不变，详见 design/19 §9–§10。
- 编码服务目标是独立内网 CPU sidecar，API 经 HTTP 请求固定 binding 的单条向量；采用已离线实测的 ORT/tokenizer 计算路径，不向 Bun 加 Torch，也不接受请求下载/切模型。主候选为 BGE-small 中文 INT8，E5 仅离线对照；精确资产、编码和协议见 design/19 §5，不能沿用旧 Qwen/TEI 参数。
- Windows 离线 ORT 实验不等于 Linux HTTP sidecar、生产镜像或 TEI 已验证；正式 Linux 镜像/digest、服务正确性、并发/共存资源与冷启动须目标宿主最小实验后锁定，未满足前保持 off。默认关闭不依赖 embedding，不降低核心 readyz；全过程 1000ms、每实例最多 2 inflight、单次编码无重试及拒识增量 p95≤500ms 仅为 Proposed 预算/候选目标，不是实测线上 SLA，见 design/19 §11–§12。
- 既有消费者合同、真实模型任务和新路由启用门分别取证；静态文档、旧 D8/R2-A 报告或离线相似度不能代替 v5 消费者、真实工具/取消/重放边界及独立评估证据。

## 引用

- [09 Harness/checkpoint](09-agent-runtime-and-checkpoint.md)、[02 模块边界](02-modular-monolith-and-split-triggers.md)、[04 五缝](04-five-seams-contract.md)、[PRD 待决 D2](../prd/04-acceptance-open-questions.md)。
- B04/B06、AF 仅为机制参考；旧第二实现/S1–S3 转正目标退出，历史记录保留其当时适用边界。
