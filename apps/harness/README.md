# 仓颉原生 Harness

生产源位于本目录，目标平台 Linux x86_64，仅使用继承的 stdin/stdout 交换 `harness/v3`，不混跑旧 wire；snapshot 仍仅接受/输出 `version: 2`。不监听端口、不持有模型凭据、不包含 fixture 或网络 transport。准确 wire DTO 见 `packages/contracts/src/harness.ts`；身份、授权、调用预约、效果、批准与持久事实由 TypeScript 裁决。

## 可复现构建与安装

Linux/WSL 安装 Bun1.4.2、Docker 后执行根入口 `bun run build:harness`，或 `bash scripts/build-harness.sh`。它构建 `infra/docker/Dockerfile` 的独立 `harness-artifact` 目标，默认导出到 `apps/harness/dist`。builder 包含 GCC、binutils、C/C++ 开发库和按 `artifacts.lock` 校验的 SDK/stdx；`cjpm build --skip-script` 编译本目录正式源，不接受全局 SDK 或旧二进制。`cjpm.lock` 固定包依赖，`artifacts.lock` 单独固定二进制路径依赖；stdx hash 是官方 release 的本地计算值，不是独立发布者证明。

也可执行 `docker build --target harness-artifact --output type=local,dest=/tmp/along-harness -f infra/docker/Dockerfile .`。导出包括 `bin/along-harness`、实际链接的 SDK/stdx 动态库闭包 `lib/`、官方及第三方许可 `notices/`、源与产物 SHA256。API 使用 `HARNESS_BINARY=/tmp/along-harness/bin/along-harness` 和 `HARNESS_LIBRARY_PATH=/tmp/along-harness/lib`；直接运行二进制使用 `LD_LIBRARY_PATH=/tmp/along-harness/lib`。正式 API 镜像将该构建阶段复制到 `/app/harness/` 并配置这些路径。

`bun run harness:prepare /opt/along-toolchain` 是显式 Linux 下载入口，先校验再解包；依赖 bash/curl/sha256sum/tar/unzip，构建不运行 cjpm hooks 或下载隐式依赖。Docker builder 是正式编译环境；原生 Windows 和其他架构不在该 artifact lock 支持范围。

Docker 使用 BuildKit 下载缓存保留 SDK/stdx 压缩包，构建失败后重试不必丢弃已完成的下载。文件按锁定 SHA-256 命名，不让不同版本共用一个文件名；每次仍按 `artifacts.lock` 校验，再重新解包编译，不信任全局 SDK 或旧 native。缓存由本机 builder 管理，可被清理，不纳入源码、镜像运行层或发布输入；换 builder 或缓存缺失时仍需下载官方产物。

若下载慢或出现 HTTP/2、TLS 中断，先比较宿主与 Docker 的真实网络路径，不能只凭协议错误认定上游限速。TUN/fake-IP 可能让国内官方站点也走代理；仅设置 `--noproxy` 不保证绕开 TUN。可以在宿主使用 curl 绑定物理网卡，并用当次解析到的官方真实 IP 保持域名、SNI 和证书校验；不要永久写死 IP、关闭 TLS 校验或切换全局代理。完整包仍须匹配锁定 SHA-256，发布继续走原安装的成套升级入口。

仓库将 shell 脚本及其 `artifacts.lock` 固定为 LF，避免 Windows checkout 的 CRLF 使正式容器构建失败；不修改开发者全局 Git 配置。

## 正式跨语言合同门

Linux x64 / WSL 执行根 `bun run test:contracts`。入口从当前树构建生产镜像，在同一 Bun/native runtime 中运行真实本地公共用例与签名 HTTP 合同；自行建立私有网络、全新 PG16 和测试身份，不需要已有数据库或模型凭据。旧 healthz/契约包保留，必需消费者须在本次实际报告中唯一通过，缺失或跳过不能放行。成功、失败均清理本次容器、卷、网络和镜像标签。

