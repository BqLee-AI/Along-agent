# 02 核心循环与页面

> 状态：产品合同 / 范围：v0 八步闭环与 R1 蓝墨任务书桌的页面/恢复边界 / 不包含：字段级定义（见 schema）、路由合同（见 api）、版本化验收结论 / 技术设计真源：[design/01 §6](../design/01-tech-stack-and-repo-structure.md#6-r1-web蓝墨任务书桌与职责边界)

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

| 视图     | 真源对象（Contract 表名） | 必须展示字段                                                   | 非目标                            |
| -------- | ------------------------- | -------------------------------------------------------------- | --------------------------------- |
| 简报视图 | tasks + approvals         | 每条 fire_at_utc（本地呈现）、状态、待确认数                   | 不展示 UTC/fold 内部码            |
| 卡片视图 | approvals                 | original_text、归一本地时间、timezone_id、过期倒计时           | 不换算、不改写冻结内容            |
| 对话视图 | agent_runs + run_attempts | SSE 流式正文、待审批提示、预算状态                             | 不展示系统提示词与内部轨迹        |
| 确认视图 | approvals                 | 冻结方案全文、presentation_version、24h 有效期、常驻不承诺告知 | "好/嗯/行"快捷确认按钮            |
| 任务视图 | tasks                     | 状态、fire_at_utc、登记回执有无、取消入口                      | 改期原地编辑（必须取消旧 + 建新） |

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

## R1 蓝墨任务书桌

统一采用 shadcn/ui new-york、Radix primitives 与 Tailwind CSS v4；冷白纸面、蓝墨操作、深石墨正文。桌面侧栏与窄屏 Sheet 提供同一组资源目的地，账户在导航底部；正文采用页面阅读而非固定高度聊天内窗。完整内容与错误不依赖 toast 或颜色表达。组件源码与分层职责见设计真源，不要求简单只读页面新增 controller。

| 页面 / 入口                         | 用户可做什么                                                                         | 事实边界                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 今日 `/`                            | 看今日提醒与待确认摘要，选择创建提醒或处理资料                                       | 简报不是全量任务清单，不画推测完成率                                         |
| 对话 `/conversations`               | 明确选择新任务目标；按建立时间找会话、选择 Run、读原话/回复/修改与结果               | 提醒固定业务路径，资料固定 Harness；选择不执行，身份 query 优先于入口 intent |
| 文档批准 `/document-approvals/{id}` | 从原 Run 独立新标签审阅完整冻结版本并决议                                            | 无虚构文档批准集合；批准只授权，返回原 Run 后显式继续                        |
| 提醒确认 `/approvals` 及详情        | 读冻结提醒、确认/拒绝或显式修改，读真实任务/后继引用                                 | 不混入文档批准，不把修改当确认，不重算冻结时间                               |
| 提醒任务 `/tasks` 及详情            | 分页读取提醒状态、调度/取消回执与站内通知，明确取消                                  | 不冒充资料历史，不承诺通知必达或用户已读                                     |
| 活动 `/activity`                    | 分页读任务范围索引和所选任务事件                                                     | 两种范围各有游标，不是全局全量时间线或 Agent 审计                            |
| 账户与认证                          | `/account` 查看身份/本机边界；`/login`、`/setup`、`/claim`、`/logout` 完成对应窄操作 | 复用原 owner、Cookie/CSRF；只有核验空安装可建号，退出以服务端撤销为准        |

处理资料先显式选服务端真实登记，再填写目标；展示可读/可写相对范围和受管副本说明，不默认选第一项、不接收任意宿主 root、不因空登记或依赖错误切提醒路径。读取失败与没有登记分开；没有 writable_paths 不等于资料不可读。原 Run 冻结范围不可通过新任务选择改写。

文档校样页完整展示 before/after、完整目标、版本与 `preview.body`；确认直接提交原 `preview.body` 字符串，不从排版、diff、摘要重建或 trim。批准成功保留全文与授权事实，不自动写入或继续。approved/not_started 为已授权未保存；applied 不等于已核对；verified 依新全文读取证据；unknown 可能已写入，不盲重做。Run 终态与每项效果分开，`can_resume=false` 不等于尚未批准。

会话、Run、消息、事件、批准、任务的打开/分页/刷新/展开与重登恢复只 GET；局部失败保留成功内容和未推进游标，不自动补发消息、决议、继续或取消。批准独立标签不提前断开原流；主动流离开仍受断连取消合同约束，不能承诺后台继续或回滚文件。

只有真实受保护 HTTP 401 引导安全站内返回的重登；403 保留权限/CSRF 含义，404 不作空集合，网络/503 不一概称模型缺配置。账户状态未知不猜空安装，`pending_local_configuration` 不代表模型/资料就绪；原安装登记/重载由部署者经 `local:account` 完成，不换 owner/root/秘密。

本节描述产品行为与源码边界，不声明键盘、断点、真实模型或文件闭环已验收。受控 HTTP 页面观察不等于同一正式安装的 Web/API/native/MCP/PG/模型跨模块证据；后者须独立取得。
