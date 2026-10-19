# 07. 只追加事件账（task_events）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：只追加词汇、条目字段、同事务、取消优先、活动读模型、对账语
- **不包含**：Scheduler 租约实现（见 08）、approval 快照（见 06）；实现代码、SQL
- **阶段标签**：v0 / P0（P1 起为三差异化之一常驻：可解释主动行为的证据层）

## 引用

- B06 §6 R 状态机、§9 取消召回重约、§10 可观测与诚实口径；AF checkpoint/审计思想

## 0. 设计结论

- [Required] task_events 只追加：DB 禁 UPDATE/DELETE；错了另起一行，不改旧账。
- [Required] 状态与事件同一事务写，要么全成要么全不成。
- [Required] 取消优先：cancel 提交后排队重试全作废；“曾排上”也不复活。
- [Required] 对外只说已记录步骤，不承诺必达；业务自写账不算唯一证据，触发器同事务跟写 + 独立只读检查器对一遍（v0 明说不防本机篡改，云端版为独立读检查）。

## 1. 事件词汇（封闭集合）[Required]

```text
created             confirm 单事务建 task（首事件）
scheduled           收到 schedule 登记回执
fired               15min 内 + Notifier 回执
missed              超 15min，不补发
cancel_requested    收到取消请求（进 cancel_pending）
cancelled           收到撤销回执（终态）
reconciliation_run  打开应用跑对账（STARTED 先落，崩了算没跑完）
```

- [Required] 不新增词汇；FAILED_DEADLINE_WINDOW / ACK_UNKNOWN / SUPERSEDED 为事件上的结果标记，不是新类型。
- [Required] 每行字段：`task_id / state_version / event_id / type / recorded_at_utc / evidence_ref`（有凭据写号，没有写“系统记录”）。

## 2. 写规则 [Required]

- confirm 单事务写 `created`；登记回执事务写 `scheduled`；触发事务写 `fired/missed`；取消两步写 `cancel_requested→cancelled`。
- 状态与事件同一事务；版本（state_version）本机发、提交时原子递增。
- `recreated_from` 唯一：一旧只一新；只保证找得回去，不表示相同、不继承授权；内容当候选、时间重给。
- 旧记录一年后删（起步值，待校准），栏里只剩编号终态时间和链接，不留原话内容。

## 3. 取消优先 [Required]

- 取消赢过一切：cancel 提交（`cancel_pending` 提交事务落定即算，S0 #14 冻结）后排队重试全作废；触发门禁照拦。
- 一级指标：取消已提交后仍发出的触发请求数 = 0（数的是调接口那一下；分不清先后按违规计，但明说“不等于认定确在取消后发出”）。
- 破 0 记单独 `security_events`（一年期，不跟 task 走，不留内容），人复核放行。
- 展示缺陷召回（如看到 09:02、实际排 09:20）：认具体的错，旧 task 标召回请求撤销，回执没到前不说已撤，等新预览重认。

## 4. 活动读模型（GET /tasks/{id}/events）[Required]

- 只读 task_events 顺序投影；没事首页安静，只留记录。
- 三种对账话：没记录到触发（原因不明）/ 已错过（给重约口）/ 对不上（暂停等维护者，不怪用户）。
- `MISSED` 打开才说；一键重约开新 task。

## 5. 对账 [Required]

- 打开应用跑对账，先落 `RECONCILIATION_RUN(STARTED)`，崩了算没跑完，从头重查。
- 心跳 30s 一次（起步值，待校准），90s 没声标“未观察到心跳”，不判死；失联只能下次打开发现——写进契约。