unknown 与取消后迟到调用另验证真实非事务调用核心到 native 的停止/资格边界；内部文件探针不是产品工具。unknown 不生成 checkpoint，不能冒充生产可恢复快照。D8 的有限 enforced 和 remaining/partial 规则见 `docs/design/13-p0-bootstrap-and-ci-rules.md` §4.2，不代表真实 provider、所有连接器或完整 R1。

## 模型传输配置

安装 native 不会自动选供应商或启用 fixture。普通用户不配置 provider/BYOK；供应商、模型与预算由部署服务端固定。API 启动时读取：

- `HARNESS_MODEL_BASE_URL`：OpenAI-compatible API 根地址，后接 `chat/completions`；仅显式服务端配置。
- `HARNESS_MODEL`：模型名；`HARNESS_MODEL_API_KEY` 可选，只留 TS transport，不传给 native。
- `HARNESS_BINARY`：默认 `/app/harness/bin/along-harness`；`HARNESS_LIBRARY_PATH`：默认 `/app/harness/lib`。
- `HARNESS_MAX_ITERATIONS`：部署服务迭代预算，默认24；`HARNESS_MAX_TOKENS`：累计 token 预算，默认64000；均须为正安全整数，非法配置不启用 Harness。它们不是 Web/模型可覆盖的请求字段，Run 接纳后冻结，跨批准恢复的 attempt 累计，不因部署配置后来变化重置。当前默认值不等于真实 R1 预算已获校准或全链验收。

缺模型配置或不可执行产物时新 harness Run 在写入/SSE 前503 `HARNESS_UNAVAILABLE`，默认 business 不受此可选配置影响，不回退到 TS Agent/fixture。部署者设置变量；不将真实值写入仓库 `.env`。服务端提供并在 Run 接受时冻结迭代/token 预算；native 不另设 R1 默认轮数，未知 usage 不能保证可证明的费用上限。

## 执行与失败合同

