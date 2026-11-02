# time-core 黄金测例

> 状态：v0 可复现。范围：`normalize(wall_time, timezone_id, fold_choice, ruleset)` 纯函数 4 基准 + DST + 50 表达。不包含：LLM 时间解析、客户端换算。阶段标签：v0 MVP。前置：fixture 冻规则内容（`ruleset_id = FIXTURE_V1`），tzdb 版本记录。

## 前置

- 调用 time-core 纯函数（TS 服务端，不读系统时钟、不看当前时区库，规则内容由 fixture 注入）。
- 入口已把人话翻成精确到秒的 `wall_time` + 规范 IANA `timezone_id` + `fold_choice ∈ {first, second, none}`。
- 别名（“北京时间”）由入口版本化别名表查完再递规范值，不进本函数。
- [Observed] 真实fixture只含Shanghai(+08)、Kiritimati(+14)、New York(2026/2027四转换)，不是全IANA或任意年份库。三zone本地 `[2026-01-01T00:00:00,2028-01-01T00:00:00)`、逐zone UTC 边缘、上下文门及取证要求见 `docs/design/05-time-core.md §5/§10`。既有纯函数测例可复用，但不能证明生产真实装载/HTTP/SSE/Web已通过。

## 基准 4 例

### B1 顺路

- 命令：`normalize("2026-10-17T09:20:00", "Asia/Shanghai", "none", FIXTURE_V1)`。
- 预期 JSON：`{"fire_at_utc": "2026-10-17T01:20:00Z", "offset_seconds": 28800, "fold": 0, "ruleset_id": "FIXTURE_V1"}`，无错误。
- 断言：`wall + offset == fire_at_utc` 自检通过。

### B2 不存在的时刻

- 命令：`normalize("2026-03-08T02:30:00", "America/New_York", "none", FIXTURE_V1)`。
- 预期 JSON：`{"error": "NONEXISTENT_LOCAL_TIME"}`，不返回快照。
- 断言：不猜、不存、不排；上游呈现“当地不存在，请重定”并按冻结spec `thread.failed`422终结（SSE外层HTTP200），不是completed；纯函数结果本身不证明这条传输断言。

### B3 重复时刻未选

- 命令：`normalize("2026-11-01T01:30:00", "America/New_York", "none", FIXTURE_V1)`。
- 预期 JSON：`{"error": "AMBIGUOUS_LOCAL_TIME", "candidates": [{"fold_choice": "first", "offset_seconds": -14400, "fire_at_utc": "<05:30Z>"}, {"fold_choice": "second", "offset_seconds": -18000, "fire_at_utc": "<06:30Z>"}]}`。
- 断言：带两个候选且各带偏移（缩写会撞、偏移不会），经 `error.details` 原样传结构化候选及明确日期/时区（design/05 §9.1），Web不自行算UTC。纯函数候选不是HTTP/Web已验收的证明。

### B4 重复时刻已选

- 命令：`normalize("2026-11-01T01:30:00", "America/New_York", "second", FIXTURE_V1)`。
- 预期 JSON：`{"fire_at_utc": "<06:30Z>", "offset_seconds": -18000, "fold": 1, "ruleset_id": "FIXTURE_V1"}`。
- 断言：输入 `fold_choice=second` 对应成功结果及现有 approval 快照 `fold=1`，连偏移共同冻结、回显明确第二次；不虚构 `fold_choice` 数据库列。Web first/second 须带原失败 Run 来源引用、完全相同原文和实际候选时区，以新键重提议，成功后仍须按钮三件套确认；纯函数结果不代替 HTTP/Web 消费验收。

## DST 边界 2 例

### D1 春季跳过（60 分钟凭空消失）

- 命令：`normalize("2026-03-08T02:00:00".."2026-03-08T02:59:59", "America/New_York", "none", FIXTURE_V1)` 区间内任一秒。
- 预期：`NONEXISTENT_LOCAL_TIME`。
- 断言：整段 02:xx 全部拒绝，不存在“差一分钟就能排”的中间态。

