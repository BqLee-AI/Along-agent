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

## 前轮原安装尝试（历史记录，不是本功能验收前提）

复用 #155 的既有私有安装配置，未创建第三套安装、未修改密钥或 `.env`。原安装可用其原 artifact 启动；默认安装保存的登录资料与此安装不匹配，未重置账户。

随后尝试同配置 `local:upgrade`。候选构建完成，但原库在迁移前被拒绝：`UNSUPPORTED_UPGRADE_SOURCE`；只读分类为 `unknown/version0041/baseline_foreign_keys_mismatch`。原 artifact 的 `0041-checks.json` 没有合并版本要求的 `messages.source_run_id`、`feishu_pending_disclosures` 等结构；同一迁移编号对应不同历史实验结构。未应用 `0042`，未改旧迁移、未清库或伪造升级完成。按照生命周期合同，原安装保留未完成升级记录和停止写者，未恢复旧写者。

前轮未完成原安装的新对话、引用和历史路径。后续审查明确使用任务隔离的正式安装验收；旧实验 0041 差异与本功能分离，不要求先修复它，也不再操作该安装。前轮隔离网关、受控 native 和连接卡证据只覆盖各自明确的边界。

## 本轮精确出站查询修正

合入 #170 的 `4567b377`，merge commit `72379bf`。连接不再给普通聊天授予工具。会话固定快捷入口提交与 raw_text 完全相同的 `microsoft_learn_query`，本人签名与连接校验后冻结 `{generation,query}`；Unicode 码点上限为 500，保留原始空白和标点。模型只能用 `{}` 触发；历史、摘要、受管资料和工具结果不能替换查询。同键加入、移除或更改查询绑定均冲突。

先修改现有网关行为测试，实际 Red 为“已连接的普通聊天仍有 learn_docs_search”（`review-red.log`），再调整接纳与网关。新增覆盖包括精确中文/空格/标点/emoji 的实际 SDK 出站参数、500/501 码点、无效会话、普通下一轮、幂等重放/冲突和冻结上下文恢复。沿用前轮断开、取消、容量、错误及审计证据，不重复全量集成或全量消费者套件。

本轮首次运行前的 `docker ps -a`：`along-e5c913a69f054844-postgres-1` 运行且健康；`along-e5c913a69f054844-api-1` 已退出 0。本轮没有停止旧容器。前轮正式 upgrade 停止的 API 容器为 `along-e5c913a69f054844-api-1`，Web 为 Windows 进程；前轮首次 start 前是否运行没有足够保留证据，不能由后续状态反推。证据：`review-initial-containers.json`。本轮只新建任务自有 `along-168-review` 正式安装和 `along-168-review-pg` 测试库，不接入旧安装。

### 本轮最终增量检查

- 全 workspace typecheck 通过。5 个聚焦文件 **63 pass、0 fail、431 assertions**：TS Learn 合同、真实 SDK 适配、PG 网关接纳/幂等/恢复/撤权、会话入口请求流和展示。`review-typecheck-final.log`、`review-focused-final.log`。
- 正式镜像只运行 Learn native 用例：**1 pass、0 fail、83 assertions**，22 个无关用例按名称过滤；包括实际 receipt、精确查询、Unicode 边界和 R3 恢复。`review-native-final.log`。
- lint、依赖边界、此 change strict、格式检查通过；没有重跑旧的全量 verify、404 消费者或全量集成集。对应 `review-{lint,depcruise,spec,format}-final.log`。

### 隔离正式安装全链路

负责人 `FormalLearnAcceptance` 使用正式 `local:init --new`、`local:start`，均退出 0，数据库 0042。源快照 digest `d35eb49240182ba8e3449fc8646460f89c6bf0ce0d5b4ba7ea675642b0759544`，image ID `sha256:319328a2334bb15c8df272e01c3bf43b281a58c493f6f961df2fcdb2d2f30af5`。Docker 默认地址池耗尽，单独创建本任务 Compose bridge 后重试；未停止或改动任何旧项目。通过真实产品 Web 初始化合成管理员、配置并选择受控模型、启用连接，没有 seed session 或直接 SQL 建号。

