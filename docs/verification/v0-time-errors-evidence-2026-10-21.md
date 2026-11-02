# A4 时间错误与规则就绪验收记录（2026-10-21）

> 状态：Observed，2026-10-21 真实部署与浏览器运行记录；2026-10-22 整理归档。
> 范围：#30 typed 时间错误、Chat fold 选择、实际规则故障、数据库中断、冻结路径及 first-v2 展示修复。
> 不包含：完整 IANA 时区库、设备通知必达、原字面 A1 次日到点结果或完整 v0 收口。
> 阶段：实现后证据归档；关联[完整脱敏 JSON](v0-time-errors-evidence-2026-10-21.json)。旧 first 展示缺陷不计通过；新 first-v2 定向只读 review 已接受，范围仅该修复及 P2，不代表独立执行或完整 v0。

## 结论与来源

**时间四错、未来 DST gap/fold、真实资源故障与数据库断开均有对应真实路径证据；旧 first 的计算正确但 v1 展示确有缺陷，不能继续计为展示验收通过。** 旧提议已真实拒绝，新镜像另行生成 v2 first，并真实走过 Chat、revise、显式 confirm 和独立自然正向路径。新归一统一使用实际装载的不可变上下文，不回退另一份 fixture；旧冻结读取、重放、确认、取消及执行不依赖新归一门。合同见[时间设计](../design/05-time-core.md)。

执行者为 OMP 主线程。ReviewA4DbOutage30 接受缺规则与真实 DB 断线修复片段（0.90）；ReviewA4ResourceEvidence30 的既有资源矩阵差量复核接受四项新增矩阵及干预边界（0.98），**其后另一次旧 first 补证审查为 incorrect（0.97）**，指出次数/offset 回显遗漏。JSON 的 `accepted_review_records` 保存前两份既有接受原文，`first_before_fix_review` 保存旧拒绝结论，不能互相覆盖或移用为新 first 的批准。现已追加 `local://v0-first-v2-independent-review.json` 的原始定向 review 至 `accepted_review_records.first_v2_new_independent_review.result`：**无 findings、correct、confidence 0.97，原 first/offset 回显误读 P2 已解决**。此新结论仅覆盖 first-v2 修复及相关源码、测试和既有证据，不重做原 A2 原子性或强杀矩阵，不含 A1 恢复。AI 仅只读审查既有材料/源码，不是独立运行、人工或平台强制批准，不扩展为完整 v0 收口。

| 对象              | 精确来源及适用性                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原组合源码        | `fa35e627fe0144fff8c14be73fc44a267948824a`，包含 A3/A4/A2；原镜像 `sha256:3d60efdfadf74351bdecd3feba5f3a16ccdcabc58e5ddac880013b6dfd5654ce`                                                        |
| DB 修复后运行源码 | `5d30bbf2e35b538f4453637e9233c494ce584b9b`                                                                                                                                                         |
| DB 修复固定镜像   | `along-agent:v0-closeout-5d30bbf2e35b`，`sha256:2f2ae03e81180222023a4d897205af4569b2556008b78b72036d321bd248f627`；原资源/断线/强杀矩阵仍归此版本，不改标新镜像                                    |
| A4 实现提交链     | `d40ead4b35e5c79e757cee6d86d163d4ad4121dd`；DB 修复归属 `60300fa`，基于真实 A3 提交，不重复 cherry-pick 历史                                                                                       |
| 组合等树候选      | `b3280e5ca4ec56e7b46a07c75b3bb573982c26eb` 与原 `5d30…` 整棵受控源码树实际 diff=0；不声称另建此候选镜像                                                                                            |
| first 修复源码链  | 原修复 `03b1f39ba39943cfa96ad7c8d0cbec2c041413d0`；整合部署源码 `54380b88dfe670b8e36896e9ffdd46fb7b9bfee3`                                                                                         |
| first-v2 新镜像   | `along-agent:v0-closeout-54380b88dfe6`，`sha256:908ed59e951777b6eb1e3dac92550a3278e7274a2e1c0eb2a1e317a898261603`；`ROLE=all`，`first-v2-compose-all`，2026-10-21T15:39:20.010218328Z 启动         |
| 加强单测后源码    | `d2c82c077cbced4734064307be6c76232f8dbc11` 重排后为 `fe1fef65ffdcaa1bc1160208bf2f76947e8d6e9f`；与部署 `54380…` 仅 `apps/api/test/presentation.test.ts` 不同，生产代码相同，不声称另建 fe1fef 镜像 |
| 环境              | Bun 1.4.2、PG16、原 Dockerfile/Compose 加临时覆盖、Next.js 16.4.2 生产 Web、真实 session/CSRF                                                                                                      |
| 数据库拓扑        | 实际业务使用本轮独占 PG 55439；Compose 附属 PG 55440 不是本次业务数据库                                                                                                                            |

