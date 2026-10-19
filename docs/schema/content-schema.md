# Content Schema 设计

> 状态：Deferred（P1 后；S0 #14 冻结：v0 简报为只读投影，不建 `briefs`/`cards` 表，不做 `unique(owner,brief_date)` 落库；本篇为 P1 卡片持久化预留，不作为 v0 开工依据）。范围：`briefs`、`cards` 两表（P1 后）。不包含：卡片运行时 bundle、演示沙箱、健康/记忆卡片（Deferred）。阶段标签：P1 后（v0 只读投影见 `docs/api/brief/brief_routes.md`）。

## 设计依据

- 产品循环：每日简报（brief）→ 卡片 → 对话 → 调度任务核心循环；卡片三类各带版本化 schema。
- B06 v0 切片首步即简报→卡片；本篇只定服务端投影存档，不定客户端渲染协议（客户端渲染协议以自家 design 为准）。
- 差异化三点落 P1（确认门/时间层/事件账），本篇 content 为三者的只读投影，不做授权依据。

## 表关系

```text
briefs 1 ── 0..n cards
tasks 1 ── 0..n cards        (逻辑引用，卡片可挂 task)
approvals 1 ── 0..n cards    (逻辑引用，待确认卡片可挂 approval)
```

- `briefs`/`cards` 引用 task/approval 只存 id，不建物理 FK（跨模块只传 id）。
- 卡片展示层死规矩：只读冻结字段做固定格式呈现，不换算、不推断、不改写（B06 §5）。

## `briefs`

### 用途

[Required] 每日简报存档。P1 存档（v0 为只读投影，不建表）；打开应用跑对账的展示底座。

### 字段

| 字段             | 类型          | 约束                      | 说明                                          |
| ---------------- | ------------- | ------------------------- | --------------------------------------------- |
| `id`             | `uuid`        | primary key               | 简报 ID                                       |
| `owner_id`       | `uuid`        | not null                  | 所属用户，查询必带                            |
| `brief_date`     | `date`        | not null                  | 简报日期（按已确认时区的本地日期）            |
| `timezone_id`    | `text`        | not null                  | 生成时采用的时区                              |
| `schema_version` | `text`        | not null                  | 简报结构版本（如 `brief.v1`）                 |
| `summary`        | `text`        | not null, default `''`    | 摘要正文                                      |
| `payload`        | `jsonb`       | not null, default `'{}'`  | 结构化内容（议程/提醒清单摘要；不存敏感原文） |
| `created_at`     | `timestamptz` | not null, default `now()` | 创建时间                                      |

### 约束与索引

- `unique(owner_id, brief_date)`，每用户每天一份简报。
- `index(owner_id, brief_date desc)`，简报历史。

### 写入规则

- [Required] 同一天重生成覆盖 `payload`（简报非事件账，允许更新；更新不改 `brief_date`）。
- [Required] `payload` 不存敏感值原文；引用 task/approval 只存 id。
- 没事首页安静：无异常不打扰，只留记录（B06 §10）。

## `cards`

### 用途

[Required] 任务卡/信息卡存档。多步骤任务的进度、产物、待确认项可视化底座。

### 字段

| 字段             | 类型          | 约束                         | 说明                                                                  |
| ---------------- | ------------- | ---------------------------- | --------------------------------------------------------------------- |
| `id`             | `uuid`        | primary key                  | 卡片 ID                                                               |
| `owner_id`       | `uuid`        | not null                     | 所属用户，查询必带                                                    |
| `brief_id`       | `uuid`        | nullable                     | 所属简报（逻辑引用，可空；对话中产生的卡片可无简报）                  |
| `kind`           | `text`        | not null                     | 按 `task_confirm/task_progress/info` 约束（P1 三类；健康卡 Deferred） |
| `schema_version` | `text`        | not null                     | 卡片结构版本（如 `card.v1`），各带版本化 schema                       |
| `title`          | `text`        | not null                     | 卡片标题                                                              |
| `body`           | `text`        | not null, default `''`       | 卡片正文（由冻结快照生成）                                            |
| `task_id`        | `uuid`        | nullable                     | 关联 task（逻辑引用）                                                 |
| `approval_id`    | `uuid`        | nullable                     | 关联 approval（逻辑引用，待确认卡片）                                 |
| `status`         | `text`        | not null, default `'active'` | 按 `active/dismissed/expired` 约束                                    |
| `created_at`     | `timestamptz` | not null, default `now()`    | 创建时间                                                              |
| `updated_at`     | `timestamptz` | not null, default `now()`    | 更新时间                                                              |

### 约束与索引

- `index(owner_id, created_at desc)`，卡片流。
- `index(brief_id)`，按简报聚合。
- `index(task_id)`，按 task 追卡片。
- `index(owner_id, status)`，活跃卡片筛。

### 写入规则

- [Required] 卡片是投影不是授权：点确认必须走 approval 消费事务，不认卡片 `status`。
- [Required] 时间展示只读冻结快照（`wall_time` + `timezone_id`），不换算、不推断。
- [Required] `MISSED` 卡片不补发，只给重约口（`recreated_from` 开新 task）。
- [Proposed] 用户手动关闭记 `dismissed`；过期（关联 approval/task 终态）顺路标 `expired`。
