# 03. v0 垂直切片（简报→卡片→对话→确认→调度→触发→通知→活动页）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：v0 MVP 全链路一步走通：GET /brief → 卡片 → POST messages（SSE）→ propose_task → time-core → approval 确认卡 → confirm 单事务建 task → worker lease 触发 → Notifier → 活动页；各步持久化对象、失败分支、对外口径
- **不包含**：P1 五缝完整接口定义（见 04）、time-core 细则（见 05）、approval 确认规则细则（见 06）、事件账词汇细则（见 07）、Scheduler 租约细则（见 08）；任何实现代码、SQL 建表语句、前端样式
- **阶段标签**：v0 / P0 切片（P1 接口化预留）

## 引用

- B06 v0-spec 全章；B03 §4 数据流；B02 §4 MVP 裁剪；B05 阶段 0~1
- 外部产品形态参考（任务卡、确认入口、活动记录）
- AF agent-foundation-architecture（仅思想：harness 可替换、checkpoint、不可变 revision；不复制实现）

## 0. 设计结论（先说死）

- [Required] v0 切片 = 简报 → 卡片 → 对话 → 确认 → 调度 → 触发 → 通知 → 活动页，Web 单端，不做 Electron、不做多端同步。
- [Required] 没点头不进钟：confirm 之前不建正式 task、不排期。草稿只能是 approval（pending），不是 task。
- [Required] 确认消费与创建任务/created/outbox，或与 tasks 公共取消用例的取消状态/事件/命令同事务；确认外的可靠异步任务走 outbox，同步公共用例与只读投影不强制入队（02 §1–§2）。
- [Required] task_events 只追加，DB 禁 UPDATE/DELETE（靠权限与评审保证，不在本篇写 SQL）。
- [Required] 对外口径只说“已记录的步骤”，不承诺必达；取消后触发数 = 0 为一级指标；超 15min 标 missed 不补发。
- [Proposed] 喝水提醒（B06 §1 验收用例）在本云端体系中降级为调度子用例：`task.kind=notify_only`，不走 LLM 先验调度，不走 Agent 规划，只走 time-core 归一 + 确认门 + 调度触发。
- [Deferred] 鉴权方案（自建 vs OIDC 二选一 P0 定）、LLM 供应商、推送通道、计费：本篇不猜，只留 `owner_id` 占位。

## 1. 与 B06 的取舍（取 7 不变量，舍 2 本机假设）

### 1.1 取（7 不变量，原样迁云端）

| #   | B06 不变量                 | 云端落点                                                    |
| --- | -------------------------- | ----------------------------------------------------------- |
| 1   | 没点头不进钟               | approval pending 前 task 不存在；confirm 单事务建 task      |
| 2   | 没把握就说没把握           | time-core 归一失败只回澄清，不建 approval                   |
| 3   | 对不上就停                 | presentation_hash 对不上 → PRESENTATION_MISMATCH，不建 task |
| 4   | 只追加不涂改               | task_events 只追加；改时间走新 task（recreated_from）       |
| 5   | 能量什么说什么             | Notifier 只认回执；无回执只说“已记录”，不说“已送达用户”     |
| 6   | 确认必须明确绑定按钮       | 见 06；v0 只认按钮确认，不做语义放宽                        |
| 7   | 取消优先，取消后触发数 = 0 | cancel 置 cancel_pending→cancelled；触发门禁先查取消态      |

### 1.2 舍（2 本机假设，明确不迁）

| B06 本机假设                     | v0 云端做法                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SQLite 本机库 + 本机 outbox 扫表 | [Required] Postgres 唯一事实源；outbox 为领域事件表，由 worker 角色认领（见 08）；Redis 延后，不引入                 |
| 归一住仓颉服务端、TS 只摆        | [Required] time-core 在 TS 服务端；仓颉唯一 Harness，不做时间归一；TS 长期保留工具/业务/存储（09/11），本次未实现 R1 |

### 1.3 起步值声明

- [Proposed] B06 的 24h（approval 有效期）/ 15min（触发宽限）/ 1min・30s（锚龄线）/ 最多 3 次退避，迁云端后**全是待校准实验起步值**，以自家可测指标为准，不作为 SLA。

## 2. 端到端流程（9 步）

