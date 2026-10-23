# 04 验收标准与待决事项

> 状态：草案 / 范围：v0 四条验收、Deferred 清单（含阻塞阶段）、重开门槛 / 不包含：测试用例实现、Spike 执行细节（见 agent/04）/ 阶段：P1（验收）+ Deferred 各归属阶段

## v0 验收（四条，全部按自家可测指标）

- [Required] A1 喝水恰好一次：输入"明天 9:20 提醒我喝水"（已确认时区）→ 回显冻结 → 确认 → 建单次 task → 登记回执 → 到点 15 分钟内应用内通知恰好一次；task_events 含 scheduled（含回执号）→ fired 全链；对外只说已记录步骤。
- [Required] A2 重复确认单任务：同一 approval 重复确认只回同 task。明确修改本人有效 pending create_task，按完整输入及首次持久 anchor 重新归一，原子保存旧 superseded、唯一新 pending 与幂等结果；修改及重放不建 task。旧确认 409 APPROVAL_SUPERSEDED，新详情重新回显再按钮确认。覆盖同键重放/异 body 与跨目标冲突、响应丢失/重启、改与 confirm/reject 竞争、锁后到期及失败回滚；真实 Web/HTTP/只读 SQL 关联证据见 design/06 §9，不把预置 superseded 当完整修改链。
- [Required] A3 崩溃恢复安全优先：确定尚未获调用许可的项可恢复正常一次；独立接收已提交的项 kill/resume 后只核对收尾，跨进程实际调用累计 1、receipt 1、通知 1、fired 1。许可后无接收事实的项不盲重发，允许待核对或超窗未完成，不承诺任意崩溃点都严格一次且完成；实际调用可为 0/1，但不得重复。取消已提交后实际调用仍为 0。真实故障阶段、绑定与迁移见 design/08 §7–§9；唯一通知行不替代调用证据。
  - 确认后从未排期、首次 worker 处理已超 15min 的 `saved/pending_schedule` 同样终结为 `missed`；遗留已失败排期命令不阻碍恢复。重复/并发处理只有一条 missed，无虚构 scheduled/sent/回执、无 provider 调用；状态/事件/队列失败全回滚，取消先提交不被覆盖（design/08 §5，#42）。历史已排期 A1 证据不代替本分支验证。
- [Required] A4 时间错误：不存在本地时刻、重复未选、未知时区/显式别名分别 typed 422 失败；两候选由服务端提供，Web保留完整输入/时区，以 first/second 与新键重提议，不算 UTC、不当作确认。缺信息/模糊仍澄清。三 zone 的有限 2026–2027 本地区间及精确 UTC 边缘见 design/05 §5；范围外/规则不可用为 TZDB_UNAVAILABLE，未知别名不得因已有确认时区被忽略。认证/结构等边界后、SSE与新 run 前预检规则；已开流故障唯一失败终结，承诺零写/零调用。readyz共享实际规则/alias/版本与DB可达判断，不接受任意非空版本；真实缺失装载与旧冻结读取/确认/取消/执行隔离需取证，不能以mock代替（design/05 §9–§10、API §6）。
  - first/second 的待确认正文须同时展示选中的次数与冻结数值偏移；新 first 使用 v2，既有普通/second/cancel v1 不换模板。已确认显示有误的旧提议作废重来，不改旧快照或已建任务；规则缺失仍可读取并按冻结版本校验正确的新旧提议（design/05 §4、design/06 §2）。