新镜像的 readyz/healthz 在上述启动观察均为 200。Web 仍服务原 `fa35…` 构建的 Next.js 生产产物；既有 Web/contracts 源码比较 diff=0，未为 first 修复重建 Web。JSON 的 `deployment.current_first_v2_all` / `observations.first_presentation_runtime` 保存完整来源、未变模块比较和旧冻结公开读取；新镜像只补受影响 first-v2 路径与独立自然正向，不声称重新运行未受影响故障矩阵。

实际规则资源位于 `apps/api/resources/time/{fixture-v1,aliases-v1}.json`。规则为 `FIXTURE_V1/fixture-v1`：Shanghai、Kiritimati、New York 三个 zone，本地覆盖区间 `[2026-01-01T00:00:00, 2028-01-01T00:00:00)`；纽约含 2026/2027 转换。不是完整 IANA tzdb；不支持的时区或范围不能静默猜测。

## typed 错误与真实 Chat

HTTP 与 SSE 分开记录：流内时间错误的 HTTP 为 200，终结为唯一 `thread.failed`，payload 标明 422/503；资源不可用预检在新 run/SSE 开始前直接 HTTP503。

| 真实输入/操作                    | 观察                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不存在的本地时刻                 | 原 2026-03-08 纽约 gap 为 200 + 唯一 failed/422；另补真正未来 **2027-03-14 02:30（纽约时间）**，实际帧严格 started→failed、`NONEXISTENT_LOCAL_TIME/422`                                                           |
| 未知时区                         | 实际 Web/Next/SSE 为唯一 failed/422，不沿用已有时区回退                                                                                                                                                           |
| 超出规则范围                     | 2030 年输入为唯一 failed/503，不产生 approval/task                                                                                                                                                                |
| 重复本地时刻未选择               | 未来 **2026-11-01 01:30 America/New_York** 为唯一 failed/422，附服务端 first/second 结构化候选                                                                                                                    |
| 旧 Chat 选择 first（展示不通过） | 实际点击第一次，以新 body key `04449dcd-9bfe-404b-a7d2-51ee01246f15` 重提议；`085de1b1-d465-456c-8e1d-3360a4da9acd` 冻结 **05:30Z / -14400 / fold0** 正确，但 v1 SSE/确认回显遗漏“第一次”和数值偏移；后已真实拒绝 |
| Chat 选择 second                 | 实际点击第二次，以新 body key `8e389fe8-e4c0-4939-93e7-6b648fc3df09` 重提议；pending `f41b3235-b847-40c3-9b97-0143d88628d1`，冻结 **06:30Z / -18000 / fold1**                                                     |

上述旧 first/second 两次选择当时均回到待确认详情，不自动确认或排期；旧 first 补证前后 tasks/outbox 总数均不增。这只能证明其计算与 pending 生成，不能把遗漏次数/offset 的旧 first 展示算通过。候选值来自服务端，未让客户端计算 UTC 或从话术猜 fold。旧 second 的原文与旧 first 补证相同：`2026-11-01 01:30 提醒我喝水（America/New_York）`；second 只作此前接受的对照，不改标为新镜像本次运行。

未来 gap 的 approval/task/task_events/outbox/notification 前后分别为 27/18/51/32/7，均不增；允许错误流保存其审计 run，不将这类失败冒充“所有审计表零写入”。只有预检资源错误适用下文“实际装载故障矩阵”的十一表计数不增。

## first 缺陷处置与新镜像受影响路径

### 旧 v1 如实拒绝，冻结内容不重写

`085de1b1…` 的 `message.delta`、`detail.echo_text` 和确认页都只显示通用纽约本地时间，没有“第一次”或 `UTC-04:00`。只读 review 明确判为展示合同缺陷（overall `incorrect` / 0.97，finding 0.98），并非测试遗漏或展示已通过。主线程于 **2026-10-21T15:21:19.888077+00:00** 真实点击拒绝，HTTP200、`rejected`、`duplicate=false`；没有确认这份坏展示。