实际输入为 `  Azure PostgreSQL 备份，retention? 🧪  `，包含两端各两个空格。选择入口与填写阶段，浏览器请求、模型请求、MCP 派发均为 0。点击发送后 HTTP 200，经正式 API/native 调用 `learn_docs_search {}`；捕获的真实 `tools/call` 为 `microsoft_docs_search`，query 与已提交全文逐码点相等。Microsoft 实际返回的公开资料进入已接受观察，受控模型使用该观察中的真实来源生成答案；浏览器显示三条带链接摘录，刷新与历史侧栏重开均仍可见。随后同会话普通消息没有 Learn 工具，MCP 派发数不增加。

证据边界：模型决策及最后排版由受控 OpenAI-compatible endpoint 生成，不证明真实 LLM 自主选工具或回答质量；Microsoft MCP 和来源内容是真实服务。为了观察真实派发，临时只读 Bun preload 仅记录固定 MCP POST 并原样调用原 fetch，没有修改请求或伪造结果；该观察命令与未经插桩启动分别记录。之后已通过正式 stop/start 移除探针，API readiness 200，两个回合仍能展示。没有配置工作区，因此此产品路径不宣称覆盖真实受管文件组合攻击；网关额外参数拒绝、固定冻结值等边界由聚焦测试保护。

脱敏证据：`D:/Temp/along-168/review-e2e-result.json`；截图 `review-e2e-query-before-submit.png`、`review-e2e-learn-answer.png`、`review-e2e-learn-history.png`、`review-e2e-ordinary-follow-up.png`。私有合成凭据与完整模型请求不入库。隔离安装保留供主审，本轮旧安装原状未改；测试库与受控模型仅属于本任务。

## 2026-11-24：CI 生命周期目标版本修正

`88e25b7bc3836776a2de196736c5345fb12ab96e` 的 [Actions 45210009153](https://github.com/BqLee-AI/Along-agent/actions/runs/45210009153)：checks、integration 通过；database 的生命周期阶段 27 pass、60 fail，失败均为旧目标期望 `0041` 与正式发布目标 `0042` 不符。以保存的 CI 日志 `D:/Temp/along-168/review-ci-database-failed.log` 为 Red，不为确认已知失败重复运行旧断言。

只修改 `scripts/test/local-{116-convergence,direct-reminder-database,goal-database,invited-database}.test.ts` 的当前目标版本期望与 goal 升级用例标题；三个完整 ledger 序列保留 `0041` 并追加 `0042`。历史来源版本与迁移目录截断、拒绝结构漂移、前后数据相等、只读重连零 DDL、失败回滚与 ledger 不被重写的断言不变。不修改迁移、baseline、生命周期实现或产品代码，不引入目标版本抽象。

验证按 CI 生命周期命令的 `--no-env-file test --parallel=2` 运行四个文件，使用任务自有 `along-168-ci-lifecycle-pg`（PostgreSQL 16）与 Bun 1.4.2，每个用例仍创建/删除独立数据库，临时迁移目录位于 D 盘。此次仅测试及验证记录变化，沿用上述成功的产品链路与该 CI 的 checks/integration 证据；不重复全量 verify、database 后续集成集或 Web/native/MCP 产品验收，不操作旧安装。

结果：四个文件未按名称过滤，**80 pass、0 fail、619 assertions**，包含原 CI 的全部 60 个失败场景；目标版本断言之后的数据不变、漂移拒绝、ledger 保护和 DDL 回滚检查均执行。PostgreSQL `16.15`，用例清理后除系统库与默认 postgres 库外剩余数据库数为 0，随后删除本任务 PG 容器及卷。完整本地日志 `D:/Temp/along-168/review-ci-lifecycle-fixed.log`；四个文件定向 lint 与五个改动文件（含本记录）的格式检查通过。新提交的远端 CI 由主审等待和最终评审，此处不以本地四文件通过宣称全量 database 或新 CI 已绿。
