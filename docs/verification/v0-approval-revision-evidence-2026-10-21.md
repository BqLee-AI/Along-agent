# A2 修改、原子替代与重新确认验收证据（2026-10-21，含 first-v2 补充）

## 结论与适用范围

本记录归档 A2 的真实 Web 修改链、响应丢失后的同键重放、旧确认拒绝、新材料确认及原生双击单次创建证据。**已接受的运行证据审查是 `ReviewA2RuntimeEvidence31`：`correct`、confidence `0.96`、findings `[]`；只适用于它实际审阅的旧版本分层证据，不是对后来 first-v2 补充的新审查。** 完整审查原文和未经删节的领域原始记录见[同名 JSON](v0-approval-revision-evidence-2026-10-21.json)。

新增 first-v2 定向只读审查来自 `local://v0-first-v2-independent-review.json`：`correct`、confidence `0.97`、findings `[]`，仅关闭 first/offset 回显误读 P2。它不替代上述 A2 `.96` 运行证据审查或原子性审查，不代表独立执行、人工批准或完整 v0 完成；完整原文见下文及 JSON `reviews.first_v2_new_review`。

执行者为 OMP 主线程；本归档工作只读取既有证据并写文档，没有运行浏览器、SQL、构建、测试、格式化、Git 或服务操作。AI 只读审查未独立运行环境，也不构成人工或平台批准。本文**不判断 A1 原始自然到点结果，不宣称完整 v0 通过**。运行记录中的旧 A1 字段只是当时冻结对象及升级前后不变的历史快照，不能从中推出当前结果。

## 版本与证据归属

| 分层                       | 源码 / 制品                                                                                                                                                                               | 可以引用的证据及边界                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最初运行                   | `fa35e627fe0144fff8c14be73fc44a267948824a`；image `sha256:3d60efdfadf74351bdecd3feba5f3a16ccdcabc58e5ddac880013b6dfd5654ce`                                                               | 原始 `33eb6937… → 61df30ba… → 4fc63820… → 78bf6fb2…`；四类 typed 时间错误、保留输入、fold 换键、旧按钮与旧材料 409、second 首次确认。不得改写为后续镜像运行。                                                                                                                             |
| PG 断连修复后镜像          | `5d30bbf2e35b538f4453637e9233c494ce584b9b`；image `sha256:2f2ae03e81180222023a4d897205af4569b2556008b78b72036d321bd248f627`                                                               | 坏规则 503 / 恢复同键重试 / 新确认；完整 transport-loss 与相同 canonical presentation 链；独立原生双击链。`.96` 运行审查中的“最终镜像”指这一层，不指 image908。整合 head `b3280e5ca4ec56e7b46a07c75b3bb573982c26eb` 与此镜像源码树等价，tree `0361e5ab4a0dd4c0610c1b081764940fbdc444c0`。 |
| first 展示修复的开发与整合 | 初始修复 `03b1f39ba39943cfa96ad7c8d0cbec2c041413d0`；整合源码 `54380b88dfe670b8e36896e9ffdd46fb7b9bfee3`                                                                                  | 修复 first 选择虽然冻结 05:30Z/-14400、但回显未区分第一次与数值偏移的问题。历史问题和拒绝记录均保留；不能将旧 v1 事后改成 v2。                                                                                                                                                            |
| first-v2 实际运行          | tag `along-agent:v0-closeout-54380b88dfe6`；image `sha256:908ed59e951777b6eb1e3dac92550a3278e7274a2e1c0eb2a1e317a898261603`；revision label 为 `54380b88dfe670b8e36896e9ffdd46fb7b9bfee3` | `first-v2-compose-all`，ROLE=all，启动 `2026-10-21T15:39:20.010218328Z`；当时 healthz/readyz 均 200。补测受影响的 first Chat / revise / confirm 路径以及同镜像正链，不代表重跑完整故障矩阵。                                                                                              |
| 后置单测加强               | 加强提交 `d2c82c077cbced4734064307be6c76232f8dbc11`；重排后 test head `fe1fef65ffdcaa1bc1160208bf2f76947e8d6e9f`                                                                          | 相对已部署 `54380…` 唯一源码树差异为 `apps/api/test/presentation.test.ts` 的 unknown-version 单测；生产代码相同。不是从 fe1fef 构建/部署了新镜像。                                                                                                                                        |

