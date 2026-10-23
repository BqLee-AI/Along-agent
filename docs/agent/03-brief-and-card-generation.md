# 03 简报与卡片生成

| 状态                                                                                                                                               | 范围                                                                 | 不包含                                                | 阶段标签                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Deferred（P1 后；S0 #14 冻结：v0 简报为确定性组装，只读 tasks/approvals 投影，不跑 LLM、不落 `briefs` 表；本篇 LLM 路径延 P1，不作为 v0 开工依据） | 每日系统调度触发、上下文组装、Brief/Card 输出 schema、校验降级、预算 | 简报 UI 排版、RAG/记忆画像（P1 起）、多卡片交互状态机 | P1 后：LLM 简报生成；v0 只做确定性组装（见 `docs/api/brief/brief_routes.md`） |

## 触发（谁、何时、幂等）

- [Required] 每日系统调度触发：Scheduler 按用户已确认时区本地 `06:30` 生成当日简报任务（B06 降级说明：06 喝水提醒为调度子用例 `task.kind=notify_only`，不走 LLM 先验调度+time-core——本篇简报生成同样不走用户 time-core，由 Scheduler 确定性时刻触发）。
- [Required] 触发幂等：`(user_id, brief_date)` 唯一；Scheduler 调度键 `brief:{user_id}:{YYYY-MM-DD}`，重复触发直接返回既有 `brief_id`，不重跑 LLM。
- [Required] 时区缺失降级：`get_user_prefs.timezone_id=null` 时不生成简报，记 `BRIEF_SKIPPED_NO_TZ`，不猜时区、不沿用设备时区。
- [Proposed] 手动重刷：`GET /brief?date=` 只读既有；重生成需显式 POST（P1 起），v0 不提供用户侧重跑入口。

## 上下文组装（ID-first，进 LLM 前冻结）

[Required] 简报 run 的上下文由服务端组装，字段冻结后一次性注入，LLM 只读：

| 字段                | 来源          | 说明                                                                         |
| ------------------- | ------------- | ---------------------------------------------------------------------------- |
| `user_id`           | 运行时注入    | 分区键                                                                       |
| `brief_date`        | Scheduler     | 用户时区本地日 YYYY-MM-DD + `timezone_id` 冻结                               |
| `prefs_snapshot`    | user_prefs 行 | timezone/alias_version/locale/quiet_hours 快照                               |
| `tasks_snapshot`    | tasks 表      | 当日 `scheduled/fired/missed` 行 id+note_preview+本地文本，不含 UTC 内部字段 |
| `yesterday_outcome` | task_events   | 昨日 fired/missed 计数，不含原话全文                                         |
| `greeting_line`     | 规则模板      | 按时段固定问候，不由 LLM 自由发挥开头                                        |

- [Required] 跨路数据冻结：简报生成时刻对 tasks 快照；生成后新增的 task 不补进当日简报（v0；跨路冻结见 B06 §1 不做清单）。
- [Deferred] 记忆画像、RAG 文档、外部日历忙闲均不在 v0 上下文内。

## 输出 schema（Brief/Card，字段 describe）

[Required] LLM 输出唯一合法形状（zod 校验，见下节）：

Brief：

| 字段          | 类型         | 说明                                          |
| ------------- | ------------ | --------------------------------------------- |
| `brief_date`  | string       | YYYY-MM-DD，与触发键一致，不一致即拒          |
| `timezone_id` | string       | IANA，与 prefs 快照一致                       |
| `headline`    | string ≤60字 | 当日一句话，不承诺准时/必达                   |
| `cards`       | Card[0–10]   | 卡片数组；空数组合法（无事项日只留 headline） |

Card：

| 字段                   | 类型                                                  | 说明                                                            |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `kind`                 | enum(reminder_summary, overdue_followup, day_preview) | v0 仅三种；`notify_only` 喝水卡为 day_preview 子类，不单列 kind |
| `title`                | string ≤30字                                          | 只用快照内词语，不编新事项                                      |
| `body_text`            | string ≤200字                                         | 只陈述已记录步骤（已排期/已错过/可重约口），不承诺必达          |
| `task_id`              | string\|null                                          | 关联 task；无关联即 null，不编 id                               |
| `source_refs`          | string[]                                              | 引用的快照行 id 列表；空即无依据                                |
| `presentation_version` | string                                                | 卡片模板版本，随输出冻结                                        |

- [Required] 展示层只读上述冻结字段固定格式呈现，不换算时间、不改写 body。
- [Required] 口径天花板：`missed` 卡只说"已错过（给重约口）"；`fired` 卡只说"已记录触发"，不声称用户已读（B06 §9–10）。

## 校验降级（zod 不过时怎么办）

[Required] 网关/运行时对 LLM 输出做 zod 全量校验，不过即降级，不重试 LLM 超 1 次：

| 情形                                | 处理                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 字段缺失/类型错/`brief_date` 对不上 | 整份丢弃，记 `BRIEF_INVALID_SCHEMA`，当日简报标 `degraded`，前端只展示 tasks 快照直排（规则 fallback），不展示 LLM headline |
| `task_id` 引用快照外 id / 编造事项  | 剔除该卡（记 `CARD_DROPPED_UNKNOWN_REF`），其余卡保留                                                                       |
| 超 10 卡 / 单卡超字数               | 截断至 10 卡/截断文本并标 `truncated=true`，不重跑                                                                          |
| 空 cards                            | 合法，不降级                                                                                                                |

- [Required] 降级可观测：`briefs.status ∈ {ok, degraded, skipped}` + `degrade_reason`；degraded 当日不再自动重跑。
- [Required] 预算耗尽（见下）同样进 `degraded`，不等 LLM 补尾。

## 预算（简报 run 独立预算）

- [Required] 简报 run 与对话 run 预算隔离：`brief_budget={max_tokens: 2000, max_cards: 10, max_tool_calls: 0}`——简报 LLM 无工具调用（上下文已冻结注入），`max_tool_calls=0` 恒定。
- [Required] 模型生成预算由仓颉 Harness 强制，TS 负责卡片 schema/投影与存储，不内藏第二模型循环（见 05）。v0 简报实际是确定性只读投影；此处模型预算是后续目标，不是已实现 provider usage。
- [Proposed] 实验起步值：2000 tokens 为待校准值（与 24h/15min/1min/30s/3退避同为云端待校准实验起步，以自家可测指标为准）。

## 与 design/04/09 的一致性

- 触发与幂等归 Scheduler（design 真源），本篇只定简报侧键与快照边界。
- 时间语义归 time-core/design-09：简报内时间文本只复述 tasks 快照冻结本地文本，不重新归一。
