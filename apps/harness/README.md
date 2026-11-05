# 仓颉原生 Harness

生产源位于本目录，目标平台 Linux x86_64，仅使用继承的 stdin/stdout 交换 `harness/v6`；`v5` 与未知版本硬拒绝，不执行或写出旧 wire 协议。snapshot 仅接受/输出 `version: 2`。不监听端口、不持有模型凭据、不包含模型 fixture 或网络 transport。准确 wire DTO 见 `packages/contracts/src/harness.ts`、`goals.ts` 与 `routing.ts`；身份、授权、调用预约、效果、批准与持久事实由 TypeScript 裁决。

## 可复现构建与安装

Linux/WSL 安装 Bun1.4.2、Docker 后执行根入口 `bun run build:harness`，或 `bash scripts/build-harness.sh`。它构建 `infra/docker/Dockerfile` 的独立 `harness-artifact` 目标，默认导出到 `apps/harness/dist`。builder 包含 GCC、binutils、C/C++ 开发库和按 `artifacts.lock` 校验的 SDK/stdx；`cjpm build --skip-script` 编译本目录正式源，不接受全局 SDK 或旧二进制。`cjpm.lock` 固定包依赖，`artifacts.lock` 单独固定二进制路径依赖；stdx hash 是官方 release 的本地计算值，不是独立发布者证明。

也可执行 `docker build --target harness-artifact --output type=local,dest=/tmp/along-harness -f infra/docker/Dockerfile .`。导出包括 `bin/along-harness`、实际链接的 SDK/stdx 动态库闭包 `lib/`、官方及第三方许可 `notices/`、源与产物 SHA256。API 使用 `HARNESS_BINARY=/tmp/along-harness/bin/along-harness` 和 `HARNESS_LIBRARY_PATH=/tmp/along-harness/lib`；直接运行二进制使用 `LD_LIBRARY_PATH=/tmp/along-harness/lib`。正式 API 镜像将该构建阶段复制到 `/app/harness/` 并配置这些路径。

`bun run harness:prepare /opt/along-toolchain` 是显式 Linux 下载入口，先校验再解包；依赖 bash/curl/sha256sum/tar/unzip，构建不运行 cjpm hooks 或下载隐式依赖。Docker builder 是正式编译环境；原生 Windows 和其他架构不在该 artifact lock 支持范围。

仓库将 shell 脚本及其 `artifacts.lock` 固定为 LF，避免 Windows checkout 的 CRLF 使正式容器构建失败；不修改开发者全局 Git 配置。

## 正式跨语言合同门

Linux x64 / WSL 执行根 `bun run test:contracts`。入口从当前树构建生产镜像，在同一 Bun/native runtime 中运行真实本地公共用例与签名 HTTP 合同；自行建立私有网络、全新 PG16 和测试身份，不需要已有数据库或模型凭据。旧 healthz/契约包保留，必需消费者须在本次实际报告中唯一通过，缺失或跳过不能放行。成功、失败均清理本次容器、卷、网络和镜像标签。

unknown 与取消后迟到调用另验证真实非事务调用核心到 native 的停止/资格边界；内部文件探针不是产品工具。unknown 不生成 checkpoint，不能冒充生产可恢复快照。D8 的有限 enforced 和 remaining/partial 规则见 `docs/design/13-p0-bootstrap-and-ci-rules.md` §4.2，不代表真实 provider、所有连接器或完整 R1。

原生目标合同的独立受控 pipe 用例位于 `apps/harness/test/contracts/trusted-goals.test.ts`；在同一 Linux 正式产物环境中设置上述 `HARNESS_BINARY` / `HARNESS_LIBRARY_PATH` 后执行 `bun test apps/harness/test/contracts/trusted-goals.test.ts`。它直接向真实二进制发送帧，覆盖 v5/畸形可信上下文硬拒绝、可信 system 层、保存/清除实际收据、显式 `finish_goal`、预算/取消/unknown 与 null profile 兼容；不替代 API/PG 原子性或真实模型验收。缺当前正式二进制时明确失败，不跳过。