生产 Web 继续使用最初 `fa35…` 构建；记录显示 Web/contracts 源码差异为 0，未为 first 修复重建 Web。真实浏览器通过 `http://127.0.0.1:3100` 同源路径请求 API；它不是“Web 与 API 都从 54380 新构建”的证明。规则均为 `FIXTURE_V1 / fixture-v1`，不代表完整 IANA 规则覆盖。

新镜像相对 `5d30…` 的运行源码变化限定 approvals 的 confirm/create/presentation/revise/service 与 tools/gateway。db、worker、tasks、notifications、time、conversations、规则资源、核心包、contracts 和 Web 的不变性记录完整保存在 JSON。**旧强杀矩阵仍归 image2f2；未改标为 image908，也未宣称在新镜像重跑。**

## 取证与脱敏规则

- JSON 保留完整 `a2`、原 A2 送审包、已接受审查原文、A4 first 历史问题/源码修复/运行记录及测试原始摘要；保留 SSE 原始 body、HTTP 请求/响应、DOM 文本、时刻、快照、逐条回归名称和限制，不用摘要替换原始记录。
- owner 身份值统一替换为 `SYNTHETIC_OWNER`；凭据、DSN、session、CSRF、cookie、授权材料不得归档。原始业务计数如 `owner_tasks` 仍保留，不能把计数当身份删去。
- 合成环境内 approval/task/conversation/run/request/event ID、hash、幂等键及本地业务回执有意保留，以串联同一请求与重放；它们不是登录凭据。
- 原始进度及复核输入不被改写；仓库已有 19408 行原始 JSON 不删除、不压缩、不迁移。本文新增领域证据文件不会替换它。
- SQL 前后快照是主线程已有只读采样；归档者未另行执行。全 owner task 总量中包含其他验收链，判断本链使用 `chain_tasks` / `target_tasks` / scoped 计数，不将全库非零误作确认前建 task。

## 原始 Web 修改链与 typed 时间错误（fa35 / image3d60）

原始提议 `33eb6937-8e86-4f4f-b6bd-f4eef4761571` 以完整原话、明确 `Asia/Shanghai`、`fold_choice=none` 修改，服务端 200，未变输入重试复用键 `be9e4414-e5dd-4169-81a6-1b2d94d23ccb`，得到 successor `61df30ba-eff4-473c-8280-5f524796dd30`。这份早期记录只保留首次状态和重试请求，不拿它单独补造首次 response body；后文 image2f2 transport 子例补齐原始成功 body 与浏览器失败的完整链。

旧按钮向已替代 `33eb…` 确认返回 HTTP 409 / `APPROVAL_SUPERSEDED`，details 指向 `61df…`。随后逐次修改保留输入并收到以下结构化错误：

| 输入边界                           | HTTP / typed code              | 本次请求键                             |
| ---------------------------------- | ------------------------------ | -------------------------------------- |
| `Unknown/Zone`                     | 422 / `UNKNOWN_TIMEZONE`       | `3536c9fb-ab18-48c5-a005-f772f6d7d75e` |
| `2026-03-08 02:30`，New York gap   | 422 / `NONEXISTENT_LOCAL_TIME` | `1416bdbb-26e2-496e-8083-c9f4c3162d22` |
| fixture 不支持的 2030 日期         | 503 / `TZDB_UNAVAILABLE`       | `c8ae0055-1bcf-4a97-bf13-9acc383de216` |
| `2026-11-01 01:30`，New York，未选 | 422 / `AMBIGUOUS_LOCAL_TIME`   | `97a60702-d0f5-4a9c-a757-fe30f55a8f07` |

gap 的旧样例日期早于本次运行；它证明该旧输入的错误类型，不冒充未来 gap 补测（未来样例属于 A4）。歧义响应返回 first `05:30Z / -14400`、second `06:30Z / -18000`，保留 wall time、timezone、ruleset 与完整 candidates。

选择 first 使用新键 `5cee7107-b3f1-410a-99d4-14ff0fb9194d`，冻结 successor `4fc63820-05e8-4479-9d1f-35c0876e0c83` 为 fold=0 / 05:30Z。该旧 v1 first 回显未包含“第一次/偏移”的缺陷不隐去；后文有专门修复。对它再次提交 none 得 422，键 `9e19ad4b-1b74-4cbd-9795-e6c0f516b703`；随后选择 second 换新键 `2146becc-4f50-4314-83cf-61ba8a0ddeb0`，200 / duplicate=false，生成 `78bf6fb2-eef9-443d-adb0-d33a5c3fc57f`，冻结 06:30Z / fold=1 / -18000。