### D2 秋季重复（同一墙上时间出现两次）

- 命令：`normalize("2027-11-07T01:30:00", "America/New_York", "none", FIXTURE_V1)`（B06 §3.6 原例）。
- 预期：`AMBIGUOUS_LOCAL_TIME`，候选为第一次（UTC−04:00）与第二次（UTC−05:00）。
- 断言：回显模板走歧义版（“按 America/New_York 选择第二次出现的 01:30（UTC−05:00）”）。

## 50 表达adaptation（入口归一到秒的覆盖表，节选写法）

入口层（非本函数）把模糊人话翻成精确 `wall_time` 或挡回；下表给断言方向，`→` 后为期望：

1. `9:20` → `09:20:00`（补前导零只改写法）。
2. `晚上 9 点` → `21:00:00`（唯一时段映射）。
3. `中午 12 点` → `12:00:00`；`凌晨 0 点` → 当天 `00:00:00`。
4. `10 月 16 日 24:00` → 次日 `00:00:00`（按 `00:00` 显示）。
5. 秒没说 → 补 `:00` 再递归一。
6. 年份缺失 → 问（不默认今年、不顺延）。
7. 时区缺失 → 问（不按位置/设备猜）。
8. 光说 `9 点` → 问早晚（`09:00` vs `21:00`）。
9. 光秃秃 `12 点` → 问中午还是午夜。
10. `0 点` → 问 16 日开头还是进 17 日的午夜。
11. `12 点左右` → 挡（范围无法唯一排触发点）。
12. `尽快` → 问具体日期时间（“急”不是时间，原话只当备注）。
13. `有空时` → 挡（v0 不读日历不监测空闲）。
14. `明天` → 新明确日期请求按本轮服务端接纳时刻 + 已确认时区解析冻结，不取旧会话建立锚；仅可追溯、紧邻上一 user 消息且全会话唯一未完成提醒的真实缺时区/歧义失败可继承原锚。整条明确时区补充保留原日期；fold 原文完全相同且带 `clarification_of_run_id`、实际候选时区及 first/second 才能重提议。同日本地 10:00→10:02 不报跨日；23:59:50→次日00:00:10 必问具体日期。多个候选、无关中间 user 目标、缺来源旧 Run 或不明补充要求完整重述；旧 Run/工具重放/批准恢复不换锚，未来时间与有效期不变。该条是入口/API/PG 消费验收方向，不由纯 normalize 测例证明，详见 `docs/design/05-time-core.md §3`。
15. 其余 36 条同理：不改变含义的唯一格式映射可归一；凡替用户选定日期/时区/时段的就是决定，必须问（分界尺 B06 §3.5）。

## 错误出口

| 错误                     | 何时                      | 上游动作                        |
| ------------------------ | ------------------------- | ------------------------------- |
| `NONEXISTENT_LOCAL_TIME` | 时刻不存在                | typed failed422，呈现重定话术   |
| `AMBIGUOUS_LOCAL_TIME`   | 重复未选（带两候选）      | typed failed422，结构化候选供选 |
| `TZDB_UNAVAILABLE`       | 规则缺失或所需范围外      | 预检503拒绝或流内failed503      |
| `UNKNOWN_TIMEZONE`       | 本版本未知规范ID/显式别名 | typed failed422，不静默fallback |

## 常见问题

| 现象                             | 原因           | 处理                                                    |
| -------------------------------- | -------------- | ------------------------------------------------------- |
| 同一 wall 在两台机器算出不同 UTC | 规则内容不一致 | 对 `ruleset_id`，不一致停服，不降级                     |
| 客户端自报时间参与锚定           | 越界           | 客户端时间只诊断，锚只用服务端首次接收时刻              |
| 展示层出现换算后时间             | 越界           | 展示只摆原话 + 归一本地时间 + 时区；UTC/fold/库版本内部 |