```text
1 GET /brief → 今日简报 + 可点卡片（只读，不建任何写对象）
2 卡片/输入 → POST /conversations/messages（SSE）；默认 execution=business 保持确定性规则+单 propose_task，不做多步规划；显式 harness 的正式循环/等待见09/11
3 propose_task（含 wall_time + timezone_id + 原话）→ 调 time-core.normalize
4a 归一成功 → 建 approval(pending) + 确认卡（冻结快照，见 06）
4b 归一失败 → 回澄清（NONEXISTENT / AMBIGUOUS+两候选 / UNKNOWN_TIMEZONE / TZDB_UNAVAILABLE），不建 approval
5 用户点确认按钮 → POST /approvals/{id}/actions/confirm
6 confirm 单事务：验 approval → 建 task(saved→pending_schedule) → 写 task_events.created → 写 outbox → approval→consumed
7 Scheduler.schedule 登记 → 回执 → task→scheduled（有 receipt 才标 scheduled，否则停 pending_schedule）
8 到点 worker lease 认领 → 触发门禁三查 → Notifier.send → 回执写 fired；超 15min 写 missed 不补发
9 活动页 GET /tasks/{id}/events 只读 task_events（见 07），重约走新 task（recreated_from 指旧）
```

### 各步持久化与失败分支

| 步骤           | 写什么                                                                               | 失败分支                                                                            |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1 brief        | [Observed] 不写业务对象；读 task/approval 投影即可                                   | 读失败 → 空简报 + 可重试，不捏造卡片                                                |
| 2 messages SSE | [Required] 写用户输入；接受的助手 delta、终态 checkpoint、attempt/Run 同事务（见09） | business 保留确定性分支；harness 连接/预算失败类型化终结，不以重试重发未知效果      |
| 3 normalize    | [Required] 不写业务对象；只记 run_checkpoint（含 ruleset_id、tzdb_version）          | 错误码见 §4，直接回澄清                                                             |
| 4a 建 approval | [Required] 写 approval(pending) + 快照冻结                                           | 写失败 → 回“没记上，请重发”，不给确认卡                                             |
| 5 confirm      | [Required] 见 §6 单事务                                                              | APPROVAL_EXPIRED(410) / APPROVAL_SUPERSEDED / PRESENTATION_MISMATCH → 停，不建 task |
| 7 登记         | [Required] schedule_receipt 回填 task；事件 scheduled                                | 无回执 → 停 pending_schedule，不标 scheduled                                        |
| 8 触发         | [Required] fired/missed 事件；Notifier 回执号                                        | ACK_UNKNOWN 只核对不重发（见 08）                                                   |
| 取消           | [Required] cancel_pending→cancelled；cancel_requested 事件                           | 无撤销回执 → 停 cancel_pending，不谎称已取消                                        |

## 3. 端点清单（v0 13个 + Harness 3个业务端点，另2探针）

| 方法 | 路径                                             | 说明                                                                        |
| ---- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| GET  | `/me`                                            | 当前用户快照（鉴权 Deferred，字段不展开）                                   |
| GET  | `/brief`                                         | 今日简报 + 卡片（只读聚合）                                                 |
| POST | `/conversations/messages`                        | 发送消息，SSE 回流（思考/澄清/确认卡引用，不直返 task）                     |
| GET  | `/conversations/{id}`                            | 会话详情（含消息 + 关联 approval/task id 引用）                             |
| GET  | `/approvals`                                     | 待确认队列                                                                  |
| GET  | `/approvals/{id}`                                | 确认单详情 + 快照                                                           |
| POST | `/approvals/{id}/actions/confirm`                | 确认（单事务建 task），见 06                                                |
| POST | `/approvals/{id}/actions/reject`                 | 拒绝（pending→rejected）                                                    |
| GET  | `/tasks`                                         | 任务列表                                                                    |
| GET  | `/tasks/{id}`                                    | 任务详情，含站内通知只读投影（§3.1）                                        |
| POST | `/tasks/{id}/actions/cancel`                     | 取消（cancel_pending→cancelled）                                            |
| GET  | `/tasks/{id}/events`                             | 只追加事件账只读（见 07）                                                   |
| POST | `/approvals/{id}/actions/revise`                 | 显式修改指定 pending 提议，新详情重回显且须重新按钮确认（design/06 §9）     |
| GET  | `/conversations/{cid}/runs/{rid}`                | 只读当前 Run/attempt/有效批准等待点，不启动执行（09、conversations API §3） |
| POST | `/conversations/{cid}/runs/{rid}/actions/cancel` | 先持久撤销执行资格，再通知/终止进程；保留既成效果                           |
| POST | `/conversations/{cid}/runs/{rid}/actions/resume` | 仅显式继续最后有效批准等待点，同 Run 新 attempt，不重建原动作               |
| GET  | `/healthz`                                       | 存活探针，不依赖 DB                                                         |
| GET  | `/readyz`                                        | 就绪探针；类型化错误，不降级（见 05 tzdb 门）                               |