向新目标提供旧材料返回 409 / `PRESENTATION_MISMATCH`。首次明确确认 `78bf…` 使用新详情的 hash `ph_aebd03eb6d8a93400b00167e980e3e8707919407c6ccb162e0546a0dfced88db`、完整 second 回显及键 `08051e66-d8a8-4a4e-bc38-bc14c316acfb`；原始 HTTP 200 body 为 consumed / duplicate=false / task `b8fb0c8f-79f2-4ca5-bb68-ab403f40bc65`。后采样 task=scheduled，created/scheduled 事件与 outbox=1 对齐；此前全 owner tasks=1 是其他链，不是本 A2 预先创建。

## image2f2：响应丢失、原键重放与相同 canonical presentation

JSON 路径：`a2.final_image_full_transport_and_equal_presentation`。

1. 真实 Chat SSE 产生 `8ea076d3-9afb-47b7-b5f3-7e18bed8de18`；归一为 `2026-11-08 09:20 Asia/Shanghai`，snapshot=`01:20Z / fold0 / +28800`，确认前 target_tasks=0。
2. revise 完整原话不变，键 `d16026bc-284d-401f-9e6d-96afa7a5e80b`。捕获到服务端**原始 200 已提交响应**：successor=`6f73fbda-a45d-47bc-99f4-b7cc44e58cc1`、duplicate=false、request_id=`e8eb47db-640a-4ba2-8dec-7a9d9264f455`；随后浏览器确有 `net::ERR_CONNECTION_RESET`。
3. DOM 保留原文、时区，明确显示“未收到修改结果，不能判断服务端是否已完成。输入和请求键已保留……”；页面未将未知结果假装失败回滚，也不承诺未持久接收请求已经到达。
4. 不改 body、不换键重试，HTTP 200，**同 successor**，duplicate=true，request_id=`5f0677cc-39b6-4b09-974a-6b4cb5d87042`。
5. 新旧完整 snapshot、presentation_version=v1、hash=`ph_51dbe341344523a656cba584d5d595500ec26671a89a5e4aaf30616106656e64` 一致。echo 中展示短号从 A-8EA0 改为 A-6F73，**不是 echo 全字串相等**；证明的是合法相同 canonical presentation 替代。替代后旧= superseded、新=pending，明确新确认前 chain_tasks=0。
6. 此子例确认完成并跳转 task `32ddba4d-955e-4b76-b3ab-f0ed2d6c670e`，但导航后采集超时，**没有原始首次确认 body**。晚期只读 SQL 的 chain_tasks=1、created=1 仅是事后佐证；不重构缺失抓包，不拿之后的重放冒充首次确认材料校验。

同镜像另有坏规则 revise HTTP 503 / `TZDB_UNAVAILABLE`，恢复后不改输入及键 `1c7c51fc-7260-4231-8997-a6dfad29a692`，HTTP 200 / duplicate=false，`f41b3235… → 3b0dc7ea…`；明确以新 hash/seen 再确认得到 task `7e1fa271-252e-4e76-b573-7dac2d3d0240`、duplicate=false。这一预检未持久接收的重试与上面的“已提交响应丢失”是两种不同事实。

## image2f2：原生双击、单 confirm 与首次材料校验

JSON 路径：`a2.final_image_native_double_click`。这是独立新链，不是上一子例的缺失 body 修补或 consumed 重放。

- Chat 提议 `ffbd21c9-cc12-45a4-96b2-f978fa229026`，真实 revise 200 / duplicate=false，生成 successor `23ea6893-4c6f-49ec-99a3-0f639710dec8`；明确确认前关联 task=0。
- Puppeteer 原生输入依次 `mouse.down(1)`、`mouse.up(1)`、`mouse.down(2)`、`mouse.up(2)`；响应保持到两组输入完成，统计整个输入窗口所有匹配 confirm 请求，仅 **1** 个。
- 原始首次请求的 hash=`ph_6393f8f2fb34f0eda7a3587d8df31c840631ce4d8fa9ae54173daa217dae27d3`，seen 为 A-23EA 新详情完整文本，键 `618244f5-3aa7-4f54-984b-0e610bd5db8b`；二者与新详情精确匹配。
- 原始首次响应 200 / consumed / duplicate=false，task=`4d3ac6a4-3bc3-4cf4-bbaf-7069c7f629fe`，request_id=`9aa6c577-9ed3-4127-b299-0e1344d5a353`；之后 chain_tasks=1、created=1、outbox=1。
- `inputs: []` 的 DOM-console 日志确实为空，**不以空日志证明 trusted DOM 事件**。双击证据是实际原生鼠标命令、延迟响应窗口与该窗口请求计数；单创建再由首次响应与关联 SQL 交叉核对。

