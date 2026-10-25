# 仓颉原生 Harness

生产源位于本目录，目标平台 Linux x86_64，仅使用继承的 stdin/stdout 交换 `harness/v1`。不监听端口、不持有模型凭据、不包含 fixture 或网络 transport。准确 wire DTO 见 `packages/contracts/src/harness.ts`；身份、授权、调用预约、效果、批准与持久事实由 TypeScript 裁决。

## 可复现构建与安装

Linux/WSL 安装 Bun1.4.2、Docker 后执行根入口 `bun run build:harness`，或 `bash scripts/build-harness.sh`。它构建 `infra/docker/Dockerfile` 的独立 `harness-artifact` 目标，默认导出到 `apps/harness/dist`。builder 包含 GCC、binutils、C/C++ 开发库和按 `artifacts.lock` 校验的 SDK/stdx；`cjpm build --skip-script` 编译本目录正式源，不接受全局 SDK 或旧二进制。`cjpm.lock` 固定包依赖，`artifacts.lock` 单独固定二进制路径依赖；stdx hash 是官方 release 的本地计算值，不是独立发布者证明。

也可执行 `docker build --target harness-artifact --output type=local,dest=/tmp/along-harness -f infra/docker/Dockerfile .`。导出包括 `bin/along-harness`、实际链接的 SDK/stdx 动态库闭包 `lib/`、官方及第三方许可 `notices/`、源与产物 SHA256。API 使用 `HARNESS_BINARY=/tmp/along-harness/bin/along-harness` 和 `HARNESS_LIBRARY_PATH=/tmp/along-harness/lib`；直接运行二进制使用 `LD_LIBRARY_PATH=/tmp/along-harness/lib`。正式 API 镜像将该构建阶段复制到 `/app/harness/` 并配置这些路径。

`bun run harness:prepare /opt/along-toolchain` 是显式 Linux 下载入口，先校验再解包；依赖 bash/curl/sha256sum/tar/unzip，构建不运行 cjpm hooks 或下载隐式依赖。Docker builder 是正式编译环境；原生 Windows 和其他架构不在该 artifact lock 支持范围。

## 模型传输配置

安装 native 不会自动选供应商或启用 fixture。API 启动时读取：

- `HARNESS_MODEL_BASE_URL`：OpenAI-compatible API 根地址，后接 `chat/completions`；仅显式服务端配置。
- `HARNESS_MODEL`：模型名；`HARNESS_MODEL_API_KEY` 可选，只留 TS transport，不传给 native。
- `HARNESS_BINARY`：默认 `/app/harness/bin/along-harness`；`HARNESS_LIBRARY_PATH`：默认 `/app/harness/lib`。

缺模型配置或不可执行产物时新 harness Run 在写入/SSE 前503 `HARNESS_UNAVAILABLE`，默认 business 不受此可选配置影响，不回退到 TS Agent/fixture。部署者设置变量；不将真实值写入仓库 `.env`。服务端起步8迭代/8000 token 在 Run 接受时冻结；未知 usage 不能保证可证明的费用上限。

## 执行与失败合同

- 两端验证有界 UTF-8 NDJSON、版本、精确字段、唯一请求引用和对应回答。每次仅一个请求等待且立即 flush；帧上限1MiB。不完整帧、等待输入时 EOF、畸形/错配/超限失败并返回脱敏错误，不将 raw stderr/provider body 暴露给用户。
- native 从可信消息/工具描述/实际接受观察构造上下文，解析最多一个提议，预约 `harness/N`，以原 UUID invoke，消费真实结果后继续/停止。并行提议明确失败，参数仍经 TS strict schema 重验。
- 累计迭代和可得 tokens 由 native 强制，缺 usage 后累计 tokens 保留 null，无字符/费用估算。停止或超限后不安排后续步骤，已发生事实保留。
- 批准结果先保存原 invocation/批准及有限上下文，再在 suspend ack 后退出。恢复读取原接受事实与真实当前决议；consumed 纳入真实 task ID 后正常继续原预算/计数，不再 invoke 原动作；拒绝/过期/替代立即停止，不跟 successor 或同义绕拒绝。
- snapshot 保存有限引用、usage、next_call_no 与等待身份，不保存工具参数或完整推理链。unknown/denied/failed 不伪装成功终结。
- TS 先持久取消再通知/终止 native 并 abort 模型请求；native 观察 cancel 后不继续。终止进程不撤销已接受工具或已消费按钮确认的任务。

## 证据边界

fresh 构建与 pipe smoke 证据必须绑定源和二进制 hash；仅 leaf pipe 不证明 API/PG 原子性、Web、真实 provider、完整 R1/模型质量、任意崩溃恢复或其他架构。最小接入、跨语言消费者门、完整 R1 分级边界见 `docs/design/11-cangjie-runtime-spike.md` §4。