- [Required] 本清单限定既有 v0 与正式 Harness Run 入口；不因此新增任意 checkpoint 恢复、自动执行或其他通道。WS + ws-ticket 自 P2 起，Web Push 仅兜底，均不在 v0。
- [Required] 全链路 `request_id` + 幂等键；POST confirm/cancel 连点只回同一结果。

### 3.1 任务详情的站内通知投影 [Required，#26 契约增量]

**行为与范围。** 既有 `GET /api/v1/tasks/{id}` 的 `data` 包含必有的 `notifications` 数组，任务详情页展示通知模块持久化的真实站内通知。没有记录时返回 `[]`，不以 `fired` 事件合成通知，不改变任务列表、事件账或任何写接口。#26 的实施与真实验收记录见 closeout plan 和对应 OpenSpec tasks。

每项仅投影 `notifications` 表已有字段（真源：`docs/schema/commitments-schema.md` 的 `notifications` 节、迁移 `0007_commitments_notifications.sql`）：

| 字段      | DTO 类型                      | 含义                                  |
| --------- | ----------------------------- | ------------------------------------- |
| `id`      | UUID 字符串                   | 已持久化的通知 ID                     |
| `title`   | 字符串                        | 存储的标题原文                        |
| `body`    | 字符串                        | 存储的正文原文                        |
| `status`  | `pending` / `sent` / `failed` | 数据库通知状态，不是 task/outbox 状态 |
| `sent_at` | ISO 8601 字符串或 `null`      | 存储的发送时间；未记录则原样为 `null` |

**读取路径与所有权。** tasks 先沿用详情的身份与 owner 校验，再把当前 `owner_id`、`task_id` 传给 notifications 的公开 service；通知查询由 notifications 自己的 repository 执行，并同时限定这两个 ID。tasks 不引用通知 repository/schema、不直读或 join 通知表；Web 只经既有 HTTP 详情读取，不引用 API 源码或访问数据库。复用既有 tasks→notifications/service 依赖方向，不扩大 design/02 的跨模块读例外。

不存在或非 UUID 沿用详情 `404`，跨 owner 沿用 `403`，未认证沿用 `401`；不会为这些情况返回成功空数组或泄漏通知。正常查询失败沿用详情错误通路，不能伪装成“没有通知”。数组不附带 owner、幂等键、provider 回执或额外通知元数据，不新增分页/排序接口。

**只读与展示。** GET 不发送、不重试、不确认已读，不写通知、任务、事件或 outbox。Web 原样展示已存 `title/body/status/sent_at`，不重算正文中的冻结时间，不用当前 UTC、浏览器时区或当前任务状态重造文案。`sent`/`sent_at` 只说明站内通知的记录，不证明设备送达、响铃或用户已读；无通知时明确显示空态。`notifications` 仍是内部表，只经任务详情投影；不新增 `/notifications` 或任务下的独立通知路由。

### 3.2 七步 smoke 与既有安全合同的关系

#26 先独立合并通知契约，再实现并按 `docs/demo/v0-slice-smoke.md` 在同一受控环境执行七步；证据与收口边界见 `docs/demo/v0-smoke-closeout-plan.md`。取消计时点、回执门与竞争终局继续以 `openspec/specs/v0-safety-contract/spec.md` Requirement 5 及 design/07 §3 为准，不新增或放宽取消行为：实际完成本地排队撤销与 fencing 核对后持久化撤销回执，才可进入 `cancelled`；不能用内存 Set、测试手注回执或直接改终态冒充生产闭环。