## 原子性证据的正确来源

三项替代原子性——新 successor 写入、旧 approval 置 superseded、持久 revise 结果写回——不能从“最终看到一条链”反推。浏览器/最终 SQL 只证明可见链和明确确认前无 task；原子性依赖旧阶段 `ReviewA2Atomic31 approve 0.94` 静态事务审查及主线程已执行的 PostgreSQL 回归。

JSON 的 `a2.atomicity_evidence_boundary.executed_regressions` 保留全部逐项输出，包含每项 replacement 写故障回滚整链并保留可恢复 reservation、同键并发重放、异键串行/唯一性拒绝分叉、revise 与 confirm/reject 竞争、有效期/到点锁后复核、旧材料拒绝、相同 presentation 合法及明确确认单 task。静态审查只有原始摘要引用，没有在此伪造完整 reviewer 报告。相关旧测试输出与 fa35 阶段主线程记录一并保留；逐项输出未独立给出新镜像 commit，不改标为 image908 的重新执行。

旧阶段汇总为 verify exit0（10 步，unit 172 pass / 756 assertions）、PG integration 126 pass / 820 assertions / 14 files、contracts 15 pass / 48 assertions / 4 files。它们不是后续源码的全量测试结果。

## first-v2：发现、源码修复与测试版本

A4 原 Chat first 子例 `085de1b1-d465-456c-8e1d-3360a4da9acd` 冻结 05:30Z / fold0 / -14400，但 v1 回显只写本地 01:30，没有“第一次”及 UTC-04:00。既有 `first_before_fix_review` confidence .97 / overall incorrect 保留该展示问题；旧有问题提议随后经真实 reject，不通过改库或篡改 hash 消去缺陷。

修复后新 first 提议冻结 **v2**、明确“第一次出现”与数值偏移；旧 v1 对象仍按已冻结版本公开读取，不迁移其文本/hash，不将坏 first 历史对象自动升级成新展示。源码记录与后续实际 HTTP/DOM 证明分开：

- 初始修复 `03b1…` 的根 verify 原始 exit=1，前九步通过、末步 format 失败；相关记录包含 44 路径非语义 CRLF 刷新，单独 format 补充 exit0；unit=168、定向 PG=1，修复记录另记 `contracts_pass=15`。**不是一次整条 verify 通过。** contracts `15 pass / 48 assertions / 4 files` 的完整原始汇总归旧 `fa35…` 的 `local_verification`，不能将该旧完整汇总标为 `54380…` 重跑。
- 整合源码 `54380…` 的既有记录为 typecheck/lint exit0、PG=128 pass / 844 assertions / 14 files。
- 后置 `fe1fef…` 仅加强 unknown presentation version 的单测；原始命令输出保存为 1 pass / 4 filtered / 0 fail / 1 assertion，后续 typecheck exit0。不能将此定向单测写成全套重跑，也不能据此声称镜像重建。
- `rebase_crlf_refresh` 留存原路径与前后 index tree 相同、semantic diff exit0 的主线程历史结果；归档者没有执行这些命令。

## first-v2：真实 Chat → revise → 首次 confirm

JSON 入口 `a2.first_presentation_fix_supplement`，A4 同源完整记录同时在 `a4_first` 下保留；新增 `.97` 定向只读审查及其范围见下节，不将其称为独立运行。

### Chat 选择 first

真实原始输入 `2026-11-01 01:30 提醒我喝水（America/New_York）`，初次 HTTP 200 SSE 内为 typed `AMBIGUOUS_LOCAL_TIME`，不是业务成功。初始页面请求中的 confirmed_timezone 为 Asia/Shanghai，结构化歧义结果按原话显式 New York 解析；选择后请求明确 New York / first。选择前键 `b2a3cd21-7cbb-4dc2-a796-c9b393de1821`，选择后新键 `f299fce0-cf7e-4e28-bee4-2ae08500befa`，同 conversation `8febcf3e-be5e-4a58-ac41-decc73ec9a78`。

