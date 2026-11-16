# 05. time-core（服务端确定性时间层）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：归一签名、可归一 vs 必问、模糊词拒绝、锚点冻结、normalize 语义、DST 两天、tzdb + readyz、4 基准、单次语义
- **不包含**：LLM 提示词写法、SQL 建表、全 IANA tzdb、实现代码；客户端仅规定候选选择契约
- **阶段标签**：v0 / P0（P1 起为三差异化之一常驻）

> 时间作用域：本文现行 wall 入口/必问/按钮规则继续约束 legacy。新 profile 的可信设置事实、严格 elapsed/UTC 分支、过窗和 task/今日投影迁移见 [design/20 §4](20-goal-scoped-delegation.md)（Proposed）；纯函数、真实规则、DST、冻结显示及 typed readiness 不弱化，本次不改运行行为。

## 引用

- B06 §3 时间入口、§4 归一函数；B02 §2.1（人话由入口翻完再递）；外部参考均不抄

## 0. 设计结论

- [Required] LLM 不算时间，展示层不换算；唯一权威是 TS 服务端纯函数 `normalize`。
- [Required] “明天”按**该提醒请求的服务端接纳时刻 + 已确认时区**解析一次冻结；新请求用本轮锚，可信同一提醒澄清继承原锚，不复用会话建立锚（§3）。
- [Required] 单次语义：按确认时那只钟对应的**瞬间**触发；出差换城市不改。
- [Proposed] 24h / 15min / 30s 等起步值全标待校准，以自家可测指标为准；不设相对日期锚龄重问线。
- [Observed] `FIXTURE_V1` 只有三个 zone 与纽约 2026/2027 四次转换，现实现会向区间外沿用末偏移，不能据此宣称全 IANA 或任意年份正确。
- [Required · #30] 失败帧、有限覆盖、应用规则上下文与 Web 选择均按本篇及安全 spec；合同不是运行证据。冻结安全 spec Requirement 1/Scenario 1.2 为权威，不改成 `completed` 迎合实现。

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
- “下午三点二十”“下午三点二十分”“下午两点半”分别唯一映射为`15:20`、`15:20`、`14:30`；只解析时钟片段，不改写日期、提醒内容或其中的中文数字。
- “中午 12 点” → `12:00`；“凌晨 0 点” → 当天 `00:00`。
- “10 月 16 日 24:00” → 次日 `00:00`，并按 `00:00` 显示。
- 秒没说，入口按约定补 `:00` 再递（归一永远只收完整到秒的）。

### 2.2 必须问（不许默认）[Required]

- 年份缺失（不默认今年、不顺延明年）。
- 时区缺失（不按位置/设备猜；本次确认只用于本次）。
- 光说“9 点”没早晚；光秃秃“12 点”（中午还是午夜不替选）；“0 点”指哪日开头/结尾。
- **分界尺**：不改变含义的唯一格式映射可归一；凡替用户选定日期/时区/时段的就是决定，必须问。

提醒创建必须同时给出日期、时刻、已确认时区和非空事项；缺日期返回`DATE_MISSING/ASK_DATE`，不能借接收锚补当天或误称“跨天”。`propose_task`的时间原话和事项原话是两个独立字段：公共归一用例以`requireCompleteReminder=true`开启完整提醒检查，以可选`reminderContent`传入原`note`作非空检查，不将事项拼入或改写时间原话。完整重述的revise未提供该可选值时仍从原完整文本提取事项。以上检查只返回澄清，不创建批准；低层局部格式测例不等于允许创建缺字段提醒。

### 2.3 模糊词一律挡 [Required]

- “12 点左右” → “范围无法唯一排触发点，请给准确时刻；v0 不支持范围提醒。”
- “尽快” → 问具体日期时间；它是急不是时间，问出后原话只当备注，不提前不加催。
- “有空时” → “v0 不读日历、不监测空闲，这次不保存；请给明确日期时间时区。”
- 未办成愿望记独立“未支持请求”列表（30 天归档、一年删，只主动看或 v1 评审翻）。

## 3. 锚点冻结 [Required]

- 日期锚属于提醒请求，不属于会话寿命。conversations 在新消息接纳事务中读取 DB `clock_timestamp()`，分别冻结本轮 `receivedAtUtc` 与权威 `anchorReceivedAtUtc`；新明确日期请求两者同源，可信澄清只继承原 anchor，received 仍为本轮接纳时刻。客户端自报时间只诊断，模型不提供权威时钟。
- 可独立接纳的完整重述须由本轮用户重新表达日期及提醒指令，且不是带旧来源或 fold 选择的精确重提议；单独带回相对日期词不足以证明新请求。随后仍检查日期、时刻、时区及事项，不从旧上下文补字段。
- 仅当同 owner、同 conversation 的**全部尚未完成候选中恰好一个**，且它对应紧邻上一条 user 消息，才可能继承。源 Run 必须为 `done/failed`、原消息与冻结来源可追溯，且有实际接受的 `TIMEZONE_MISSING` 澄清或 `AMBIGUOUS_LOCAL_TIME` 候选失败；已被后继 `sourceRunId` 引用的源不再作为未完成候选。只看最新 Run、相似文本或模型声称在继续均不够。
- 支持的补充仅两类：整条消息是明确时区别名/规范 ID，补原请求缺失的时区；或带 `clarification_of_run_id` 的精确 fold 重提议，原文与原提醒完全一致、所选时区等于实际失败候选，并提供结构化 first/second。引用只是待核验关系，不是授权；不是任意自由文本多轮补全。
- 多候选、无关中间 user 目标、缺失/损坏来源、旧 Run 无来源或其他关系不明的补充，只要求完整重述日期、时刻、时区及事项，不任挑旧锚、不从历史凑字段。缺时区先问，不用设备或位置猜本地日界；缺日期仍为 `DATE_MISSING/ASK_DATE`。
- 可信澄清在确认时区内与原接纳处于同一本地日期时保留原日期；本地 10:00→10:02 的 120 秒不报 `DATE_CHANGED`。实际跨本地午夜则无论多久都问具体日期，23:59:50→次日 00:00:10 的 20 秒也不能滚动解释“今天/明天”。独立新明确日期请求使用本轮锚，不套用旧请求跨日判断。
- 新 Run 在既有不可变 `frozen_context` 写 `reminderDateSource={version:1,kind:new|clarification|unresolved,inputMessageId,sourceRunId?,sourceInvocationId?}`；clarification 引用实际来源 Run/调用及权威原消息。`unresolved` 不授权创建提醒。沿 0015 冻结约束，不新增表/迁移，不给旧 Run 回填猜测来源。
- gateway 按当前 Run 的持久来源约束模型提议：日期表达必须等于权威原输入，`raw_time_text` 必须是该输入原文子串；澄清提议的 `note` 也必须为原文子串。历史上下文、带回的相对词或模型生成日期不能把旧提醒变成本轮新日期授权。
- 同 Run 工具调用/重放、同键消息重放、批准恢复及只读历史只消费各自已持久冻结的 anchor/received；不在消费时读当前钟，不改旧 Run、approval/task、fold/偏移/UTC 或回显。未来时间与批准有效期继续独立校验；本合同不放行过期目标。

## 4. DST 两天（例外也是契约）[Required]

- 不存在时刻（如 `2027-03-14 02:30 America/New_York`）→ NONEXISTENT_LOCAL_TIME：“当地并不存在；不猜、不存、不排，请重定。”不返回快照。
- 出现两次（如 `2027-11-07 01:30`）→ `fold_choice=none` 时 AMBIGUOUS_LOCAL_TIME 并带两候选（first/偏移/UTC、second/偏移/UTC），必须摆偏移（缩写会撞、偏移不会）。输入/候选的 `fold_choice` 是 `first | second | none`；成功结果与现有 approval 快照的 `fold` 是 `0 | 1`，分别表示较早/较晚瞬间，不虚构持久化 `fold_choice` 列。用户选择语义与偏移共同冻结进回显/快照，缺一样即解释不清，作废重来。
- 首次出现的选定语义由创建入口连同 `fold=0` 传给审批创建器，新 first 回显冻结 `presentation_version=v2`，明确“第一次出现”及 `UTC±HH:MM` 数值偏移；second 保留既有 v1 第二次模板。详情、SSE 与确认校验读取该冻结版本和偏移，不靠当前规则或墙上时间重新判断歧义。模板与旧提议处理见 design/06 §2。

## 5. tzdb + readyz [Required]

- 规则缺失 → 服务不就绪：`/readyz` 返回类型化错误（TZDB_UNAVAILABLE），不降级、不猜。
- 入口调用前先报 TZDB_UNAVAILABLE，连归一都不叫。
- 归一结果携 `ruleset_id`，现有 approval/task 冻结 `tzdb_version` 与墙上时间/时区/fold/偏移/UTC；SSE 开始帧已有 `ruleset_id/tzdb_version`。不把设计中的规则溯源要求误称现有表已存 `ruleset_id` 列。旧快照按已冻结值解释，不依赖当前规则重算或悄悄替换。

### 5.1 实际规则与有限承诺 [Observed / Required · #30]

Observed 来源为 `packages/time-core/src/fixtures/fixture-v1.ts`：`ruleset_id=FIXTURE_V1`、`tzdb_version=fixture-v1`；`Asia/Shanghai` 固定 `28800` 秒、`Pacific/Kiritimati` 固定 `50400` 秒，均无转换；`America/New_York` 基础偏移 `-18000` 秒，转换如下（转换瞬间即使用新偏移）：

| UTC 转换瞬间         | 新偏移（秒） | 对应本地边界             |
| -------------------- | ------------ | ------------------------ |
| 2026-03-08T07:00:00Z | -14400       | 01:59:59 后跳到 03:00:00 |
| 2026-11-01T06:00:00Z | -18000       | 01:59:59 后回到 01:00:00 |
| 2027-03-14T07:00:00Z | -14400       | 01:59:59 后跳到 03:00:00 |
| 2027-11-07T06:00:00Z | -18000       | 01:59:59 后回到 01:00:00 |

Required：v0 对三个 zone **仅承诺本地墙上时间半开区间 `[2026-01-01T00:00:00, 2028-01-01T00:00:00)`**，精确到秒。这覆盖 2026 黄金、2027 DST 与范围内近未来/次日用例；不向固定偏移 zone 承诺历史或任意未来年份。下界包含，上界排除，`2027-12-31 24:00` 规范化后已越界；不能凭日期年号或末偏移放行。

| zone               | 对应可用 UTC 半开区间（亦用于该 zone 的相对表达锚点） |
| ------------------ | ----------------------------------------------------- |
| Asia/Shanghai      | `[2025-12-31T16:00:00Z, 2027-12-31T16:00:00Z)`        |
| Pacific/Kiritimati | `[2025-12-31T10:00:00Z, 2027-12-31T10:00:00Z)`        |
| America/New_York   | `[2026-01-01T05:00:00Z, 2028-01-01T05:00:00Z)`        |

入口先校验规范墙上时间范围，再用完整规则判断 gap/fold；成功的 UTC（重复时刻则所有候选）也必须在该 zone 对应区间内。纽约下/上界均为冬令偏移 `-18000`，不能拿夏令偏移算年界。相对表达需要的首次接收锚点及跨日判定用到的服务端时刻，也须在所选 zone 的 UTC 区间内，解析出的目标仍独立检查墙上范围；任一越界为 `TZDB_UNAVAILABLE`，不是不存在时刻。绝对完整输入不因无关的当前年月越界而重写日期，但到期与确认有效期仍按既有规则检查。

这是静态有限生产 profile，不是完整 IANA 发布物；扩区/扩年须先取得实际规则、补边缘与转换证据、修订声明再启用，不能只改环境版本或上界。本轮不引入在线 tzdb 下载、自动更新或新的健康平台。

### 5.2 单一规则上下文与可用性结论 [Required · #30]

API 应用装配边界拥有一份不可变规则上下文：实际规则内容、实际别名表、二者标识、声明支持的三个 zone/上述覆盖区间及校验结论。`/readyz` 与所有**新时间归一**入口（conversation propose_task、后续获批的 revise）消费同一份结论；SSE `thread.started.ruleset_id/tzdb_version` 也从同一上下文取值，不在 gateway 再导入另一常量。上下文不是新的 HTTP DTO、数据库表或 time-core 全局单例；相对锚点仍由调用用例提供，规则包没有时钟所有权。

应用读取环境并装载/校验实际输入；time-core 只接收不可变值、确定性校验覆盖与转换并返回结果，不读 env/时钟/文件/网络，不依赖 API、DB 或 Web。入口别名解析仍是纯值运算。应用可以复用纯校验函数，但不得在 readyz、handler、gateway 各写一份有效性判断，也不得用 `pool` 存在、版本非空或一次黄金结果替代完整性判断。

公共归一用例接收调用方显式 UTC 提醒请求锚点、用于跨日判定的本轮接纳时刻、原输入、已确认时区及 `fold_choice`，只返回澄清/typed时间失败/归一结果值；不创建 approval/task、不拥有幂等表或事务。conversation 按 §3 选择并冻结新请求/可信澄清锚，不再使用会话建立锚；获批的 revise 使用 approvals 持久冻结的首次接收 anchor，按其合同将两个接收参数固定为该 anchor，当前是否过期另由 approvals 锁后 DB clock 判定。所有时区偏移、本地日期与跨日计算仍由 time-core 纯层确定；公共用例不代替 owner/CSRF/行锁/有效期，不读当前时钟“修正”anchor；A2只适配输入/事务与错误传输，不另建 fixture 或候选形状。

可用需同时满足：

1. `TZDB_VERSION` 存在且精确等于实际 `fixture-v1`；实际 `ruleset_id=FIXTURE_V1`。实际内容须与该不可变版本声明一致（上述三个 zone、偏移、四转换及有界覆盖），不能只验标签。
2. zone 集合完整，偏移为有效整数，转换时间有效且严格升序、无重复冲突；不得靠排序/跳过损坏项使坏包“可用”。声明 zone 丢失、错偏移、缺转换、坏内容均不可用。
3. 实际别名表 `ALIAS_TABLE_V1` 完整：北京时间/上海时间→Asia/Shanghai，纽约时间/美东时间→America/New_York，基里巴斯时间→Pacific/Kiritimati；版本、条目及目标与声明一致。缺表、缺条目、未知目标或标识/内容不符是服务规则故障，不是用户未知时区。

错误分界：

| 情形                                                          | 结论                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 上述包、alias、环境版本、声明 zone 规则缺失/损坏/不匹配       | 上下文不可用，`TZDB_UNAVAILABLE 503`；readyz 非就绪                                 |
| 健康上下文中用户给了本 profile 不认识的规范 ID 或未知显式别名 | `UNKNOWN_TIMEZONE 422`，不是服务规则故障；不令整个 readyz 变红                      |
| 已支持 zone 但输入墙上时间/所需锚点越界                       | 该请求 `TZDB_UNAVAILABLE 503`；健康包的 readyz 仍可为 200，不按单次输入污染全局状态 |
| 支持且范围内的 gap / fold 未选                                | `NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME 422`                                 |

一个合法但未在三 zone profile 内的 IANA ID，也属于“本版本不认识”而非宣称全球非法；不得假借缺规则向用户报服务损坏。相反，声明支持的纽约丢失规则绝不能报 UNKNOWN。包级不可用的预检先于本轮时间判定，不能以用户输入掩盖真实坏包。

### 5.3 readyz、预检与旧冻结对象 [Required · #30]

探针沿用 `docs/api/README.md §6` 的**非 envelope**形状：成功 `200 {"status":"ok"}`；失败 `503 {"status":"not_ready","reason":"…"}`，可带既有 `details.missing[]`（至少缺 `TZDB_VERSION` 仍按原键报告）。规则故障 `reason=TZDB_UNAVAILABLE` 优先；仅规则可用而 DB 不可达则 `reason=NOT_READY`。二者同时失败也只返回一个 reason，不新增组合错误或探针端点；实现需做最小真实 DB 可达探测，不能要求全新 D7 库已有业务迁移才就绪。`/healthz` 继续不依赖 DB。

新归一请求先走认证/CSRF、请求结构及既有 owner/资源/幂等只读边界，再在任何新 conversation/message/run/attempt/idempotency 写入与 SSE 头之前检查规则上下文。已知不可用返回业务 `503 TZDB_UNAVAILABLE` 通用 envelope，连 normalize 都不调用；没有新 run，也不预占幂等结果。流已建立后才发现范围外或执行中的规则故障，则走 §9 的 failed503，允许失败审计，不允许承诺写入。

这不是全站 readiness 中间件：旧冻结 approval/task 的读取、已有快照的按钮确认、task 取消/撤销与 worker 执行按既有权限/有效期/回执/冻结 UTC 继续，不重新 normalize，也不被新规则门拦住。对话读取、只读聊天或仅取消旧任务等不作新时间归一的操作不因规则坏包被统一拒绝。同键同请求重放已存终结帧不需要新归一，不造新 run；同键异体/原 run 仍执行仍为既有409，不能借故障重执行。

D7 兼容要求：`scripts/ci/compose-smoke.sh` 保留两轮全新卷，缺版本503含 TZDB_UNAVAILABLE，显式 `fixture-v1` 且 DB 可达时200，healthz200及未认证业务401。

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

| 错误码                           | HTTP | 对外话                                  |
| -------------------------------- | ---- | --------------------------------------- |
| NONEXISTENT_LOCAL_TIME           | 422  | 当地并不存在，请重定                    |
| AMBIGUOUS_LOCAL_TIME（带两候选） | 422  | 出现了两次，请选第一次/第二次（含偏移） |
| UNKNOWN_TIMEZONE                 | 422  | 请给规范时区或重选                      |
| TZDB_UNAVAILABLE                 | 503  | 时间规则不可用，暂不开张（readyz 同码） |

## 9. A4 端到端失败与选择 [Required · #30]

### 9.1 失败不是成功澄清

Required：安全 spec Scenario 1.2 的 typed `thread.failed` 是验收真源。信息缺失（年份/时区/时段）、模糊范围仍按 §2 返回澄清文本，不建 approval，允许 `thread.completed`；已经判定的不存在/重复未选/未知时区不能被降为这类普通澄清。给出“请重定/请选择”话术不等于 run 成功。

Required：SSE 已建立则外层始终 HTTP200；`payload.error.code` 使用既有符号名，`http_status` 为前三错422、`TZDB_UNAVAILABLE`503。可以先有解释 delta，但每个 run 只能落一个终结帧；typed失败后不再发 completed/cancelled/approval_required/card.proposed。回放同一事件序列，不因断连或失败审计写入异常再追加第二终结。

`AMBIGUOUS_LOCAL_TIME` 的 `error.details` 使用以下合同结构，专用 schema 约束此结构；其余外层事件字段不变。schema 实施和运行验证另行留证：

```json
{
  "wall_time": "2026-11-01T01:30:00",
  "timezone_id": "America/New_York",
  "ruleset_id": "FIXTURE_V1",
  "candidates": [
    { "fold_choice": "first", "offset_seconds": -14400, "fire_at_utc": "2026-11-01T05:30:00Z" },
    { "fold_choice": "second", "offset_seconds": -18000, "fire_at_utc": "2026-11-01T06:30:00Z" }
  ]
}
```

候选恰好两个，按 UTC 从早到晚对应 first/second；不得只有中文、时区缩写、缺偏移或由客户端合成。`fold_choice` 是请求枚举，不是输出 `fold`；first→0、second→1（仅重复时刻），非重复成功仍 fold=0。原话“第一次/第二次”不覆盖结构化 `fold_choice`，未提供字段按 none；有相互冲突的自由文字选择则问清而不偷偷另选，不能让 Web 猜词提交。

“不存不排/零业务写”在这里精确定义为失败不创建或改写 approval、task、task_events、outbox、notification，不调用发送 provider。允许既有 conversation/message/agent_runs/run_attempts/run_checkpoints/tool_calls 失败审计；它们不是承诺。规则预检拒绝比这更严格：上述新 run 等写入也为零。时间校验和范围校验必须在创建 approval 之前完成，不能先建 pending 再发 failed 当作回滚。

### 9.2 显式时区优先级与 Web 再提交

Required：保留既有请求兼容字段的实际优先级：`confirmed_timezone_id ?? confirmed_timezone` 是请求已确认值（schema 两字段均已有），不新增 `timezone` 字段。解析优先处理原文中显式时间时区指示：**一个已知别名/规范 ID 高于请求已确认值；本次请求已确认值高于会话原冻结默认值；仍无值才是缺时区澄清**。会话默认只提供先前明确时区，不提供新请求日期锚；可信整条时区补充按 §3 绑定原请求。这不改旧 approval/task、用户 profile 或会话历史字段。重复的同义别名去重；多个不同的显式有效时区则澄清，不按表遍历顺序选首项。

未知显式时区（如“火星时间”或未知规范 ID）无论是否已有 Shanghai、是否同时出现已知别名，都必须 `UNKNOWN_TIMEZONE`；不能无视它回落 confirmed timezone。无显式原文指示而请求确认值未知也失败；缺表/别名映射目标丢失按 §5.2 的服务错误，不混为用户错误。普通缺信息/范围词仍澄清，但不得以此静默接受未知指示。

Web 在 failed422 AMBIGUOUS 后保存原输入、失败 `run_id`、服务端明确的 wall_time/timezone_id 和两个候选，显示“第一次/第二次 + 数值偏移”操作。点击只是以 `fold_choice=first|second`、`clarification_of_run_id=原失败Run` 和新幂等键发起**新请求**重提议，不是 confirm，不直接建 task；原文必须完全相同，所选规范时区必须等于实际候选（不得拿 `/me` Shanghai 覆盖纽约）。服务端仍核验 §3 的唯一未完成来源及紧邻关系后才继承原锚；不能把带回的“明天”按点击时刻重算。若输入/日期/时区改动，应清除旧候选及来源引用，作为完整新请求重新校验，不能套用旧 fold。

客户端只展示服务端候选/偏移，不用 Date/Intl/UTC 算术生成目标；服务端再归一，不信客户端提交的候选 UTC。既有API不接受客户端 `fire_at_utc` 作为排期输入。成功后才显示新的 pending 回显及按钮确认门，仍验 hash/seen_content/有效期；失败时不能留上一项的确认入口造成误确认。

## 10. 回归与实际取证边界 [Required · #30]

- 保留有效的 time-core golden/DST/reverse-clock 与表达入口回归，只更新受影响断言。新增规则完整性/范围/alias、HTTP preflight、HTTP200 failed422/503、PG零承诺、回放唯一终结和 Web 双选择回归；mock坏规则仅证明分支，不是部署演练。
- 每 zone 覆盖本地 `2025-12-31T23:59:59`拒绝、`2026-01-01T00:00:00`包含、`2027-12-31T23:59:59`包含、`2028-01-01T00:00:00`拒绝，核对各自 UTC 边缘与锚点边界；相对次日跨上界拒绝。纽约四次转换各测转换前一秒/瞬间/后一秒，春季整段 gap 与秋季双候选/fold 映射均保留。
- 在独占真实部署装载源分别制造缺version、缺/坏规则、缺alias、标识内容不匹配，再重启同一生产装载链；记录源码/镜像、实际输入来源及变更、readyz与请求HTTP/SSE、request/run关联、SQL前后差异和恢复。静态打包资源若无可移除来源，须在实施中提供最小真实装载边界或受控移除实际构建资源，不能只注入测试对象声称真实缺规则，也不为此做通用故障平台。
- 真实规则坏包场景先冻结有效旧 task，故障期间证明详情/取消或自然到点仍走冻结结果，无重算/新承诺；DB断开单独证明readyz503且healthz200，不宣称DB坏时业务还能读写。复用不受影响的既有取消/通知证据，不重开#26。
- A4未来绝对DST输入可立即验归一，不需等DST日；已过的黄金日期只作计算/错误回归，不能确认过期approval伪造生产通过。真实first/second确认须选择规则覆盖内仍未来的目标。D1/D2/D7/D8/D10及五门保留；实施验收记录与规范归档分别取证。
