# v0 切片冒烟：干净单次提醒闭环

> 状态：v0 可复现。范围：Web 单端 7 步全链路冒烟。不包含：自动化脚本、多用户并发、性能压测。阶段标签：v0 MVP。前置：服务端就绪（`/healthz`、`readyz` 绿）、已确认时区 `Asia/Shanghai`、服务端可信钟可用。

## 前置

- 服务 `/healthz` 返回 `ok`；`/readyz` 无类型化错误（tzdb 缺失则停，不降级）。
- 准备用户 A（`owner_id` 已注入），浏览器打开 Web 对话页与任务页。
- 时钟：服务端可信钟与正确 tzdb 版本（`tzdb_version` 记录在案）。

## 步骤

### 步 1 简报

- 命令：`GET /brief`。
- 预期 JSON：`{"date": "<本地日期>", "timezone_id": "Asia/Shanghai", "summary": {"pending_count": 1, "fired_count": 0}, "cards": [...]}`（S0 #14 冻结：只读投影，不建 `briefs` 表，无 `unique(owner,brief_date)` 落库断言）。
- 断言：`date` 为已确认时区本地日期；重复 GET 同一天返回同一投影（读 tasks/approvals 当前态，不做落库幂等断言）。

### 步 2 卡片

- 命令：打开简报页，查看任务卡片（`kind=task/approval`；旧 `task_progress/info` 作废）。
- 预期：卡片含 `schema_version`（如 `card.v1`），时间展示为冻结墙上时间 + 时区，不换算。
- 断言：卡片只读投影；点卡片不产生 task（须走确认门）。

### 步 3 对话

- 命令：`POST /conversations/messages`（SSE）正文 `{"conversation_id": "<cid>", "message": "明天 9:20 提醒我喝水。"}`。
- 预期 SSE：`thread.started` → `message.delta`（含 `请确认 A-xxxx：你说"明天 9:20"，我将它归一为 <次日> 09:20（Asia/Shanghai），设为单次提醒；确认前不会创建正式提醒，也不会排期。`）→ `approval_required` → `thread.completed`（S0 #14 冻结：旧 `thinking/done` 为 AgentEvent 内部名，对外只认 thread 系）。
- 断言：`GET /approvals/{id}` 为 `pending`；`GET /tasks` 为空（没点头不进钟）。

### 步 4 确认

- 命令：点确认按钮 → `POST /approvals/{id}/actions/confirm` 正文 `{"presentation_hash": "<回显看到的哈希>", "seen_content": "<当时看到的完整回显原文>", "idempotency_key": "<uuid>"}`（S0 #14 冻结：`approval_id` 取自路径，不在 body 重复；v0 只认按钮）。
- 预期 JSON：`{"task_id": "<tid>", "state": "saved"}`；重复确认返回同一 `task_id`（“这是重复确认，没有新建第二条”）。
- 断言：`GET /approvals/{id}` 为 `consumed` 且 `consumed_task_id = <tid>`；哈希对不上返回 `PRESENTATION_MISMATCH` 且不建 task。

### 步 5 到点

- 命令：等待 `fire_at_utc`（测试可用近未来时间重走步 3–4）；到点后 `GET /tasks/{id}` 与 `GET /tasks/{id}/events`。
- 预期：15 分钟内 `state=fired` + 事件账 `fired`（`evidence_ref` 为回执号或 `local`）；应用内通知到达（`GET` 通知列表可见）。
- 断言：超 15 分钟只标 `missed` 不补发；口径只说已记录步骤。

### 步 6 活动页

- 命令：打开任务活动页（`GET /tasks/{id}` + `GET /tasks/{id}/events` 渲染）。
- 预期：状态时间线（`saved → pending_schedule → scheduled → fired`）与事件账（`created → scheduled → fired`，S0 #14 冻结：账本无 saved 中间态）逐行一致。
- 断言：任一步失败保持未完成并可重试，不报成功。

### 步 7 取消

- 命令：另建一个未来 task（重走步 3–4），随后 `POST /tasks/{id}/actions/cancel`。
- 预期 JSON：`{"state": "cancel_pending"}` → 回执到后 `{"state": "cancelled"}`；无回执停在 `cancel_pending`，不谎称已取消。
- 断言（一级指标）：取消提交后触发请求数 = 0（查 `task_events` 无 `fired`，`outbox` 余单全 `superseded`）。

## 常见问题

| 现象                              | 原因                  | 处理                                         |
| --------------------------------- | --------------------- | -------------------------------------------- |
| 确认返回 `PRESENTATION_MISMATCH`  | 回显与快照对不上      | 停在待核对，重回显新 approval，旧键作废      |
| 确认返回 `APPROVAL_EXPIRED (410)` | 超 24h 或目标已过     | 旧确认作废，重走对话                         |
| 确认返回 `APPROVAL_SUPERSEDED`    | 改字段已出新 approval | 用新 approval 确认                           |
| 归一返回 `NONEXISTENT_LOCAL_TIME` | 当地不存在的时刻      | 不猜不存，请重定                             |
| 归一返回 `AMBIGUOUS_LOCAL_TIME`   | 重复时刻未选          | 出两候选（各带偏移），用户选 first/second    |
| `/readyz` 报 `TZDB_UNAVAILABLE`   | 时区库缺失            | 不开张，先补 tzdb，不降级                    |
| 取消后仍收到触发                  | 并发竞争              | 按违规计（分不清先后按违规计），查证据人复核 |