选择 first 后真实 SSE 与 GET detail 生成 `5e68d201-9d25-4dcb-be89-b72a0fc28210`，presentation_version=v2、hash=`ph_cb78179f9980730598d91440dd2eead67e3fcb92be52fde7d17e5b30fc13a786`、snapshot=05:30Z / fold0 / -14400；message.delta、Chat DOM、确认页 DOM 均显示“第一次出现”与 `UTC-04:00`。本提议关联 tasks=0 / outbox=0。全局计数受其他运行链影响，不据全局 outbox 增长断言本提议预先排期。截图已捕获但未做像素审查，不能写作人工看图通过。

### revise 重新选择 first

在 `5e68…` 页面修改完整原话为 `2026-11-01 01:30 提醒我核对首次选择（America/New_York）`：none 请求键 `846ed065-eb8c-4f52-b88a-807ee650b82a` 得 HTTP 422，结构化候选仍为 05:30Z/-14400 与 06:30Z/-18000，页面保留输入。选择 first **换新键** `1571f6e3-89d6-4183-a143-ae7c65910f69`，HTTP 200 / duplicate=false，生成 `4ff84780-f520-4d64-bc92-f0909d49e9f3`。

新详情与页面均为 v2，明确“第一次出现 / UTC-04:00”，hash=`ph_208446f823c59ef21663ef751d5ce321aa3ff474667a471e3253a8829aedcf15`；只读链为旧 superseded、新 pending，冻结 05:30Z / fold0 / -14400。明确确认前本链 tasks=0 / outbox=0。该补充没有重新执行旧材料 409 或原生双击矩阵；它们仍归先前对应版本。

### 实际首次确认

实际 POST `4ff84780…/actions/confirm`：

```json
{
  "presentation_hash": "ph_208446f823c59ef21663ef751d5ce321aa3ff474667a471e3253a8829aedcf15",
  "seen_content": "原话'2026-11-01 01:30 提醒我核对首次选择（America/New_York）'，按 America/New_York 选择第一次出现的 2026-11-01 01:30（UTC-04:00），单次提醒；确认前不会创建正式提醒或排期。",
  "idempotency_key": "55cc8622-fc0a-4198-9d54-f5e95d1a4a6a"
}
```

捕获的**原始首次响应** HTTP 200 / consumed / duplicate=false，task=`cddc3d91-9259-4ace-8f14-3b4bb66fb09d`、request_id=`1f1851c1-c7b3-4578-8bdf-0205cecd0736`。`2026-10-21T15:49:47.813Z` 只读快照：task=saved / state_version1 / schedule_receipt=null，冻结 05:30Z / -14400，created 事件1、outbox1、notification0；页面也显示 saved 与“无（未确认调度成功）”。**这一采样没有证明该 task 已 scheduled/fired，更没有证明用户收到通知。**

同一 image908 另有真实 all-role 正链 `1c6a168f… → 4c2f4ccd…`，已有 provider 调用1、通知1、fired1 和完整 tick 记录，原始字段保留于 `a4_first.first_fix_all_positive`；它不是 `cddc3d91…` 的后续结果，也不是原始 A1 的替代证明。

## 复核引用与剩余证据边界

JSON `reviews.ReviewA2RuntimeEvidence31` 保留 .96 审查的完整原文，含最初“最终5d30镜像”“尚未完成的A1/A3”等**审查当时**措辞；它是历史引文，不是本文对当前 A1/A3 状态的断言。其结论接受上述 A2 片段，明确空 DOM 日志、导航丢 body、原子性独立来源及版本归属。不以 .96 给 image908 的 first-v2 自动背书；新增定向 `.97` 审查单列于 `reviews.first_v2_new_review`，不覆盖或替代原审查。

### 新增 first-v2 定向只读审查原文

来源：`local://v0-first-v2-independent-review.json`；`overall_correctness=correct`，confidence `0.97`，findings `[]`。结论仅为 first/offset 回显 P2 已解决；源码/证据只读复核不是独立实跑，不含原 A2 原子性复审、旧强杀矩阵重跑或 A1 裁定。

