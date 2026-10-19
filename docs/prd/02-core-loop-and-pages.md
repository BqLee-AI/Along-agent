# 02 核心循环与页面

> 状态：草案 / 范围：v0 八步闭环、两个场景、五视图与活动页的产品定义 / 不包含：字段级定义（见 schema）、路由参数（见 api）、流事件名（见 stream/01）/ 阶段：P1（v0）

## 核心循环（八步）

- [Required] 1 简报：用户打开 Web，GET /brief 聚合今日 tasks 与待确认 approvals；无事则页面安静，只留记录入口。
- [Required] 2 卡片：每条简报条目为结构化卡片，只读 presentation 冻结字段做固定格式呈现，不换算、不推断、不改写。
- [Required] 3 对话：POST /conversations/messages 经 SSE 流式返回思考 / 工具调用 / 回复 / 待审批；预算超限（BUDGET_EXCEEDED）自动停并告知。
- [Required] 4 提议：Agent 产出待确认方案并冻结 presentation（含 presentation_version）；confirm 请求携带当时看到的完整内容 + presentation_hash，对不上即停（PRESENTATION_MISMATCH）。
- [Required] 5 确认：只有整句确认或点确认按钮算数；回显有效 24 小时（实验起步值，待校准）；两条待确认并存时无指向的确认直接挡回。
- [Required] 6 调度：Approval 消费 + 建 Task 同事务；收到 Scheduler 登记回执才标 scheduled，否则停在 pending_schedule。
- [Required] 7 触发与通知：到点先查三样（task 对得上、状态为 scheduled、登记凭据绑同一 task）；15 分钟内触发一次；超窗标 missed 不补发。
- [Required] 8 活动账：task_events 只追加投影，用户可核对每一步 type 与 evidence_ref（有凭据写号，无则写"服务端记录"）。

## 场景 A：喝水提醒（v0 第一条验收场景）

- [Required] 输入："明天 9:20 提醒我喝水。"（已确认时区；"明天" = 服务端首次接收时刻 + 已确认时区，解析一次即冻结，B06 §3.5）。
- [Required] 回显："2026-10-17 09:20（Asia/Shanghai）提醒你：喝水。"由已保存并校验的 approval 草稿生成；确认绑定这份草稿。
- [Required] 06 喝水提醒降级为调度子用例：task.kind=notify_only，不走 LLM 先验调度；time-core 仅做 wall_time → fire_at_utc 的确定性归一。
- [Required] 确认后才建单次 task 并排期；到点写触发记录、生成应用内通知；对外只报告系统记录到的状态，不声称用户已读。
- [Required] 归一失败回澄清；存摆、确认、排期、触发任一步失败都保持未完成并进可重试队列，绝不报成功。

## 场景 B：每日简报（聚合场景）

- [Proposed] 用户立多个单次任务后，次日打开简报页看到按 fire_at_utc 排序的今日条目：已排期待触发、待确认提议、昨日 missed（含一键重约入口）。
- [Required] 简报数据只从 tasks / approvals / task_events 聚合，不读、不猜任何记忆或外部状态；missed 条目不补发，只给重约口（新 task，recreated_from 指回旧 task）。
- 聚合形态参考外部产品，v0 按打开时实时聚合。

## v0 五视图（真源对象与必须展示字段）

| 视图 | 真源对象（Contract 表名） | 必须展示字段 | 非目标 |
| --- | --- | --- | --- |
| 简报视图 | tasks + approvals | 每条 fire_at_utc（本地呈现）、状态、待确认数 | 不展示 UTC/fold 内部码 |
| 卡片视图 | approvals | original_text、归一本地时间、timezone_id、过期倒计时 | 不换算、不改写冻结内容 |
| 对话视图 | agent_runs + run_attempts | SSE 流式正文、待审批提示、预算状态 | 不展示系统提示词与内部轨迹 |
| 确认视图 | approvals | 冻结方案全文、presentation_version、24h 有效期、常驻不承诺告知 | "好/嗯/行"快捷确认按钮 |
| 任务视图 | tasks | 状态、fire_at_utc、登记回执有无、取消入口 | 改期原地编辑（必须取消旧 + 建新） |

- [Required] 每个视图的主对象与真源表一一对应：tasks、approvals、task_events、agent_runs（含 run_attempts / run_checkpoints）、outbox；跨视图联动只传 id，不拼快照。
- [Required] 确认按钮上方常驻短告知："到点会在调度器成功运行时尝试通知；设备关机、休眠或进程未运行时可能错过，云端版以可测指标为准。"（口径天花板见 03）

## 活动页（事件账投影）

- [Required] 活动页逐行展示 task_events 的 type 与 evidence_ref：scheduled（含登记回执号）、fired、missed、cancelled、superseded；无外部凭据的行写"服务端记录"。
- [Required] missed 行必带一键重约入口：开新 task，recreated_from 指旧 task（唯一约束）；内容当候选、时间重给，不继承旧确认。
- [Required] cancelled 行展示后不再有任何触发行；取消提交（事务落 cancelled 才算）后排队重试全作废。
- [Required] 对不上账时活动页只说三种话：没记录到触发（原因不明）/ 已错过（给重约口）/ 对不上（暂停等维护者，不怪用户）。
- [Deferred] 独立审计库与巡检：v0 活动页只读本库 task_events；跨库对账进 v1。

## 状态机摘要（产品语义，字段见 schema）

- task：saved→pending_schedule→scheduled（回执）→fired|missed；saved/pending_schedule/scheduled→cancel_pending→cancelled。
- approval：pending→consumed|rejected|expired|superseded；过期顺路清（启动/读取/确认时），不另养后台进程。
- 触发门禁到点先查三样；查到一半变了就先拦、不重查放行，等重新确认。