新镜像公开读取仍见该旧对象为 `rejected`，保留原 v1 `echo_text`、`presentation_hash`、`snapshot` 等冻结字段，不静默改写为 v2。其正确 UTC 计算和历史缺陷均完整保留在 JSON 的 `observations.chat_first_fold_supplement`、`first_bad_v1_rejected`、`first_before_fix_review` 及新部署 `old_frozen_public_reads`。旧 A1 的 v1 hash 亦仅记录部署前后未变，不据此裁定 A1 到点结果。

### 新 v2 Chat → revise → 显式 confirm

以下均由 **54380 / 908 新镜像**实际处理；时间均为 2026-10-21 UTC，关联 JSON `observations.first_fixed_chat` / `first_fixed_revise`：

| 步骤              | 真实请求与观察                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat 未选 fold    | 15:43:40.779911Z，原文 `2026-11-01 01:30 提醒我喝水（America/New_York）`；HTTP200 SSE 中唯一 `AMBIGUOUS_LOCAL_TIME/422`，保留服务端 first/second 候选                                                                                                              |
| Chat 选择 first   | 原 conversation、相同原文，新 body key `f299fce0-cf7e-4e28-bee4-2ae08500befa`；15:44:38.734894Z 观察生成 `5e68d201-9d25-4dcb-be89-b72a0fc28210` pending；SSE、公开详情、Chat DOM、确认页均含 **“第一次…UTC-04:00”**，模板 **v2**，冻结 **05:30Z / -14400 / fold0** |
| revise 未选 fold  | 对 `5e68d201…` 修改为 `2026-11-01 01:30 提醒我核对首次选择（America/New_York）`；HTTP422，输入保留，附服务端两候选                                                                                                                                                 |
| revise 选择 first | 新 key `1571f6e3-89d6-4183-a143-ae7c65910f69`，HTTP200；15:48:58.619Z 只读链中 `5e68d201…` superseded，successor `4ff84780-f520-4d64-bc92-f0909d49e9f3` pending/v2，确认页仍明确第一次与 UTC-04:00，冻结相同 first UTC                                             |
| 显式真实 confirm  | 点击 successor 确认，发送其冻结 hash 与完整已见回显、新 key `55cc8622-fc0a-4198-9d54-f5e95d1a4a6a`；HTTP200 consumed、`duplicate=false`，生成 `cddc3d91-9259-4ace-8f14-3b4bb66fb09d`                                                                               |
| 确认后边界        | 15:49:47.813Z 目标快照 `saved`、task1/outbox1/notification0，冻结 `2026-11-01T05:30Z / America/New_York / fold0 / -14400`；活动账后来可见 scheduled 回执，不把这个未来 fold 任务称为已自然触发                                                                     |

**计数 scope：** Chat first 生成后、successor 显式确认前，均有相应 approval 范围 tasks=0/outbox=0 的只读证据，选择和修改本身不确认。全库计数并非全部不变：Chat 前后时间跨越另一正向任务的 15:44 自然触发，task_events/outbox/notifications 增长；不能将目标范围的零写入扩大成全库零写入。完整计数原样留在 JSON。

### 新镜像独立自然正向，不替代 A1

同一 `ROLE=all` 实例真实提议并显式确认北京时间 **2026-10-21 23:44**，独立 task **`4c2f4ccd-231f-4c9d-a93f-23aece6fad67`**，冻结 deadline **15:44:00Z**。观察到：

- 15:44:21.199Z `permit_committed`；**15:44:21.218Z `provider_call_entered`**；15:44:21.280Z `receive_committed`。
- 15:50:50.390Z 只读快照为 fired；真实 provider 调用 **1**、通知行 **1**、fired 事件 **1**。事件时间为 15:44:21.208269Z，通知落库时间为 15:44:21.251701Z，分别保留其原始记录，不把落库时间、诊断事件和到点时刻混为一谈。
- JSON `observations.first_fix_all_positive` 保留完整提议/确认请求响应、DOM、快照、22 个成功真实 tick（15:39:51.177Z 至 15:50:21.152Z）及活动账；这是独立自然正向，不是 A1 或 11 月 fold 任务到点证明，也不证明用户已收到或已读。