> 定向结论：原 first/offset 回显误读 P2 已解决，本次范围未发现需修复的具体缺陷；scope 仅为所列 approvals/{presentation,create,confirm,service,revise}.ts、tools/gateway.ts、相关 presentation/HTTP 测试及 local 证据的只读复核，未运行 Git、测试、build、lint、formatter 或服务，也未重复强杀矩阵或原 A2 原子性审查：create 仅在显式 foldChoice=first 且 fold=0 时生成 v2，ordinary/second/cancel 继续 v1；gateway 与 detail 使用冻结版本及同一 create renderer，confirm 使用 row.presentation_version 重算 hash，并拒绝版本不匹配及 row/wire 同为未知版本，revise 显式传播 fold_choice，presentation.test.ts 的 matching-v9 回归及 time-errors.test.ts 的 first/second HTTP/SSE 断言与此一致。
>
> 运行证据位置为 local://v0-closeout-progress.json 的 a4.first_bad_v1_rejected、a4.first_presentation_runtime、a4.first_fixed_chat、a4.first_fixed_revise、a4.first_fix_all_positive，以及 a2.first_presentation_fix_supplement：旧 085de1b1… 已 rejected，旧 v1 回显/hash/快照保持不变；真实 source 54380b88dfe670b8e36896e9ffdd46fb7b9bfee3、image sha256:908ed59e951777b6eb1e3dac92550a3278e7274a2e1c0eb2a1e317a898261603 上，Chat 5e68d201… 的 SSE、detail 和确认页及 revise successor 4ff84780… 均回显“第一次出现”和 UTC-04:00，冻结 2026-11-01T05:30Z/fold0/-14400，链路确认前 scoped tasks/outbox 均为0，explicit confirm 后仅创建任务 cddc3d91…、created 事件及 outbox 各1；Chat 前后全局计数受同时运行的正向任务影响，不能误读为 first 提议产生了 outbox，first_fix_all_positive 另证明新镜像普通任务正常触发，而旧强杀矩阵仍归属 sha256:2f2ae03e…，未重标为新镜像。
>
> 验证版本边界见 a4.first_presentation_source_fix 与 local_verification：原 root verify exit=1、前九步通过且末步 format 失败，format 单独补跑 exit=0，不改写成原整轮通过；集成 source 54380b88… 记录 typecheck/lint 通过及 PostgreSQL 128 pass/844 expectations/14 files，contracts 15 pass/48 expectations/4 files 的原始汇总位于旧 runtime fa35e627… 的 local_verification（修复记录另记 contracts_pass=15，不能将旧完整汇总冒充新 head 重跑），A2 head fe1fef65…/A4 head d2c82c07… 相对部署产品代码不变，仅加强 matching-unknown 单测并记录该项1 pass与补充 typecheck exit=0；本结论仅关闭上述定向 P2，不代表独立运行验证、人工批准或完整 v0 完成，原 A1 恢复验证不在本次 scope。

本文能支持的是分层 A2 运行证据及受影响 first-v2 路径补充的可追踪归档；不能支持以下更宽结论：新镜像完整强杀矩阵重跑、所有 typed 错误都在新镜像发生、静态 review 等于独立实跑或人工批准、cddc3d91 已到点、A1 原 deadline 验收通过、完整 v0 通过。

原字面 A1 在引擎恢复后已核实为失败并诚实转 missed；新字面任务独立创建、登记，不能冒充原任务通过。详见 [2026-10-22 A1 恢复记录](v0-a1-recovery-evidence-2026-10-22.md) 与 [#38](https://github.com/BqLee-AI/Along-agent/issues/38)。本领域归档不代表完整 v0 收口。

## 原始来源与永久入口

| 输入                                                                     | 永久 JSON 入口                      |
| ------------------------------------------------------------------------ | ----------------------------------- |
| `local://v0-closeout-progress.json` 完整 a2（含 first 补充）             | `a2`                                |
| `local://v0-a2-evidence-review.json` 原送审包                            | `original_a2_review_packet`         |
| `local://v0-closeout-review-results.json` 的 `ReviewA2RuntimeEvidence31` | `reviews.ReviewA2RuntimeEvidence31` |
| `local://v0-first-v2-independent-review.json` 新增定向复核原文           | `reviews.first_v2_new_review`       |
| progress 的 A4 first 历史问题、拒绝、源码、runtime、正链、Chat/revise    | `a4_first`，保留原字段名            |
| 原始/修复镜像、测试摘要、当前 first 部署信息                             | `provenance` / `version_boundaries` |

本文件及同名 JSON 是永久仓库入口；local/artifact URI 仅保留来源追踪，不要求读者依靠临时会话才能读到领域原始 HTTP、SSE、SQL快照和审查正文。无证据内容被补造为成功，无缺失响应被事后重建为首次抓包。
