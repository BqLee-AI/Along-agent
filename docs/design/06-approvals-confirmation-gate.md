# 06. 确认门一等公民（approvals）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：approval 对象、快照冻结、状态机、确认规则、presentation_hash + version、幂等、同事务、展示只读
- **不包含**：task 调度触发细则（见 08）、事件账词汇（见 07）、time-core 归一（见 05）；实现代码
- **阶段标签**：v0 / P0（P1 起为三差异化之首常驻）

## 引用

- B06 §5 确认与 C 草稿；B03 §4.3 HITL；B02 §2.9 HITL；AF checkpoint 思想

## 0. 设计结论

- [Required] 确认门是 v0 唯一“点头”：confirm 之前无 task、无排期；草稿只是 approval(pending)。
- [Required] 只有整句“确认 A-XXXX”或点确认按钮才算；“好/嗯/行”不算。
- [Required] 确认绑定三样：`approval_id` + 当时看到的完整内容 + `presentation_hash`；对不上即 PRESENTATION_MISMATCH。
- [Required] Approval 消费 + 建 task 同事务是唯一跨模块事务。

## 1. approval 对象（字段到名）

```text
Approval
  approval_id        UUID，永不复用（短号仅定位、不授权）
  owner_id           归属
  original_text      用户原话（原样存）
  fire_at_utc        time-core 输出（触发依据）
  timezone_id / local_datetime / fold / resolved_utc_offset_seconds
  tzdb_version / ruleset_id / presentation_version / presentation_hash
  occurrence         single（v0 只单次）
  status             pending | consumed | rejected | expired | superseded
  consumed_task_id   消费产出的 task（重复确认回它）
  supersedes_approval_id / superseded_by_approval_id
  created_at / expires_at（24h 起步值，待校准）
```

- [Required] 除 `status / consumed_task_id / superseded_by` 外建后冻结；展示层只读冻结字段。
- [Proposed] 过期顺路清（启动/读取/确认时），不另养后台进程；过期清内容留号 30 天。

## 2. 快照与回显

- [Required] 回显模板普通版：“请确认 A-0051：你说‘明天 9:20’，我将它归一为 2026-10-17 09:20（Asia/Shanghai），设为单次提醒；确认前不会创建正式提醒，也不会排期。”
- [Required] 歧义选第二次版：“原话‘2027-11-07 01:30’，按 America/New_York 选择第二次出现的 01:30（UTC−05:00），单次提醒；确认前不会创建正式提醒或排期。”
- [Required] 模板带版本，approval 冻 `presentation_version`；旧 approval 用旧模板直到过期；语言是独立维度，切语言重生成重确认；旧模板有显示 bug → 作废旧 approval 重来，不悄悄替换。
- [Required] 摆错了（回显 09:20、快照 10:00）→ 暂停待核对，不建不排；快照自洽不过（墙上+时区+偏移推不出 UTC）→ 待修复，换新 approval 重来，旧转墓碑。

## 3. 状态机 [Required]

```text
pending -> consumed（confirm 单事务，建出 task）
pending -> rejected（reject）
pending -> expired（超 24h 起步值或目标已过）
pending -> superseded（被新 approval 替代；改字段重回显，旧键作废）
```

- [Required] 事务内验三样：owner 一致、status=pending、`now < expires_at`；迟到确认按过期/被替回话。
- [Required] 两条 pending 躺着、光说“确认”不指明 → 挡回，请指明一条。
- [Required] 23:50 摆的日期，00:05 点头还是那一天（冻住的不重算）；超 24h 或目标已过旧确认作废。

## 4. 确认规则 [Required]

- v0 只认点确认按钮（S0 #14 冻结：整句“确认 A-XXXX”文本只做展示，不做意图解析；文本确认能力延 P1，届时补意图→confirm 路由与多 pending 消歧契约）；“好/嗯/行”不算。
- 确认请求带三样：路径 `approval_id` + 当时看到的完整内容 `seen_content` + `presentation_hash`（规范编码：排版空格不算，原话空格算，时间先归一再编码；三件套缺一即 `400 VALIDATION_ERROR`）。
- 服务端按快照重建预期比对，对不上 → PRESENTATION_MISMATCH，停在待核对。
- 连点两次只回同一个 task：“这是重复确认，没有新建第二条。”（幂等键 + consumed_task_id 双保险）
- 多条待确认必须指明；改字段重回显，旧键作废（superseded）。

## 5. presentation_hash + version [Required]

```text
presentation 输入
  original_text（原样，空格算） + 归一本地时间 + timezone_id + fold/偏移
  + occurrence + presentation_version
  排版空格不计入；时间先归一再编码
```

规范编码算法（v1，实现唯一真源 `apps/api/src/modules/approvals/presentation.ts#computePresentationHash`）：

- 字段按序取 `[domain, presentation_version, original_text, local_datetime, timezone_id, fold, offset_seconds, occurrence]`，其中 `domain = "along-presentation/v1"`，`local_datetime` 为 time-core 归一后的 `"YYYY-MM-DD HH:mm"`，`fold` 为 `"0"|"1"`，`offset_seconds` 为十进制秒数，`occurrence` 为 `"single"`。
- 每字段做长度前缀 `len(bytes):bytes`（UTF-8 字节数），直接拼接（无分隔符）得 canonical。
- `hash = "ph_" + sha256(canonical, hex)`。模板排版空白永不进 hash；`original_text` 逐字节精确。

## 6. 同事务（唯一跨模块事务）[Required]

- 同一事务：验 owner/pending/有效期 → 比 hash → 建 task(saved) → 写 task_events.created → 写 outbox → approval→consumed。
- 任一步失败全回滚；对外只说“没记上”，不报成功。

## 7. 展示只读 [Required]

- 展示层只读冻结字段做固定格式呈现，不换算、不推断、不改写。
- 确认按钮上方常驻短告知（起步文案，待校准）：“提醒保存在云端；到点在调度器成功运行时尝试通知。设备关机、休眠或进程未运行时可能错过，不保证准时响。”

## 8. 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| PRESENTATION_MISMATCH | 409 | 摆与存对不上，停 |
| APPROVAL_EXPIRED | 410 | 超 24h 或目标已过 |
| APPROVAL_SUPERSEDED | 409 | 已被新确认单替代 |
