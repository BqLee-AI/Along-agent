# 11. 仓颉宿主 Harness 与 TS 能力层

## 文档状态

- **状态**：唯一 Harness 与正式最小接入合同
- **范围**：语言/状态责任、Web→TS→仓颉→TS 工具、固定工具链及分级验证
- **不包含**：实际供应商选型、完整 R1 产物验收、全 TS 后端迁移或通用恢复
- **阶段标签**：正式 native 核心与 TS 能力层；验收按覆盖行为和环境分别声明

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

- 传输是每 attempt 一条 `harness/v1` UTF-8 NDJSON pipe，不增加 RPC 服务、远程 bearer 或 FFI。具体帧见 [共享 schema](../../packages/contracts/src/harness.ts) 和 design/09 §2。
- native 不接收数据库/会话/模型密钥，不自报 owner 或 allowlist。每次工具动作从进程闭包和持久事实恢复可信 `ToolContext`；TS 不把内部对象原样暴露为远程合同。
- business 是既有确定性提醒/取消/查询路径，不是另一个 Agent，也不作为 harness 失败回退。默认兼容 business，消息 `mode` 不承担执行器分派。
- 批准等待保存有限引用和进度；显式恢复仍是同 Run、新 attempt、原 invocation/批准和真实当前决议。GET 与同入站键只补读，不能从事件行推导恢复授权。
- cancel 在 TS 提交资格撤销与唯一取消事件后才 abort HTTP/终止进程；既成工具/按钮确认事实保留。

## 3. 工具链与生产配置

正式项目 `apps/harness` 使用官方 Linux x64 SDK1.0.5 LTS/stdx1.0.5.1。`artifacts.lock` 记录来源和固定 SHA256；SDK hash 与官网元数据匹配，stdx hash 是官方 release 下载后本地计算值，不冒称独立发行 checksum。

- `bun run harness:prepare` 准备锁定工具链；`bun run build:harness` 构建正式源。完整用法、平台前置与运行库位置见 [README](../../apps/harness/README.md)。
- 镜像采用独立 Debian 编译阶段，真实安装 binutils/GCC/C++/libc 开发闭包；不能把裸 Bun runtime 能执行旧 ELF 当作 fresh 编译成功。runtime 只复制生产产物、必要动态库和适用 SDK/stdx/第三方 notices。
- TS 固定 OpenAI-compatible chat-completions transport；`HARNESS_MODEL_BASE_URL/HARNESS_MODEL` 指定兼容端点和模型，`HARNESS_MODEL_API_KEY` 可选且只留 TS。实际供应商、计费与质量不在此决定。
- `HARNESS_BINARY` 默认 `/app/harness/bin/along-harness`，`HARNESS_LIBRARY_PATH` 默认 `/app/harness/lib`。缺配置或不可执行时新 harness Run 返回503，无写入/SSE、无 fixture 回退。部署者设置变量，不写真实值到仓库 `.env`。
- 帧/HTTP 模型响应实施1MiB字节边界，协议/进程/provider错误脱敏；不记录原始 stderr、请求/响应或完整推理链。未知 usage 保留未知，不承诺不可证明的 token/费用上限。

部署先停旧运行写者，事务应用新增迁移，再切同次构建的 native/TS 进程。新事实接纳后只前滚，不删除调用账、不复活旧 attempt 或让旧二进制混写。历史 business 只读兼容，不伪造可恢复快照。

## 4. 分级验收边界（Required）

### 最小正式接入（#46）

在新的隔离 PG16 上，通过真实签名会话/CSRF、HTTP/Web、当前正式 native 与真实工具/批准事实，验证可信权限、生命周期、有限等待恢复、补读隔离、五工具公共端口和原业务不变量。native 独立 CLI 不能替代集成。

仅在服务端依赖注入点控制模型 transport 响应；fixture 不得自选动作/slot、执行 reserve/invoke、编排 Run 状态或替换 native。正式核心仍负责上下文、选择解析、实际工具观察、预算、等待和停止。该证据可以覆盖接入合同，但不证明真实 provider/模型质量或完整 R1。

### 跨语言消费者门（#47）

沿用五个 required checks，不新增门。根 `test:contracts` 与既有 `contracts-dual` 从当前树构建正式生产镜像，在相同 Bun/native runtime 和隔离 PG16 上运行真实生产者/消费者的本地与签名 HTTP 成功、拒绝合同；本次报告逐项验证必需消费者实际通过，不能用旧报告或跳过补足。省略构建/消费者执行、真实结果纳入或资格裁决分别有对应失败证据。D8 只按实测 Run/工具/有限批准恢复范围 enforced；unknown 核心→native 子合同不证明生产 unknown 快照、HTTP 外部工具或跨请求恢复。其余范围继续 partial/Deferred，最小 healthz 双跑本身仍只证明 partial；具体入口、隔离和证据规则见 [design/13 §4.2](13-p0-bootstrap-and-ci-rules.md#42-d8-正式-harness-消费者合同required)。

### 完整 R1 与后续恢复

真实 Web→TS→仓颉→TS 工具→实际产物/回读证明目标闭环，选择随输入/观察变化；固定回放和 mock 不代替真实模型和产物。真实供应商、模型质量、R1 产物、性能/内存需分别以实际环境举证，不沿用旧 S1–S3 实验数字作为主 Harness 转正门。

有限批准等待不等于任意崩溃自动恢复。已接受结果不重执行，unknown 只核对或停下；checkpoint/lease/fencing 不单独保证 external exactly-once。design/08 通知专属许可/回执证据不泛化至所有连接器。

## 5. 红线（Required）

1. 仓颉不直连 PostgreSQL 业务库，存储权威继续 TS 所有。
2. 时间归一只在 TS/time-core；排期经 propose_task 与冻结按钮确认，不自行计算 UTC。
3. MCP、PC/browser、memory/grep 与办公经 TS 能力边界；工具不内藏另一套 Agent。
4. 同容器/内网不是免鉴权，快照和 reply 不能提升 Run 权限。
5. 只追加事件、冻结展示、确认创建/取消单事务、取消优先、回执门与未知不盲重发不变。

## 引用

- [09 Harness/checkpoint](09-agent-runtime-and-checkpoint.md)、[02 模块边界](02-modular-monolith-and-split-triggers.md)、[04 五缝](04-five-seams-contract.md)、[PRD 待决 D2](../prd/04-acceptance-open-questions.md)。
- B04/B06、AF 仅为机制参考；旧第二实现/S1–S3 转正目标退出，历史记录保留其当时适用边界。