### 源码、单测与镜像边界

first 修复原提交 `03b1f39…` 的既有记录包含 unit168、目标 PG1、contracts15；原 root verify 退出1（前九步成功、末步 format 失败），另有 CRLF 格式检查补充，不改称原 root verify 全成功。`local://v0-first-a4-contracts.json` 的完整原始输出另保存于 JSON `interpretation.source_test_image_boundary.contracts_provenance`：运行树描述为 **“A4 working tree with first-v2 fix”**，exit0、15 pass / 48 expect / 4 files；不替源记录补写精确 commit。旧 `local_verification` 的完整 contracts 汇总仍归原 `fa35…`，不能冒称 `54380…` 或最新 head 重跑。部署整合源码 `54380…` 另有既有 typecheck/lint 成功及 PG128/14/844；这些结果按各自版本保留。

之后仅加强未知展示版本回归：**同一未知版本匹配时仍 fail-closed**，既有定向单测 1 pass / 1 expect、typecheck 成功。加强提交 `d2c82c…` 重排后 head 为 `fe1fef65…`，相对部署源码只有 `apps/api/test/presentation.test.ts` 变化；生产代码相同，实际镜像仍为 `54380… / 908…`。JSON `observations.first_presentation_source_fix` 保留命令、stdout/stderr 与树差异依据；不借此宣布最新 head 完整五门通过。新 first 定向 review 已确认上述 P2 解决，但 review 本身没有运行 tests/build/lint/formatter/Git 或服务，不能与主线程真实运行证据混称独立执行。

## 实际装载故障矩阵

原缺规则演练直接在容器内移走真实 rules 文件，不以 mock 替代；后续四项均以 **5d30 / 2f2 固定镜像**的 `ROLE=all` 重建独占 API 容器，在应用启动前只改变临时容器资源或版本声明。未改仓库资源文件或 `.env*`。本节不是 54380 / 908 新镜像的重跑矩阵。

| 故障           | 真实探针                                                                 | readiness / liveness / Web                                        |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| rules 文件缺失 | 移走 `/app/apps/api/resources/time/fixture-v1.json`                      | readyz503 TZDB_UNAVAILABLE、healthz200、新归一503                 |
| 版本声明缺失   | 14:32:17Z 启动，`TZDB_VERSION` 为空，真实 rules/aliases 存在且 JSON 有效 | readyz503，`missing=[TZDB_VERSION]`；healthz200；Web503 typed错误 |
| rules 损坏     | 14:33:07Z 启动，实际 rules 为 1 字节 `{`，JSON 无效                      | 同上，Web503，保留输入                                            |
| aliases 缺失   | 14:33:10Z 启动，真实 aliases 文件已移走                                  | 同上，Web503，保留输入                                            |
| 标识内容不符   | 14:33:13Z 启动，rules JSON 有效但 `ruleset_id=NOT_FIXTURE_V1`            | 同上，Web503，保留输入                                            |

新增四项均通过真实 Web 发送 `2026-10-23 09:20 提醒我核对规则门（北京时间）`。每项前后十一张表计数完全相同：agent_runs、approvals、conversation_idempotency、conversations、messages、run_attempts、run_checkpoints、tasks、task_events、outbox、notifications。**计数相同只证明没有新增行，不扩大为逐行内容完全不变。** 实际操作参数、只读 SQL 辅助函数、观察器及容器内资源探针在 JSON 中。

14:33:16Z 从相同镜像恢复正常资源，rules 与 aliases 的 SHA256 分别恢复为 `9b7e84cae7e804074da5081a691b36fbf1d32d4f0fd6fe8f1b944d5616b37047`、`029b5c53c51ef553c7a2da3163017116650014060cdadd6d176b4224c8b2381a`，readyz/healthz 均 200。真实表单重新发送得到 200 SSE 和新 pending `2649dca3-50ed-4754-910c-5f761703e5ab`，未确认。此次使用新 key，**不是同键复用证据**；此前固定镜像的预检失败 key 恢复后复用另有独立记录，不混用。

## 旧冻结路径、重放与真实 DB 故障

