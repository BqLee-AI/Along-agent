# #168 Microsoft Learn 只读远程 MCP 验证记录

日期：2026-11-23。范围：`feat/168-microsoft-learn-mcp`，基于 OpenSpec-only commit `e54928a571`；[草稿 PR #170](https://github.com/BqLee-AI/Along-agent/pull/170) 先于源码实现建立。本文记录实际证据，不代表原安装或完整产品验收通过，不归档 change、不关闭 issue。

## 实验与真实服务

- 使用 Bun 1.4.2、`@modelcontextprotocol/client` 2.4.0，无认证访问固定 `https://learn.microsoft.com/api/mcp`。
- 14:14:21–26 UTC：协商 MCP `2025-06-18`；发现 3 工具，无 cursor，发现响应 4950 bytes。仅 `microsoft_docs_search` 进入产品；不开放 `microsoft_code_sample_search`、`microsoft_docs_fetch`。
- 查询：`Azure Database for PostgreSQL Flexible Server backup retention period point-in-time restore`。真实搜索返回 10 条 `title/content/contentUrl`，响应 48297 wire bytes，摘录 859–2475 bytes。
- 14:45 UTC：通过应用真实新 Run 接纳、固定协议适配、只读 invocation 网关和 PostgreSQL 接受账本，再次查询真实服务，返回 10 条官方来源。该步骤使用隔离的合成账户和模型配置接纳，不执行模型或 native，不冒充用户对话。
- 接受结果包含实际 UTC 抓取时间及 `representation:'search_excerpts'`；来源例：[备份与恢复](https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore)、[备份频率与保留](https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore#backup-frequency-and-retention)。同 invocation 返回 `replayed:true`；断开后返回 denied，审计序列为 accepted/success、replayed/success、denied/denied。

本地证据：`D:/Temp/along-168/mcp-experiment/public-sanitized.json`、`controlled.json`、`real-gateway-result.json`。受控取消/容量/失败不是 Microsoft 实际发生的故障。

## 行为覆盖与测试策略

连接路由测试先行：实现前实际观察初始状态 GET 返回 404，而目标为 200（Red）；实现后的 4 文件集中验证为 **42 pass、0 fail、229 assertions**。协议先做真实 SDK 最小实验；协议、消费者和网关边界测试为实现后覆盖，不宣称全程 TDD。

| 范围        | 证据与观察                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本人连接    | `remote-mcp-connection.test.ts`：匿名、Origin/CSRF、额外配置拒绝；owner 隔离；重复连接保留代次，重连换代次；状态和操作零上游                                                                |
| 冻结与执行  | `remote-mcp-gateway.test.ts`：旧 Run 不扩权、其他 owner 无工具；精确内容哈希、只追加审计；有效重放零上游；断开后旧代次零上游；公开历史仍可读取                                              |
| 接受栅栏    | 同测试：真实 DB 下延迟上游响应，先提交断开或取消，迟到成功不得保存；服务失败记录 typed error                                                                                                |
| 协议与容量  | `remote-mcp-client.test.ts`：真实 SDK 配受控 HTTP/JSON/SSE；严格发现、无分页、固定工具、错误/非文本/非官方来源拒绝，逐字段及整个响应界限；逐请求资格复查、caller abort 与共享 deadline 分开 |
| TS 合同     | `packages/contracts/test/remote-mcp.test.ts`：严格字段、URL authority、UTF-8、精确 65536-byte payload 边界                                                                                  |
| 正式 native | 当前源码构建的 Linux x64 production native；`apps/harness/test/contracts/r3-context-native.test.ts` 覆盖工具接纳、实际 receipt、R3 恢复和无效结果拒绝                                       |
| Web 请求    | `apps/web/test/remote-mcp-connection.test.ts`：**3 pass、0 fail、72 assertions**；请求体、精确代理边界、取消与错误不重试                                                                    |

生产镜像 `along-168:acceptance` 构建成功。WSL 执行正式 wrapper 遇到 `Wsl/Service/E_UNEXPECTED`，改为在该镜像中执行 `scripts/ci/contracts.sh` 的原消费者命令与 JUnit 检查，使用任务自有隔离 PostgreSQL 16：**404 pass、1 skip、0 fail**，D8 当次报告检查通过。跳过项为既有 SDK 外部依赖测试，不将其记为通过。

`bun run verify` 最终 **10 步全通过**，包括 lint、全 workspace typecheck、依赖边界、门禁声明、冻结词、文案、unit、15 项 OpenSpec strict 和格式检查。日志：`D:/Temp/along-168/verify-fixed.log`、`contracts-docker.log`、`backend-tests.log`、`web-tests.log`。

生命周期单独使用任务自有 PostgreSQL 16 新库验证：空库 initialize 后为 `supported/0042/target_schema_verified`；按仓库合并版迁移建立的 0041 为 `supported/explicit_upgrade_required`，正式 upgrade 后为 `supported/0042/target_schema_verified`。证据为 `lifecycle-fresh.log`、`lifecycle-upgrade.log`。它们证明新迁移及 manifest，不证明原实验安装已修复。

全量集成集使用 production 镜像、同一隔离 PG 和显式合成 `BETTER_AUTH_SECRET`：**750 pass、2 fail**。失败在未修改的 `memory-semantic.test.ts`：并行运行中 stalled recall 的 4000ms 上限观察到 4431ms；该断言先失败，导致其后的 stopRecall 清理未执行，同文件后续索引断言收到 3 项而非 2 项。没有放宽阈值、删除覆盖或修改记忆实现；不能声称全量集成门通过。日志：`integration-configured.log`。更早一次集成启动缺少合成认证 secret，是环境错误，不作为行为验证。

停止并行负载后，保持同一镜像和 DB 配置仅执行该失败文件：**7 pass、0 fail**（`memory-isolated.log`）。该结果支持失败与运行负载及清理连锁有关，但不是全量集成集重新通过的证据；未修改该文件或业务实现。

## 实际 Web 表面

在隔离合成账户与真实 API 上启动本次 production Web 构建产物，经浏览器操作 `/connectors`：初始未启用 → 点击连接 → 显示已启用及断开按钮 → 点击断开 → 恢复未启用。没有修改页面状态或插入控件。认证准备使用测试 helper 生成的有效签名会话 Cookie，不是原安装用户登录。

视觉证据：`D:/Temp/omp-sshots-15d98813bf11c779.webp`（已启用）、`D:/Temp/omp-sshots-15d988264111c77a.webp`（已断开）。这是隔离 UI/API 验证，不替代原安装、新对话模型调用和最终引用展示验收。

## 原安装阻塞与未覆盖项

复用 #155 的既有私有安装配置，未创建第三套安装、未修改密钥或 `.env`。原安装可用其原 artifact 启动；默认安装保存的登录资料与此安装不匹配，未重置账户。

随后尝试同配置 `local:upgrade`。候选构建完成，但原库在迁移前被拒绝：`UNSUPPORTED_UPGRADE_SOURCE`；只读分类为 `unknown/version0041/baseline_foreign_keys_mismatch`。原 artifact 的 `0041-checks.json` 没有合并版本要求的 `messages.source_run_id`、`feishu_pending_disclosures` 等结构；同一迁移编号对应不同历史实验结构。未应用 `0042`，未改旧迁移、未清库或伪造升级完成。按照生命周期合同，原安装保留未完成升级记录和停止写者，未恢复旧写者。

未完成：原安装前滚修复、该安装正式登录、新对话经真实模型/native 查询 Microsoft Learn、最终答案引用和该对话的历史恢复。不能把隔离网关、受控 native 或隔离连接卡证据算作这些项目。A1 保持未勾选；需先明确处理该安装的历史实验 schema 差异，并取得对应登录路径，再完成验收。
