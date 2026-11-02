# v0 七步真实 smoke 验收记录（2026-10-21）

## 结论与适用范围

**代表性七步通过；不等于完整 v0 验收通过。** 本记录对应 [#26](https://github.com/BqLee-AI/Along-agent/issues/26)、[PR #28](https://github.com/BqLee-AI/Along-agent/pull/28) 与运行源码 `914cca971f03e7a0a813a7aff8890aa36c82951a`。独立契约 [PR #27](https://github.com/BqLee-AI/Along-agent/pull/27) 先合入，再实施与运行。操作方法见[七步手册](../demo/v0-slice-smoke.md)；原始脱敏请求、SSE、SQL、调用记录和逐次采样见[关联 JSON](v0-smoke-evidence-2026-10-21.json)。

执行者：OMP 主线程，负责真实浏览器、进程、DB、测试与 CI；独立源码审查为 ReviewSmokeImpl26（approve 0.88，fixture 修正补审 0.97），独立运行证据审查 ReviewSmokeEvidence26 approve 0.90、无 findings。不将源码审查冒充运行验收，也不将 AI 审查称为人工或平台强制批准。

- 本轮覆盖 A1 主链、A2 重复确认子集、A3 取消子集及 D9 实际调用零证据。
- **未覆盖：** 完整 A2 的修改/替代确认、A3 实杀 worker/恢复、A4 DST/未知时区/规则错误的合同冲突裁决。`FIXTURE_V1` 不是完整 IANA 时区库；`/readyz` 绿不是完整规则或部署证明。
- 通知 `sent` 与本地回执只证明服务端记录，不证明设备收到或用户看过；未验证外部推送。

## 环境与数据边界

| 项目         | 实际运行                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| 工具         | Bun 1.4.2、Node v24.21.0、PostgreSQL 16.15；OpenSpec 1.3.1                                               |
| API / worker | 同一生产构建进程 PID 26380，`ROLE=all`，无 watch/热重载，默认 30s tick                                   |
| Web          | Next.js 16.4.2 生产 start，浏览器真实会话经 `127.0.0.1:3100` 同源代理到 API 3000                         |
| 数据环境     | 执行器专属 `along-issue26-pg / along_smoke`；PG 测试另用 `along_tests`，无 worker                        |
| 规则与时间   | owner 确认 `Asia/Shanghai`；环境及实际归一 `fixture-v1 / FIXTURE_V1`；记录时间均 UTC，页面核冻结本地文本 |
| 身份         | 合成 owner、真实 credential session / CSRF；不保存 cookie、CSRF、secret、DSN 或真实提醒                  |

复用已安装依赖，本次未重跑本机安装；不把这次运行声称为全新安装验收。初始基线为本次 owner 的 tasks/approvals/outbox 各 0。另一个合成 owner 的取消函数修复前后夹具不计入七步；所有业务快照限定本次 owner 与关联 ID，不断言全库为空。环境初始化与正式身份 seed 不替代业务确认；七步的业务写入只经真实对话/按钮，SQL 全部只读，不手注通知/回执、不改终态/到点、不回拨时钟。不读取或改写 `.env*`，不操作用户数据库或进程。

关联 ID 均为本次合成环境内部业务 ID，刻意保留以供串联；owner 在 JSON 中统一替换为 `SYNTHETIC_OWNER`。没有外部 provider 的敏感任务/请求 ID。

| 别名         | ID                                     |
| ------------ | -------------------------------------- |
| P0（不确认） | `1e0d461d-0bdf-4820-bccc-b163e690b577` |
| P_fire       | `2eeca8c8-7c6e-4691-9628-1249f4f0232b` |
| T_fire       | `37e32d67-8bc4-47df-bed9-128da2d4d279` |
| P_cancel     | `450ac229-878a-4612-aedd-af98f31a8a3b` |
| T_cancel     | `60d43b93-a0f7-4eb1-8eb8-d3e4333421f4` |

## 七步实际结果

| 步骤        | 操作与观察                                                                                                                                                                                             | 证据入口                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1 简报      | 真实对话准备 P0 后读取 `/api/v1/brief` 两次，均 200，投影相同，pending 1 / fired 0；无 task/outbox                                                                                                     | JSON `stages.brief`、`p0_before`                 |
| 2 只读卡片  | 从简报实际点击 P0；GET 200、冻结内容可见；前后业务快照相同，未创建 task/outbox                                                                                                                         | `stages.read_only_card`                          |
| 3 对话      | 输入 `2026-10-21 16:01 提醒我喝水（北京时间）`；真实 HTTP 200 SSE：thread.started → message.delta → card.proposed → approval_required → thread.completed，seq 6–10、v1、唯一终结；确认前无 task/outbox | `stages.conversation`                            |
| 4 确认/幂等 | 实际确认按钮 POST 200，真实跳到 T_fire；同原幂等键重放 200、duplicate=true、同 task；同 approval 只有 task / created / schedule 各 1                                                                   | `stages.confirmation`                            |
| 5 真实到点  | 原到点 08:01Z；真实 provider 仅调用 1 次，08:01:18.261Z；持久通知 1 行、sent_at=08:01:18.256Z，登记回执与 fired 事件存在；Web 正文/状态和存储一致。继续至最终窗口后仍为 1，不是 missed                 | `stages.fired_notice`、`provider_observer`       |
| 6 活动账    | 实际 `/activity` 与任务 events API 200，created → scheduled → fired 与同一 task 对齐；任务详情晚期刷新仍只有同一通知                                                                                   | `stages.activity`、`stages.fired_notice.final_*` |
| 7 取消      | 另建原到点 08:08Z 的 T_cancel，先见真实 sched 回执，再由页面取消；生产 worker 写持久撤销回执、cancelled 事件与终态；完整观察到原到点+16min，实际调用 0，且有两个宽限后真实 tick                        | `stages.cancel`、`provider_observer`             |

### 确认取证的已知缺口与替代事实

首次正向确认的**响应 body 没有取到**：按钮的实际导航驱逐了可读取的 response body，不能把后来重放的 body 写成首次响应。保留首次 HTTP 200 与浏览器真实 task 跳转记录；原幂等键从同 owner/approval 的持久 confirm outbox 恢复，所见字段由实际 approval 冻结值及已核对的按钮实现还原。随后用真实会话/CSRF、同原键/字段重放，得到 200 consumed、duplicate=true、同 T_fire。SQL 同时核定单 task/created/schedule。JSON 明确区分首次状态、缺失 body、还原 request、重放 response 与真实跳转，不伪造原始抓包。

原键恢复的原始查询结果最初未留存，后于 08:32:27.51679Z 补做同 owner/task/approval 的只读串证，持久 key 的末段与实际重放 key 相同；SQL 和结果保存在 `later_readonly_key_corroboration`，不冒充早前恢复抓包。consumed 重放分支先于 hash/seen 校验，因此重放证明幂等，**不作为首次所见内容校验的额外证明**。

### 取消提交、持久回执与真实等待

| 时点               | UTC / 结果                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| 已先登记           | T_cancel `schedule_receipt=sched:<T_cancel>`，状态 scheduled；不是未排期的空测                      |
| 取消请求开始       | 08:05:11.752222Z                                                                                    |
| 取消 HTTP 200 返回 | 08:05:11.809933Z，响应 cancel_pending，随后 SQL 可读                                                |
| worker 自然完成    | 08:05:18.219266Z，唯一 cancelled 事件；其 evidence_ref 与 cancel outbox 的 provider_receipt_id 相同 |
| 原到点             | 08:08:00Z                                                                                           |
| 15min 宽限结束     | 08:23:00Z                                                                                           |
| 之后两个实际 tick  | 08:23:18.236598Z、08:23:48.235132Z                                                                  |
| 最终只读窗口样本   | 08:24:00.122246Z，不早于原到点+15min+60s                                                            |

正常生产路径以任务锁和版本栅栏撤销旧 PG outbox/lease、核验无活跃余单后写回执与终态；本轮未调用测试 receipt injector。62 个只读窗口样本均为 cancelled，通知 / fired / cancel_breach / 活跃非 cancel 余单 / 取消任务实际调用均为 0；lease 最终为 0。历史完成 outbox 不强求全部 superseded。

## 实际 provider 调用证据（独立主指标）

- 实际边界是 `deliverInApp` 内紧邻 `await effective(notice)` 的诊断通道，不是扫描数、通知数或 fired 数。未替换默认 provider，观察器仅订阅并记录 taskId/PID/时间/序号，无内容或身份；默认无订阅则无日志。
- 同 PID 26380 从 07:46:18.112Z 的 observer_ready 持续运行；正向 T_fire 唯一 provider_call 充当正控制，序号 1。冻结证据中的末次心跳为 `2026-10-21T08:26:18.125Z`，calls=1；相邻心跳最大间隔 30.001s，未换进程/热重载/调试暂停。
- 取消提交前后及整个窗口，T_cancel 的调用均 0；不需要排除开始与响应间的模糊调用，因为该段也没有调用。最终正向仍为 1。
- **心跳不是 worker tick。** 实际 tick 取 PG `pg_stat_activity` 中 missed 阶段查询的 `query_start`：匹配真实 `SELECT id, owner_id, state, state_version, fire_at_utc, wall_time,` 前缀及 `fire_at_utc < now() - interval '15 minutes'`，排除观察器自己的 `SELECT json_build_object`。末窗以 5s 采样取得上述两个不同查询时刻；生产轮询常量 30s。连接池在空闲 tick 之间可无连接，故早期 15s 样本的 last_tick_at=null 不被冒充停机或有效 tick。

原始 provider 事件、62 次业务采样、末窗 PG tick 采样各自保存，能分别检查正控制、连续性、两 tick 与取消副作用；不能用零通知替代主指标。

## 新增行为与门禁映射

| 范围                 | 实际证据                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 通知读取             | PG 集成测试覆盖空态、三状态/null、owner/其他task隔离、401/403/404、查询失败500、重复GET无业务写入；真实正向走默认 provider 持久化与Web详情       |
| D1 / D2              | 既有动态边界拒绝跨模块存储绕过；本实现经notifications公共service。通知测试保留冻结标题/正文、UTC变异不改正文；真实页面核冻结时间，不做展示层换算 |
| D8 / D10             | 详情真实HTTP/in-process、既有contracts双跑；实际SSE/确认经Next；Web只说明站内记录不等于用户收到/看过，copy-claims门保留                          |
| A2子集 / A3子集 / D9 | 持久原键确认重放同task；生产撤销回执与实际调用零的完整时间窗；不是全A2/A3                                                                        |
| D3–D7及其他既有门    | 不降级；本次没有重新约定其含义或以一次正常链替代全量故障验收                                                                                     |

本地最终有效结果：PG16 集成 **71 pass / 9 文件 / 311 assertions**；unit **140 / 21 / 623**；contracts双跑 **14 / 4 / 33**；API/Web生产构建通过。lint/typecheck/depcruise/治理门与后续copy-claims/unit/strict/format是分段成功，不伪称首次整条verify exit0。首轮fixture将delivered=true误当丢失回答导致新测试失败，已改为真实acked_unknown输入和后续对账，未改变生产outcomeOf或删除fencing断言。

运行源码精确head的 [CI run 39567342047](https://github.com/BqLee-AI/Along-agent/actions/runs/39567342047) 五门 static、migration-scan、scheduler-fault、contracts-dual、compose-smoke 均 SUCCESS。最终归档head的合并资格另以 PR #28 精确提交五门与 CLEAN 核验，不用本次源码CI冒充后续head结果。

## 取证限制

- 浏览器自动化起初因专用 Chrome 未获焦点而丢输入/未发请求，启用 CDP focus emulation 后重新完成真实提交；未改应用行为以适配脚本。
- SSE 抓取中的中文存在解码乱码，不以它证明中文原文保真；事件类型、关联 ID、seq 与唯一终结仍可核对。冻结中文以实际 approval/确认字段、通知 SQL/API 和页面 DOM 交叉核对为准。
- 截图已捕获，功能可见性、页面文字、按钮、网络/API/SQL已核对。当前模型不能接收图片，图片问答入口亦返回 model-not-found，因此**未做像素级视觉判读**；不声称看过图片。10张本地截图不纳入版本控制，避免把生成媒体/机器产物带入仓库；执行器保留引用用于本次审查。
- 本轮为宿主生产构建 + 独占PG的真实浏览器链路，不是部署镜像全A类验收；独立既有Compose门不替代七步，七步也不替代完整镜像验收。
