# 05. time-core（服务端确定性时间层）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：归一签名、可归一 vs 必问、模糊词拒绝、锚点冻结、normalize 语义、DST 两天、tzdb + readyz、4 基准、单次语义
- **不包含**：LLM 提示词写法、客户端日期控件、具体 tzdb 版本号、SQL 建表；实现代码
- **阶段标签**：v0 / P0（P1 起为三差异化之一常驻）

## 引用

- B06 §3 时间入口、§4 归一函数；B02 §2.1（人话由入口翻完再递）；外部参考均不抄

## 0. 设计结论

- [Required] LLM 不算时间，展示层不换算；唯一权威是 TS 服务端纯函数 `normalize`。
- [Required] “明天” = 服务端首次接收时刻 + 已确认时区，解析一次即冻结，之后不再重算。
- [Required] 单次语义：按确认时那只钟对应的**瞬间**触发；出差换城市不改。
- [Proposed] 24h / 15min / 1min / 30s 等起步值全标待校准，以自家可测指标为准。

## 1. 归一签名（字段到名，不写代码）

```text
normalize(wall_time, timezone_id, fold_choice, ruleset) -> Result
  in
    wall_time       精确到秒的墙上时间（入口已翻完“明天/第二次”等人话再递）
    timezone_id     规范 IANA 值（别名由入口版本化别名表查完再递）
    fold_choice     first | second | none
    ruleset         不可变规则内容（含 ruleset_id + tzdb_version 引用）
  out（成功）
    fire_at_utc / offset_seconds / fold / ruleset_id
  out（失败，分得清的错）
    NONEXISTENT_LOCAL_TIME | AMBIGUOUS_LOCAL_TIME（带两候选） | TZDB_UNAVAILABLE | UNKNOWN_TIMEZONE
```

- [Required] 纯函数：不读系统时钟、不看当前时区库快照之外的东西；可测、可回放。
- [Required] 别名（“北京时间”等）由入口版本化别名表查完再递规范值进来，normalize 不认别名。

## 2. 入口规则：可归一 vs 必问 vs 拒绝

### 2.1 可直接归一（不问）[Required]

- `9:20` → `09:20`；大小写、前导零只改写法。
- “晚上 9 点” → `21:00`（“晚上”唯一确定时段）。
- “中午 12 点” → `12:00`；“凌晨 0 点” → 当天 `00:00`。
- “10 月 16 日 24:00” → 次日 `00:00`，并按 `00:00` 显示。
- 秒没说，入口按约定补 `:00` 再递（归一永远只收完整到秒的）。

### 2.2 必须问（不许默认）[Required]

- 年份缺失（不默认今年、不顺延明年）。
- 时区缺失（不按位置/设备猜；本次确认只用于本次）。
- 光说“9 点”没早晚；光秃秃“12 点”（中午还是午夜不替选）；“0 点”指哪日开头/结尾。
- **分界尺**：不改变含义的唯一格式映射可归一；凡替用户选定日期/时区/时段的就是决定，必须问。

### 2.3 模糊词一律挡 [Required]

- “12 点左右” → “范围无法唯一排触发点，请给准确时刻；v0 不支持范围提醒。”
- “尽快” → 问具体日期时间；它是急不是时间，问出后原话只当备注，不提前不加催。
- “有空时” → “v0 不读日历、不监测空闲，这次不保存；请给明确日期时间时区。”
- 未办成愿望记独立“未支持请求”列表（30 天归档、一年删，只主动看或 v1 评审翻）。

## 3. 锚点冻结 [Required]

- “明天”按**服务端首次接收时刻 + 已确认时区**解析一次，写进回显即冻住。
- 延迟超 1min（起步值，待校准）不换算相对日期；跨过确认时区午夜无论多久都追问具体日期。
- 1min 线保“说的是哪天”，15min 线保“这声值不值得打断”，两线不共用。
- 客户端自报时间只用于诊断，不参与锚定。
- 时区未确认时连“早上”都算不出，就等用户回来，不主动叫醒。

## 4. DST 两天（例外也是契约）[Required]

- 不存在时刻（如 `2027-03-14 02:30 America/New_York`）→ NONEXISTENT_LOCAL_TIME：“当地并不存在；不猜、不存、不排，请重定。”不返回快照。
- 出现两次（如 `2027-11-07 01:30`）→ fold=none 时 AMBIGUOUS_LOCAL_TIME 并带两候选（first/偏移/UTC、second/偏移/UTC），必须摆偏移（缩写会撞、偏移不会）；用户选定后 `fold_choice` + 偏移双冻结进快照，缺一样即解释不清，作废重来。

## 5. tzdb + readyz [Required]

- 规则缺失 → 服务不就绪：`/readyz` 返回类型化错误（TZDB_UNAVAILABLE），不降级、不猜。
- 入口调用前先报 TZDB_UNAVAILABLE，连归一都不叫。
- 快照自带 `tzdb_version + ruleset_id`；旧快照用旧规则解释，不悄悄替换。

## 6. 四个基准测例（先路通再钉墙）[Required]

```text
1 顺的：2026-10-17T09:20:00 + Asia/Shanghai + FIXTURE_V1
  -> 2026-10-17T01:20:00Z / +08:00 / NOT_AMBIGUOUS
2 不存在的：2026-03-08T02:30 + America/New_York
  -> NONEXISTENT_LOCAL_TIME，无快照
3 没选的重复：2026-11-01T01:30 + America/New_York + fold=none
  -> AMBIGUOUS_LOCAL_TIME，带两候选（first/-04:00/05:30Z，second/-05:00/06:30Z）
4 选了的重复：fold_choice=second
  -> 06:30Z / -05:00 / fold=second；快照冻结 fold_choice=second + 偏移
```

## 7. 存摆分家与单次语义 [Required]

- 存：`fire_at_utc`（触发依据）+ 墙上时间 + 时区 + fold + 偏移 + 时区库版本。
- 摆：平时只摆原话 + 归一本地时间 + 时区；UTC、`fold` 码、库版本留内部。
- 单次语义：上海 09:20 定的，纽约当地 21:20 响，不改成纽约 09:20。

## 8. 错误码口径

| 错误码 | HTTP | 对外话 |
| --- | --- | --- |
| NONEXISTENT_LOCAL_TIME | 422 | 当地并不存在，请重定 |
| AMBIGUOUS_LOCAL_TIME（带两候选） | 422 | 出现了两次，请选第一次/第二次（含偏移） |
| UNKNOWN_TIMEZONE | 422 | 请给规范时区或重选 |
| TZDB_UNAVAILABLE | 503 | 时间规则不可用，暂不开张（readyz 同码） |