- [Required] 验收环境：单镜像 all 角色 + compose 冒烟；Postgres 唯一事实源；Redis 缺席不得影响验收（Redis 已延后）。
- [Required] CI 合并门：`static` 通过后，迁移约束、调度故障、契约双跑与 `compose-smoke` 四条下游只依赖 static、各自隔离并行；static 失败则全部下游不运行。五个 job 必须全部成功才允许合并，人工保护约定与 D1–D10 语义不变；Compose 可在其他下游失败前已消耗资源，但不共享用户数据或可变数据库（见 design/13 §3–§4、ADR 0007）。
- [Required] 工具链验收遵循 Bun 1.4.2 冻结安装、Oxlint 1.89.0、Oxfmt 0.74.0 与 `bun:test`；`bun run verify` 是本地与 static 的共同阻塞入口。依赖优先构建后串行执行全部 workspace 类型检查，保留源码、测试与 Next route typegen。文件级并行保留隔离及 mock/时钟恢复；只有只读边界 fixture 可最多两个真实 CLI 并行，逐项拒绝断言、绿例两种扫描和清理前等待均须保留。`test:contracts` 包含 API 两种传输及契约包，`test:integration` 覆盖全部 9 个真实 PostgreSQL 16 文件，`test:scheduler` 保留 D9 指定集。D1/D2 原边界与断言不因工具或调度改变（见 design/01 §5、design/13 §3–§4、ADR 0006、0008）。
- [Required] 同次 verify 仅复用成功 typecheck 构建的共享 packages；失败构建不消费，独立单元入口与跳过 typecheck 的 verify 仍真实准备包，不依赖旧 dist 或跨 job 产物。Compose 宿主不安装没有宿主消费者的依赖，镜像内仍真实执行 Bun 冻结安装、构建与运行；缺/有 `TZDB_VERSION` 两轮全新卷的就绪场景均须保留，格式错误不能作为警告放行。验收结果记在对应 change tasks / PR，不把未执行检查写成完成。
- [Required · #43] HTTP入口在业务POST收集前复用身份与适用CSRF头门禁；原始JSON字节累计不超过131072（含分块/UTF8），超限413 PAYLOAD_TOO_LARGE，空/畸形JSON400 VALIDATION_ERROR，响应头/envelope/error的request_id一致。拒绝未消费上传先发有限响应再关闭，不等end或无界drain；合法小JSON与keep-alive、冻结确认/取消事务不回归。真实HTTP有限上传和隔离PG覆盖见对应PR；不以此声明DoS、代理缓冲、内存/吞吐或慢连接防护已验收（design/10 §1.1）。

### #26 七步 smoke 的通知可见面与结论边界

- [Required] 站内通知经既有 `GET /api/v1/tasks/{id}` 的 `notifications` 只读数组与 Web 任务详情可见，无记录返回 `[]`，任务列表不加字段、不新增独立通知路由。每项仅含现有 `id/title/body/status/sent_at`；`status` 的实际域是 `pending/sent/failed`，`sent_at` 可为 `null`（design/03 §3.1、API tasks §2.1、schema `notifications`）。
- [Required] 详情与通知均限定当前 owner；不存在/非 UUID、跨 owner、未认证沿用详情 `404/403/401`，失败不能伪装成功空态。读取无发送、重试、已读或其他业务写副作用；通知查询归 notifications 公开 service 所有，tasks 按 owner/task ID 调用，Web 只经 HTTP 取值。标题/正文原样展示，不重算冻结时间，`sent` 不证明设备送达或用户已读（D1/D2/D8/D10、A1）。
- [Required] 按 `docs/demo/v0-slice-smoke.md` 在同一受控环境执行简报→只读卡片→真实 SSE→按钮确认→真实到点及通知→活动账→另建任务取消；以 API/Web/只读 SQL 与真实 provider 调用记录关联本次 ID，不用预置业务状态、假通知或测试手注回执代替生产入口。取消合同沿用安全 spec Requirement 5 与 design/07 §3：实际撤销本地队列并核对 fencing 后持久化撤销回执，才可 `cancelled`；无回执仍 `cancel_pending`。
- [Required] 取消已提交后 provider 实际调用数为零需单独证明，零通知/零 `fired` 不能替代。优先受控、非暂停 debug logpoint，必要时仅补无内容的最小证据，不新建遥测框架。运行记录须覆盖取消任务原到点窗口及原宽限窗，附正向任务调用作为观察器正控制（A3/D9）。
- [Required] 独立契约 PR 先经独立 review、既有五门全绿及 CLEAN 后合并，再实现、真实七步与 archive。七步代表性运行不等于完整 A1–A4 或 v0 结案；A2 完整替代确认、A3 完整 kill/resume、A4 错误合同与规则缺失冲突在本次不修、不宣称通过，仍保留为额外验收边界，详见 closeout plan §6。D1–D10、五门、按钮确认、回执门及冻结展示语义不变。

## Deferred 清单（每条写明阻塞阶段）

| #   | 事项         | 现状                                                                        | 阻塞阶段                                      |
| --- | ------------ | --------------------------------------------------------------------------- | --------------------------------------------- |
| D1  | 目标市场     | 未定；多租户隔离只预留，v0 跑单租户行为                                     | 阻塞 P5 计费与组织模型；不阻塞 P1             |
| D2  | 是否练仓颉   | 未定；CangjieMagic 只作第二实现，v0–P3 不用                                 | 阻塞 P3 联调排期；不阻塞 P1/P2                |
| D3  | 鉴权方案     | 已定：Better Auth 自建 credential（D7 空环境冒烟不依赖外部 IdP；v0 单租户） | 已冻结；schema/05 与 api 鉴权章节按此落地     |
| D4  | Web 框架     | 已定：Next.js，RSC 开、Turbopack 开（默认配置，偏离另开 docs PR 说明）      | 已冻结；apps/web 脚手架按此落地               |
| D5  | 推送渠道     | Web Push 仅兜底；邮件/系统推送未选                                          | 阻塞 P5 触达扩展；不阻塞 P1（应用内通知先行） |
| D6  | LLM 供应商   | 未选；预算护栏（BUDGET_EXCEEDED）先行                                       | 阻塞成本核算；不阻塞 P1 功能验收              |
| D7  | 计费模型     | 未定；额度字段留占位不冻结                                                  | 阻塞 P5；不阻塞 P1                            |
| D8  | 每日任务粒度 | 每日重复任务进 v1；v0 只做单次 + missed 一键重约                            | 阻塞 P2+ 重复语义设计；不阻塞 P1              |

- [Required] 正文不得猜 Deferred 字段：相关 schema/API 留占位，由归属阶段决策解冻；解冻前 /readyz 按类型化错误如实报告，不降级。
- [Required] D3、D4 已在 P0 冻结，不再阻塞 P1 开工（见 03 准入）。

## 重开门槛（什么情况重开已定事项）

- [Required] 取消后触发数破 0：重开 P1，Scheduler claim/lease/fencing 与 outbox 核对逻辑必须复审，人复核放行前不得发版。
- [Required] missed 率或触发延迟持续超基线 2 倍：重开实验起步值（24h/15min/1min/30s/3 退避），以 P1 实测 rescues 为准重新冻结。
- [Required] S1–S3 任一结案项不达标：不得进 P3；CangjieMagic 第二实现无限期保持 Proposed。
- [Required] presentation_hash 比对失败率异常（展示与快照系统性对不上）：停在待核对，重开 stream-protocol 版本对照（thread-stream.schema.json）与卡片渲染链。
- [Required] /readyz 类型化错误（tzdb/别名表缺失）出现：服务保持不就绪，重开 deploy 单镜像构建流程，不得手动放行。
- [Proposed] 用户连续要求"范围提醒/尽快/有空时"类模糊时间：记入未支持请求列表（30 天归档、一年删除），只在用户主动查看或 v1 评审时翻出，不为此重开 v0。