## 模型传输配置

安装 native 不会自动选供应商或启用 fixture。普通用户不配置 provider/BYOK；供应商、模型与预算由部署服务端固定。API 启动时读取：

- `HARNESS_MODEL_BASE_URL`：OpenAI-compatible API 根地址，后接 `chat/completions`；仅显式服务端配置。
- `HARNESS_MODEL`：模型名；`HARNESS_MODEL_API_KEY` 可选，只留 TS transport，不传给 native。
- `HARNESS_BINARY`：默认 `/app/harness/bin/along-harness`；`HARNESS_LIBRARY_PATH`：默认 `/app/harness/lib`。
- `HARNESS_MAX_ITERATIONS`：部署服务迭代预算，默认24；`HARNESS_MAX_TOKENS`：累计 token 预算，默认64000；均须为正安全整数，非法配置不启用 Harness。它们不是 Web/模型可覆盖的请求字段，Run 接纳后冻结，跨批准恢复的 attempt 累计，不因部署配置后来变化重置。当前默认值不等于真实 R1 预算已获校准或全链验收。

缺模型配置或不可执行产物时新 harness Run 在写入/SSE 前503 `HARNESS_UNAVAILABLE`，默认 business 不受此可选配置影响，不回退到 TS Agent/fixture。部署者设置变量；不将真实值写入仓库 `.env`。服务端提供并在 Run 接受时冻结迭代/token 预算；native 不另设 R1 默认轮数，未知 usage 不能保证可证明的费用上限。

每个 Run 另外冻结 `context_policy`：单次正整数 `completion_cap` 与累计预算独立，窗口能力未知为 null，计量能力及 model/adapter 绑定不含凭据。native 先检查本地完整模型帧，再调用零 provider 请求的 `measure_context` 获取完整 HTTP UTF-8 字节、输入计量质量及可行输出上限；改变输出 O 后重新计量。unavailable 不编造输入 token，estimated 不冒充 provider usage。真实请求仅使用显式 O，不把 Run 余额直接当 `max_tokens`；冻结绑定不兼容不能静默替换。

## 执行与失败合同