- 缺 rules 时，已完成原 SSE 仍可按原请求重放，冻结审批仍可确认，不重算新时间。
- 原镜像冻结正向 task `a6bb60d2-1325-4b38-abd2-3c7ffd36a5f1` 在缺规则期间自然到点，12:48:16.083Z 实际调用 1、通知/fired 各 1。
- 同期取消 task `4b2808d9-cc01-4bd8-910f-63cbff76a61a` 的原到点为 12:49Z；缺规则期间实际取消，经生产撤销回执到 cancelled。观察到 13:12Z、超过 13:04Z 宽限及两个真实 tick，累计调用 0。中间包含计划中的 DB 中断和镜像修复切换，保留探针失败，不称 SQL 观察全程无间断；A3 固定镜像的新取消完整窗口见[专门记录](v0-crash-recovery-evidence-2026-10-21.md)。
- 固定镜像另建冻结 task `4ec61bb4-9d52-42ca-a6a8-a032dd74fe18`，缺规则时确认并自然到点，13:08:20.555Z 实际调用 1、通知/fired 各 1，证明修复后同一边界仍成立。

真实停止独占 PostgreSQL 时，原镜像 API 于 **12:49:16.075261107Z 退出 1**，报 pg 客户端未处理的连接终止错误；这是实际缺陷，不删记录。修复让主池与独立接收池都通过同一 pool factory 订阅 idle/checked-out 连接错误，查询仍失败，pg 丢弃失效连接，不把错误结果转绿。

固定镜像再次实际断开 DB：

1. rules 与 DB 同时不可用：readyz503 优先 `TZDB_UNAVAILABLE`，healthz200，进程启动身份不变。
2. 规则有效、DB 不可达：readyz503 `NOT_READY`，healthz200，不宣称业务可用。
3. 实际恢复 DB 后，真实查询转 readyz200，原预检失败 body/key 可重用并完成提议。

永久回归使用子进程真实 `pg_terminate_backend` 覆盖 idle 和 checked-out，断开后取得不同 backend PID；不靠测试自装 error listener。旧代码 checked-out 用例真实变红，修复后两项通过。未单独覆盖“执行 SQL 中途断线”的所有阶段，不扩张保证。

## 验证、局限与后续边界

原组合 fa35 源码 verify 十步成功（unit 172/23/756）、PG 126/14/820、contracts 15/4/48；DB 修复后 5d30 源码 PG 128/14/824、contracts 15/4/48，verify 前九步成功但恢复环境缺 bunx PATH 导致末步失败，修复 PATH 后严格 OpenSpec 五项单独通过。first 修复、整合及单测加强的版本结果另列上节。没有将旧版本结果改标为新版本；最终提交的精确 head 五门 SUCCESS/CLEAN 由主线程另行记录，本证据整理未运行 tests/build/lint/formatters/Git 或服务。

已有 D1–D10 不降级；坏声明、不完整输入、普通澄清、24:00/闰日、各 zone 覆盖上下界与纽约四次转换等由对应纯函数/PG/双跑回归负责，真实演练只声明本记录观察的边界。不重跑未受影响 brief，不引入全球 tzdb、LLM 或外部推送。

原字面 A1 `d021e80d…` 在 **2026-10-21 资源矩阵及 15:39 新部署前后观察时**为 scheduled，冻结 `2026-10-22 09:20 Asia/Shanghai / 01:20Z`，未替换任务或改时间。到点结果在后续恢复中已只读核实为失败，生产 worker 恢复后诚实转 missed、没有超窗补发；新字面验收另建任务，不冒充原任务通过。详见 [A1 恢复记录](v0-a1-recovery-evidence-2026-10-22.md) 与 [#38](https://github.com/BqLee-AI/Along-agent/issues/38)，本领域收口不表示完整 v0 完成。

JSON 保留 `observations` 的完整 A4 原始记录、`fixed_runtime` / `deployment`、原始验证摘要、两份既有 review packet 和相关 review 原文；历史 packet/review 中的 A1 等待措辞仅适用于当时观察。未删除、压缩或迁移原有 19408 行原始 JSON。公开归档不保存凭据、会话、CSRF 或实际 DSN；嵌在历史组合幂等键中的 owner 个人标识仅替换为 `[REDACTED_OWNER]`，路径列于 `privacy.redacted_paths`，合成任务/审批/请求 ID 有意保留。只核对既有实际 DOM/网络/SQL/事件证据，未做像素级图片判读。