- 两端验证有界 UTF-8 NDJSON、版本、精确字段、唯一请求引用和对应回答。每次仅一个请求等待且立即 flush；帧上限1MiB。不完整帧、等待输入时 EOF、畸形/错配/超限失败并返回脱敏错误，不将 raw stderr/provider body 暴露给用户。
- 模型 transport 请求真实 `stream:true`。native 逐次接收当前模型请求的增量或完整结果；每个正文增量先通过原 `answer` 请求取得 TS 持久接受回执，再以相关的 `model_next` 拉取后续，仍只有一个请求等待。最终完整结果只用于工具解析、模型历史及用量，不重复发送正文。工具参数必须完整并校验后才能执行；中断/畸形流明确失败，取消关闭 provider reader，不把完整 JSON 或打字动画作为流式回退。
- 公开 `answer.delta` 非空且最多4000个 UTF-16 单位，传输只在真实 provider 增量过大时按 Unicode 标量边界细分；每帧对应一次接受。已出现的部分正文不表示成功，最终用量和工具决议仍独立核对。默认系统上下文指示简体中文回复，用户明确指定其他语言时遵从；此指令同样用于批准恢复，不由前端翻译。
- 聚合 bootstrap/快照观察与 model 请求按实际 JSON 序列化核验1MiB，native 另累计转义后消息字节并在发帧前核验；无法完整承载时以 `HARNESS_CONTEXT_LIMIT` 有界失败，不截断历史或发出超限帧。64个已接受工具引用达到上限后不再预约；等待快照先核验其等价 bootstrap，恢复在分配新 attempt 前再次核验，不建立无法承载的恢复点。
- native 从可信消息/工具描述/实际接受观察构造上下文，解析最多一个提议，预约 `harness/N`，以原 UUID invoke，逐次等待真实结果后才选择下一步；即使独立读取也不并行。TS transport 发送 `parallel_tool_calls:false`，但该参数不保证供应商遵守；provider 回复 schema、共享回复 schema 与 native 均拒绝单响应多个调用，不只取第一项。参数仍经 TS strict schema 重验。工具调用同时附带的非空 model content 先经原 `answer` 通道展示，并保留为 assistant 模型历史；这是简短可调整的可见计划/进度，不是隐藏推理。
- 当前 attempt 的函数历史由 native 保持标准结构：`assistant.tool_calls` 保存实际提议，`role=tool` 以原 `tool_call_id` 配对真实结果；不把工具提议拼成普通 assistant 文本来替代调用。TS 原样传输该消息结构，不组织历史或选择后续工具。批准恢复的 bootstrap 可将已接受事实作为明确数据摘要纳入上下文；snapshot 仍只保存事实引用，不持久化完整函数历史。
- `start.workspace` 可省略或为 null；非空仅接受 `{workspace_id,label,readable_paths,writable_paths}`。native 严格拒绝额外字段（包括 root）、空标识/标签、重复路径、非规范 POSIX 相对文件路径及不属于 readable_paths 的 writable_paths；安全摘要作为可信上下文传给模型，真实 root 不进入 native。
- workspace 工具仅为 `workspace_list/workspace_grep/workspace_read/workspace_propose_replace/workspace_apply_replace`。前三个只读经 TS 的薄 MCP 能力；提案绑定本 Run 接受的全文 read，批准只授权原冻结替换。每个批准只绑定一个 `non_transactional` apply invocation，成功仍须新 read 证明结果；TS 在 done 前核对真实效果链，不代替模型编排。冻结历史可读不等于新动作获权：恢复与每次新动作仍核验当前 workspace 登记。
- 累计迭代和可得 tokens 由 native 强制，批准恢复从 snapshot2 延续 usage 和 next_call_no，不重置预算；缺 usage 后累计 tokens 保留 null，无字符/费用估算。停止或超限后不安排后续步骤，已发生事实保留。
- task `kind=approval` 的 `approval.approvalId` 与 document `kind=document_approval` 的 `approval.approval_id` 均先保存原 invocation/批准及有限上下文，再在 suspend ack 后退出。waiting 仅含 invocation_id/approval_id，不由 native 声明批准种类。
- 恢复读取原接受事实与带明确 kind 的真实当前决议。task consumed 必须有真实 task_id，纳入结果后继续原预算/计数，不再 invoke 原动作；pending/拒绝/过期/替代立即停止，不跟 successor 或同义绕拒绝。document 决议仅含 kind、approval_id、pending|approved|rejected 和可空 apply_invocation_id，不伪造 task_id；pending/rejected 不调用模型或重提，approved 作为授权观察继续同一 bootstrap，由模型选择原批准的 `workspace_apply_replace({approval_id})`，再新调用 `workspace_read` 核验，不将批准当写入完成，也不由 TS 固定编排工具。
- snapshot2 保存有限已接受引用、usage、next_call_no 与等待身份，不保存工具参数或完整推理链。收到 unknown 立即 `finish(failed,TOOL_EFFECT_UNKNOWN)`，不加入 toolRefs、不推进调用号、不发 checkpoint/suspend、不再模型/预约；已接受的 denied/failed 仍保存 checkpoint 后按原错误正常失败，均不伪装成功。
- 历史 snapshot1 仅由 TS 在无 workspace grant、引用均为已完成的旧业务/task 能力且不含 document 批准时读取并构造 snapshot2 bootstrap；不改写历史行，不把 v1 发给 native，不保留旧执行器回退。
- TS 先持久取消再通知/终止 native 并 abort 模型请求；native 观察 cancel 后不继续。终止进程不撤销已接受工具或已消费按钮确认的任务。

## 证据边界

fresh 构建与 pipe smoke 证据必须绑定源和二进制 hash；仅 leaf pipe 不证明 API/PG 原子性、Web、真实 provider、完整 R1/模型质量、任意崩溃恢复或其他架构。真实模型的隔离探针只证明该次模型/传输行为，不是 Web→TS→native→工具→实际文档/新回读的全链验收；受控模型合同同样不冒充真模型。最小接入、跨语言消费者门、完整 R1 分级边界见 `docs/design/11-cangjie-runtime-spike.md` §4。
