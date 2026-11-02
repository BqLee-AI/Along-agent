# 01 助理 Agent 总览

| 状态     | 范围                                             | 不包含                                                              | 阶段标签                                         |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------ |
| Proposed | 助理 Agent 职责/非职责、对话→提议→确认链、不变量 | 工具参数明细（见 02）、简报生成细节（见 03）、运行时状态机（见 05） | v0：单一 `assistant`；P1 起多 Agent 线性协同远期 |

## 定位

> 作用域：本篇“只提议/必须approval/缺时区必问”仅描述现行/legacy。新profile中，模型理解本人委托并自主选择正常步骤，TS仍独占时间计算/业务提交/事实；严格elapsed无需无关时区，见 [design/20 §1–§4、§6](../design/20-goal-scoped-delegation.md)（Proposed）。本次不改运行行为或将模型语义当确定证明。

[Required] Along 助理 Agent 是用户在线对话的唯一推理编排者。它负责理解用户意图、调用白名单工具取数、产出提议（proposal）与澄清问句；它不负责确定时间、不负责落盘承诺、不负责触达用户。

```text
POST /conversations/messages (SSE)
  -> 分诊（见 04：提醒路 / Agent 路 / 混合澄清）
  -> assistant tool-loop（本篇）
      -> 只读工具（见 02）
      -> propose_task / request_cancel_task（只产 approval，不建 task）
  -> 回复 + proposal 卡 / 澄清问句
  -> 用户确认（见 04，确认门）
  -> Scheduler / Notifier（Agent 不再参与）
```

[Observed] business 是无模型的确定性业务；harness 明确进入正式仓颉核心，经 TS 纯模型 transport 和可信工具/批准边界。受控 transport 证明接入而非真实 provider/模型质量或完整 R1（design/09/11）；外部产品/AF 不作实现证据。

## 职责（做）

- [Required] 接收 `AgentRunRequest`（conversation 上下文 + allowlist + 双预算，见 05），跑受限 tool-loop：思考 → 调工具 → 观察 → 再思考，直到产出 `answer` 或 `proposal` 或 `clarify`。
- [Required] 提醒意图只走提议：调用 `propose_task` 产出 approval 待确认，不直接创建 task、不排期（B06 总闸 1）。
- [Required] 取消意图只走提议：调用 `request_cancel_task` 产出 approval（cancel_pending），不直接改 task 状态。
- [Required] 查询/解释意图走只读工具（`list_tasks` / `read_brief_cards` / `get_user_prefs`），结果拼入回复并给出引用来源。
- [Required] 每轮产出审计友好的阶段摘要：调用了哪些工具、传了什么（脱敏后）、为什么停、预算剩多少。完整 chain-of-thought、完整 prompt、provider raw response 不落盘。
- [Required] 时间表达只做"原样转交+澄清"：把用户原话 `raw_time_text` 与 `timezone_hint` 原样递给 `propose_task`，由服务端 time-core 归一（design/09）。LLM 不计算、不换算、不补默认。

## 非职责（不做）

- [Required] 不算时间：不推导 `fire_at_utc`，不换算时区，不补年份/时段默认值，不解释 fold/offset。凡需选定日期、时区、时段的决定必须问用户（B06 §3.3 分界尺）。
- [Required] 不直写库：不直连 Postgres 业务表；需要上下文由调用方传入，需要记忆/知识走记忆服务接口（P1 起，v0 仅会话上下文）。
- [Required] 不直调连接器：不直接调外部 MCP Server / 日历 / 邮件；统一经 ToolGateway（见 02）。v0 无真实外部连接器。
- [Required] 不绕 approvals：敏感副作用（建 task、取消 task）必须经 approval 确认门；分诊只是路由建议，不是授权（B06 §8）。
- [Required] 不做排期与触达：不调 Scheduler/Notifier，不知道"是否已响"；对外口径只说已记录步骤，不承诺必达。
- [Required] 不读客户端时钟定案：`client_sent_at` 仅诊断；"明天"锚=服务端首次接收时刻+已确认时区并冻结（B06 §3.5）。

## 对话→提议→确认链（v0）

[Required] 唯一承诺路径：

```text
用户消息
  -> 分诊（04）
  -> assistant 答复（含 proposal A-XXXX 回显 + presentation_hash 绑定内容；S0 #14 冻结：v0 只认点确认按钮，整句文本只做展示，旧 `C-XXXX` 短号作废统一 `A-`）
  -> 用户点确认按钮（“好/嗯/行”与整句文本均不算；S0 #14 冻结）
  -> POST /approvals/{id}/actions/confirm（事务：验 owner + 验 pending + 验 now<expires_at + hash 对比）
      -> 成功：approval consumed + 创建 task/created/outbox，或同事务调用 tasks 公共取消用例
      -> 失败：PRESENTATION_MISMATCH / APPROVAL_EXPIRED(410) / APPROVAL_SUPERSEDED，按 04 话术回澄清
  -> task 进入 saved→pending_schedule→scheduled（凭 Scheduler 登记回执，见 design 真源）
```

- [Required] 回显有效 24h；改字段重回显，旧键作废（superseded）；两条待确认并存时无指向确认直接挡回（S0 #14 冻结：v0 无文本意图消歧，按钮自带 approval_id）。
- [Required] 连点两次只回同一个 task："这是重复确认，没有新建第二条。"（幂等键+request_id 去重）。
- [Proposed] 展示层只读 C 冻结字段固定格式呈现；模板带 `presentation_version`，旧 C 用旧模板直到过期（B06 §5）。

## 设计原则

- [Required] ID-first 用于资源/身份关联，公开用例允许显式 DTO 与只读投影；五缝不是所有跨模块调用唯一入口，可靠异步命令走 outbox（design/02/04）。
- [Required] 最小工具集：每次 run 限定 allowlist 子集，默认最小集；敏感工具 `requires_approval=true` 直接产 approval 事件，不存在"先执行后补确认"。
- [Required] 预算先行：仓颉强制累计迭代/可得 usage，TS 冻结配置与资格；缺 usage 保留未知，不字符估算、不保证不可证明的费用（05）。
- [Deferred] 多 Agent（规划者→执行者→检查者）、`@execution` 自定义 plan、沙箱、Skills 市场均 P1 后远期，本篇不展开。

## 与 design/04/09 的一致性

- 本篇"不算时间/不直写库/不直调连接器"对应 design/04（AgentRuntime+ToolGateway 边界）与 design/09（time-core 确定性层）。
- `normalize(wall_time, timezone_id, fold_choice, ruleset)` 为服务端纯函数唯一权威；LLM 输入输出均不含 `fire_at_utc`。
- 仓颉唯一 Harness，TS 长期能力/业务/存储；有限批准等待同 Run 显式恢复不等于任意崩溃自动恢复，GET 补读不执行，unknown 不盲重放；完整 R1 另行取证（design/09/11）。