- 两端验证有界 UTF-8 NDJSON、版本、精确字段、唯一请求引用和对应回答。每次仅一个请求等待且立即 flush；帧上限1MiB。不完整帧、等待输入时 EOF、畸形/错配/超限失败并返回脱敏错误，不将 raw stderr/provider body 暴露给用户。
- `start.trusted_context` 是 v6 必需判别字段。`null` 保留 legacy 原工具/批准/等待/快照/预算和原模型策略；非空仅接受 `version:1`、`delegation/1`、`request-bound` 与冻结时间能力、受管工作区安全摘要集合。完整嵌套字段严格校验，UTC 锚为秒精度 `...Z`；本轮 input_message_id 必须指向实际 user 消息。可信上下文单独进入 system 层，用户/资料/观察不会升级为可信指令。
- 新 profile 按实际冻结的工具和工作区集合使用已交付能力，不走 legacy direct routing 或 task 逐项批准。空集合不授予资料工具，可写工具还需冻结摘要含可写路径；旧 Run 不因修订号获得工具。明确保存/清除本人默认时区可自主执行；只本次指定时区不意味着保存。资料正文不能扩大委托，request-bound 不承诺离开后继续。
- `finish_goal` 是模型控制出口，不是领域工具，也不预约 invocation。native 验证有界 GoalResult、逐项/聚合状态、clarification 和已接受收据 UUID 后发送同名请求及累计 usage；TS 按真实归属与领域事实原子保存结果/最终 answer/终态。完成一个工具不会自动完成目标；普通最终正文必须在原预算内再经模型提交结构化出口，不偷换为成功。设置观察不投影丢弃，模型工具观察含实际 invocation_id（不是 provider call ID）。失败/预算仍走原 `finish(failed)`，由 TS 保留既成/unknown 事实；取消已在 TS 提交，native 不制造第二终态。
- 模型 transport 请求真实 `stream:true`。native 逐次接收当前模型请求的增量或完整结果；每个正文增量先通过原 `answer` 请求取得 TS 持久接受回执，再以相关的 `model_next` 拉取后续，仍只有一个请求等待。最终完整结果只用于工具解析、模型历史及用量，不重复发送正文。工具参数必须完整并校验后才能执行；中断/畸形流明确失败，取消或 native exit 关闭 provider reader，不把完整 JSON 或打字动画作为流式回退。
- 公开 `answer.delta` 非空且最多4000个 UTF-16 单位，传输只在真实 provider 增量过大时按 Unicode 标量边界细分；每帧对应一次接受。已出现的部分正文不表示成功，最终用量和工具决议仍独立核对。默认系统上下文指示简体中文回复，用户明确指定其他语言时遵从；此指令同样用于批准恢复，不由前端翻译。
- 聚合 start 与最终 model/measure 帧、完整 HTTP body 均按实际 UTF-8 JSON 序列化核验1MiB，不提高门槛。完整冻结输入/系统规则、新返回全文至少一次真实模型请求可见机会、新的全文修改基线及不可省略执行事实受保护。压力下 native 才经 `context_source(projected)` 按接受顺序投影已被模型看到的旧观察；不会把可写授权误当成永久保留所有历史正文的理由。精确动作使用新呈现的全文/片段，原完整修改基线仍由 TS 账核对；无 `read_run_observation` 资格的旧 Run 不淘汰唯一正文。无合法缩减则 `HARNESS_CONTEXT_LIMIT`，不发下一模型或工具。64个已接受工具引用达到上限后不再预约，投影从不删除 snapshot2 引用。
- native 从可信消息/工具描述/实际接受观察构造上下文，每步只预约一个 `harness/N`，以原 UUID invoke，逐次等待真实结果后才选择下一步；即使独立读取也不并行。TS transport 发送 `parallel_tool_calls:false`，供应商仍返回多个提议时完整校验，native 不预约、不执行任何一项，说明未执行并在原预算内要求逐项选择；不会只取第一项或重试既成/未知效果。参数仍经 TS strict schema 重验。单工具调用同时附带的非空 model content 先经原 `answer` 通道展示，并保留为 assistant 模型历史；这是简短可调整的可见计划/进度，不是隐藏推理。
- 当前 attempt 的函数历史由 native 保持标准结构：`assistant.tool_calls` 保存实际提议，`role=tool` 以原 `tool_call_id` 配对真实结果；不把工具提议拼成普通 assistant 文本来替代调用。缩减时整对移出，替换为明确不可信的普通观察资料，绝不留下孤立 tool、悬空调用或重写参数冒充历史。TS 原样传输消息，不选择缩减顺序或组织 agent loop。恢复 start 使用每个完整引用对应的 typed full/projected 观察；snapshot2 保存全部事实引用，恢复不承诺复原上 attempt 函数历史。
- `start.workspace` 可省略或为 null；非空仅接受 `{workspace_id,label,readable_paths,writable_paths}`。native 严格拒绝额外字段（包括 root）、空标识/标签、重复路径、非规范 POSIX 相对文件路径及不属于 readable_paths 的 writable_paths；安全摘要作为可信上下文传给模型，真实 root 不进入 native。
- legacy workspace 工具保留原合同；新 delegation 可按冻结 allowlist 使用 `workspace_list/workspace_grep/workspace_read/workspace_replace/workspace_propose_replace/workspace_apply_replace`。读取显式指定 workspace_id，正常编辑从本 Run 完整读取直接编译，新增影响才提案；批准只授权原冻结替换，不是写入成功。写后必须新真实全文读取才可称验证，unknown 不重试，只有明确零写版本冲突可新读重算。观察投影可保留 workspace_id，分页不等于真实新读取。恢复与每次新动作仍由 TS 核验当前来源工具和登记。
- 累计迭代和可得 tokens 由 native 强制，批准恢复从 snapshot2 延续 usage 和 next_call_no，不重置预算；缺 usage 后累计 tokens 保留 null，无字符/费用估算。停止或超限后不安排后续步骤，已发生事实保留。
- 流式沿用 `model` → `delta` →（逐条持久 `answer` ack）→ `model_next` 拉取，只有 `complete` 或显式 `failed` 才收尾，在途不插入测量/投影。每次真实模型请求恰计一次 iteration；failed 携带可得实际 usage，缺失则累计 unknown；已接受 delta 不撤销。length/明确窗口拒绝为 `HARNESS_CONTEXT_LIMIT`，不执行不完整函数，不自动裁剪重试；计量拒绝不增加 iteration。
- task `kind=approval` 的 `approval.approvalId` 与 document `kind=document_approval` 的 `approval.approval_id` 均先保存原 invocation/批准及有限上下文，再在 suspend ack 后退出。waiting 仅含 invocation_id/approval_id，不由 native 声明批准种类。
- 恢复读取原接受事实与带明确 kind 的真实当前决议。task consumed 必须有真实 task_id；delegation 不允许 task 批准。document pending/rejected 不调用模型或重提；approved 仅作为授权观察继续，原提议必须来自冻结的提案工具且目标属于冻结可写路径，由模型选择原批准的 `workspace_apply_replace({approval_id})`，再新调用 `workspace_read` 核验，不由 TS 固定编排工具。
- snapshot2 保存有限已接受引用、usage、next_call_no 与等待身份，不保存工具参数或完整推理链。收到 unknown 立即 `finish(failed,TOOL_EFFECT_UNKNOWN)`，不加入 toolRefs、不推进调用号、不发 checkpoint/suspend、不再模型/预约；failed 与 legacy denied 保存 checkpoint 后沿原错误失败，不伪装成功。
- delegation/1 区分输入/规则拒绝与硬权限拒绝：`UNKNOWN_TIMEZONE` / `TZDB_UNAVAILABLE` 可作为真实观察继续反馈；`TOOL_FORBIDDEN` / `TOOL_DENIED` 后只允许说明结果和 `finish_goal`。后续业务提案在 native 本地拒绝，不 reserve/invoke、不伪造接受结果、不重置预算；TS 同时依据本 Run 的不可变接受拒绝账阻止后续预约和执行，不能靠直接调用网关绕过。已接受设置和拒绝观察仍可供真实 blocked/partial 收尾。
- 历史 snapshot1 仅由 TS 在无 workspace grant、引用均为已完成的旧业务/task 能力且不含 document 批准时读取并构造 snapshot2 bootstrap；不改写历史行，不把 v1 发给 native，不保留旧执行器回退。
- TS 先持久取消再通知/终止 native 并 abort 模型请求；native 观察 cancel 后不继续。终止进程不撤销已接受工具或已消费按钮确认的任务。
- `start` 必须携带冻结 `routing_policy`（旧 Run 为 null）与 `eligible_phase`。仅 fresh 首模型前且策略启用时请求一次 facts；完整规则命中优先，否则只请求一次 embedding。全竞争第一/第二类、同分、固定排除及每意图双阈值共同决定候选；shadow 总提交 fallback，off/旧 Run/恢复零 probe。fallback 不修改原上下文或预算。
- direct 的唯一决议接纳后仅使用原 `harness/N` reserve/invoke，保存真实工具引用的 snapshot2，再以 decision/invocation 引用请求固定 renderer；从不伪造 provider toolcall 或发送自编 answer。成功 finish 的真实模型 iterations/tokens 均为0；reserve/invoke/snapshot/render 任一步失败或 denied/unknown 都不转模型、不开第二 slot。普通 answer 仅转发真实 provider delta。

## 证据边界

fresh 构建与 pipe smoke 证据必须绑定源和二进制 hash；仅 leaf pipe 不证明 API/PG 原子性、Web、真实 provider、完整 R1/模型质量、任意崩溃恢复或其他架构。真实模型的隔离探针只证明该次模型/传输行为，不是 Web→TS→native→工具→实际文档/新回读的全链验收；受控模型合同同样不冒充真模型。最小接入、跨语言消费者门、完整 R1 分级边界见 `docs/design/11-cangjie-runtime-spike.md` §4。