取消已提交后的 provider 实际调用数必须单独取证，通知行数与 `fired` 数为零仅为辅助证据；优先使用受控、非暂停 debug logpoint，必要时仅增加无内容的最小调用证据，不建设遥测框架。七步不得代替 A2 的完整替代确认、A3 的真实 kill/resume 或 A4 时间错误/规则缺失合同验收；本次不修这些额外缺口，不宣称完整 v0 通过。D1–D10、五门、按钮确认和冻结展示保持原义。

## 4. task 对象与状态机（字段到名，不写 SQL）

```text
Task
  task_id            UUID，永不复用
  owner_id           归属（鉴权 Deferred，只存 id）
  kind               notify_only | agent_assisted（v0 只用 notify_only）
  source_approval_id 建它的 approval id（单事务内写）
  recreated_from     重约来源 task_id（UNIQUE，一旧只一新；只保证可回查，不继承授权）
  fire_at_utc        触发依据（time-core 输出）
  timezone_id        IANA 规范值
  local_datetime     墙上时间（到秒）
  fold               NOT_AMBIGUOUS | first | second
  resolved_utc_offset_seconds
  tzdb_version       归一所用库版本
  ruleset_id         别名/规则集版本
  presentation_version 确认模板版本
  state
  state_version      并发 fencing 计数
  schedule_receipt   登记回执号（有它才算 scheduled）
  created_at
```

- [Required] `UNIQUE(task_id, fire_at)` 语义：同一 task 不允许同一触发瞬间出现两行登记口径；改时间必须新 task。
- [Required] 除 `state / state_version / schedule_receipt` 外建后冻结。

```text
task 状态机
saved
  -> pending_schedule
  -> scheduled（必须有 schedule_receipt）
  -> fired（15min 内 + Notifier 回执）
   | missed（超 15min，不补发）
saved / pending_schedule / scheduled
  -> cancel_pending -> cancelled（有撤销回执才算；无回执停 cancel_pending）
```

## 5. approval 状态机（概要，细则见 06）

```text
pending -> consumed（confirm 单事务，建出 task）
pending -> rejected（reject）
pending -> expired（超 24h 起步值；清内容留号）
pending -> superseded（被新确认单替代）
```

## 6. confirm 受控单事务（创建与取消分支）

- [Required] 同一事务内：验 owner → 验 pending → 验 `now < expires_at` → 重建 presentation 预期并比 `presentation_hash` → 建 task(saved) → 写 `task_events.created` → 写 outbox → approval 置 consumed。任一步失败全回滚，对外只说“没记上”，不报成功。
- [Required · 现有取消分支] cancel_task 批准校验同一冻结门后，在同一事务调用 tasks 公共取消用例并消费批准；取消状态、事件、旧工作失效与 outbox 命令保持原子，撤销回执仍按 07/08，不能把 consumed 解释为外部效果已撤销。
- [Required] 重复 confirm（连点/重发幂等键）回原 task，不建第二条。

## 7. 错误码（v0 全集，本篇只列，细则各归属篇）

| 错误码                           | HTTP | 归属 |
| -------------------------------- | ---- | ---- |
| PRESENTATION_MISMATCH            | 409  | 06   |
| APPROVAL_EXPIRED                 | 410  | 06   |
| APPROVAL_SUPERSEDED              | 409  | 06   |
| NONEXISTENT_LOCAL_TIME           | 422  | 05   |
| AMBIGUOUS_LOCAL_TIME（带两候选） | 422  | 05   |
| TZDB_UNAVAILABLE                 | 503  | 05   |
| UNKNOWN_TIMEZONE                 | 422  | 05   |
| BUDGET_EXCEEDED                  | 429  | 04   |

## 8. 反事实检查（v0 开工前自问）

- 若 confirm 与建 task 不在同一事务：重复确认会建出两条 task → [Required] 必须同事务。
- 若 scheduled 不要求回执：没进钟也敢标已排期 → [Required] 无回执停 pending_schedule。
- 若 missed 可补发：关机错过的旧提醒半夜齐响 → [Required] 超 15min 只标 missed，一键重约开新 task。
- 若取消不优先：取消后仍触发 → [Required] 一级指标取消后触发数 = 0。
