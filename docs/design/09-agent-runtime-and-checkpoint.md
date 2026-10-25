# 09. AgentRuntime 与 Checkpoint 设计

## 文档状态

- **状态**：Harness 与 TS 可信运行合同；design 为字段与责任真源，PRD 跟随
- **范围**：确定性业务、正式仓颉核心、工具调用、有限批准等待恢复与事件投影
- **不包含**：实际供应商选型、完整 R1、任意崩溃无人值守恢复或通用 external exactly-once
- **阶段标签**：业务与 Harness 明确分派；跨语言 CI 证明范围见 design/11 §4

## 标记约定

Observed / Required / Proposed / Deferred 同 01；运行记录只写进对应验收记录或 PR，不混作长期能力保证。

## 1. Harness 与 TS 的唯一责任

- [Required] 仓颉唯一拥有模型/工具循环、本次上下文、工具观察、行动选择、迭代/usage 计数、等待/继续/停止。正式源为 `apps/harness`，不是固定动作回放器；TS 不保留第二套通用 Agent。
- [Required] TS 长期保留身份/权限、ToolGateway、批准/time-core/tasks/scheduler/notifier/outbox/worker、API/Web 与 Run/checkpoint/结果/事件持久化。memory/grep、MCP、办公和 PC/browser 属于 TS 能力边界，不在仓颉内重建后端。
- [Required] `execution=business` 是原有确定性业务；省略兼容该路径。`execution=harness` 明确进入仓颉且本阶段 `mode=chat`，不借 `chat/task` 隐式选择执行器，不因失败改走业务/fixture。
- [Required] TS 从 session/Actor 接受 Run，冻结 revision、工具范围、输入与时间规则。每个进程绑定一个有效 attempt；每次动作重新核验 owner、当前权限、Run/attempt 与取消状态。用户停用或明确撤权拒绝新动作；普通 session 轮换不自行取消已接受 Run，操作入口仍需当前认证/CSRF。

### 不信任三原则（Required）

1. 用户原话按不可信输入解析，工具参数在 TS 通过每工具 strict zod schema 重验。
2. 模型输出不确定时间、批准或业务事实；时间由 time-core，承诺只经冻结按钮确认。
3. pipe 只传建议和引用，不接收 owner、allowlist、数据库身份或自选执行资格；内部 `ToolContext` 不作为远程 DTO。

## 2. 接口语义与正式传输

HTTP 消息、Run 读/取消/恢复路由见 [conversations API](../api/conversations/conversations_routes.md)。TS adapter 与同容器固定 native 产物通过 `harness/v1` UTF-8 NDJSON 双向交互，`shell=false`，子进程仅得到必要 locale/运行库配置，不继承 DB/auth/cookie/model key。

- TS→native：`start/reply/cancel`；native→TS：`model/reserve/invoke/snapshot/suspend/answer/finish`。
- 具体 strict schema 与公开 Run DTO 的唯一类型源为 [contracts/harness.ts](../../packages/contracts/src/harness.ts)。两端拒绝未知字段、版本、畸形 UTF-8/JSON、残缺 EOF 与超过 1MiB 的累计帧；发送前也检查字节大小，不静默截断上下文。
- `request_ref/reply_to` 仅关联当前 pipe，不能替代持久身份；一个请求等待 ack 后再继续。snapshot/suspend/finish 的 ack 必须在 TS 对应事实提交后返回。
- TS model transport 仅使用服务端固定的 OpenAI-compatible chat-completions 配置做 HTTP/协议转换；仓颉构造上下文并解析提议、选择工具与决定下一轮。未配置时新 harness Run 在任何写入/SSE 之前返回 `503 HARNESS_UNAVAILABLE`，不启用测试 transport。
- 每模型轮最多一个工具提议；并行提议明确拒绝而非只取第一项。运行说明、固定工具链和分发 notices 见 [harness README](../../apps/harness/README.md)。
- 仓颉强制累计迭代预算；可得 usage 累计，缺失永久保留未知，不字符估算、不编造费用。超预算后不安排后续模型/工具，保留已发生事实并失败；无法证明的 token/费用上限不作保证。

## 3. 事件词汇与内部快照

对外只使用 `packages/stream-protocol` 的七词：`thread.started/message.delta/card.proposed/approval_required/thread.completed/thread.failed/thread.cancelled`。内部快照不是新 SSE 事件，不把内部词交给 `ThreadEventSchema`。

- `harness_snapshot` 复用只追加 `run_checkpoints`，内容为版本、受控消息/工具结果引用、`next_call_no`、累计 usage 与批准等待引用；不存密钥、完整推理链、原始 provider body 或工具参数副本。
- TS 核对消息属于已接受 Run 输入、工具引用属于同 owner/conversation/Run 且已有接受结果；计数与 call_no 不倒退。快照不能提升权限。
- 批准当前决议另由 approvals 公共只读 DTO 取得；不能把不可变的原 `approval` 接受结果当成当前已确认状态。

## 4. Run / attempt 与原子裁决

```text
Run:     running → suspended_approval → running → done | failed | cancelled
attempt: running → done | failed | fenced_out
```

- 挂起结束该 attempt，不终结 Run；显式恢复分配递增新 attempt。同等待 checkpoint 唯一有效恢复，旧 pipe 不重新获得执行权。
- 写者采用 `attempt → Run → invocation` 锁序，锁内验证最新 attempt、预期状态与引用。cancel 遇到 resume 改变当前 attempt 时重新定位，不重做工具效果。
- finish 将已接受助手 delta 合并的消息、唯一终态 checkpoint、attempt 与 Run 同事务提交；错误全回滚。没有助手输出的结构化失败只存终态事件，不由 TS 合成助手回合。保留已接受工具事实，未完成/unknown/failed 或未决批准不能伪装 done。
- cancel 先原子提交 cancelled、撤销执行资格和唯一取消事件，再通知/终止进程并 abort 模型 HTTP。工具先提交则事实保留，取消先提交则拒绝新动作。Run 取消不撤销独立按钮确认已建任务，也不篡改批准决定。
- 模型/pipe 等待不持 DB 事务。进程/协议失败脱敏为 `HARNESS_EXITED/HARNESS_PROTOCOL_ERROR`，不得覆盖已经提交的取消、挂起或终态。

## 5. ToolGateway 交互（Required）

- 工具范围为 Run 冻结产品策略与当前授权的交集；allowlist 外调用 `TOOL_DENIED`，执行资格拒绝遵循工具绑定合同。
- 先独立持久预约 `invocation_id`，再执行。native 单调分配 `harness/N` slot，恢复沿原引用与已用计数；hash/provider call id/request/attempt 不替代动作身份。同参数新动作才分配新 slot。
- `tool_invocations` 是身份/冻结上下文/接受结果事实源，`tool_calls` 只追加提交审计。本地批准、接受结果及审计同一 client 事务；原冻结结果不可变，当前权限可遮蔽但不能删除事实。
- tasks 的候选/列表、brief 的卡片投影、identity 的偏好通过各自公共 query-client 用例读取，保留原字段、过滤、排序、limit 与 caller 事务。不在 gateway 查询其他模块私表。
- 已接受结果只读回，不再执行；reserved 按原身份重交，本地事务回滚不产生脱节批准。非事务 unknown 只能核对或停下，不盲重发。完整规则见 design/04 §3、agent/02 与调用 schema。

## 6. 事件补读、有限等待恢复与效果恢复

- GET `after_seq` 与同入站幂等键只补读已存外部帧，绝不分配 attempt、启动 native、归一或调用工具。running 同键仍409，suspended 可读已存前缀；同 owner/key 换 execution 冲突，不另开幂等空间。历史 business 的 hash 材料保持兼容，harness 使用独立版本域。
- native 取得真实批准提议后先存有限快照，再 suspend；TS 核对同 Run 接受调用/批准，原子保存等待引用并 ack。该段流没有 completed；正常挂起结束流不触发取消。
- 用户确认可早于 suspend。恢复读取真实决议：pending 拒绝继续；consumed 交付真实 task ID；rejected/expired/superseded 立即停止原动作，不跟 successor 或同义绕拒绝。consumed 后正常循环仍受原预算与每个新动作各自批准约束。
- 只允许最后有效批准等待 checkpoint 的显式恢复。同键丢回答可定位原新 attempt，同点换键不多启动；不重放旧 started/delta，不重做原 invocation。
- 浏览器运行中真实断连请求持久取消，Next 代理转发实际 abort；Web 的显式停止更可靠。刷新仅查询/补读，批准处理后回原 Run 明确继续，不重新提交确认来重试恢复。
- [Deferred] 自动重启、任意 checkpoint、无人值守崩溃恢复仍需独立工具/授权/并发证据；lease 字段、checkpoint 与取消 fencing 都不保证通用 external exactly-once。design/08 的通知专属一次许可/回执证据不泛化到仓颉/文件/MCP。

## 7. 不可变 revision（Required，对标 a13n）

- Agent、prompt、skill 的已发布 revision 不可变，新版递增，不原位改旧定义。
- 每个 Run 冻结实际 agent revision、presentation/time 规则版本及工具范围；续跑不能升级。支持范围外的旧时间规则不可用时类型化拒绝，不偷偷用新规则重算。
- revision 冻结只证明选择与解释边界，不单独证明供应商、模型质量、成本或完整 R1 验收。

## 8. 流投影（SSE，Required；WS 延后）

- 在线消息与显式 resume 使用既有 SSE 版本/schema，事件落库再投影；持久 assistant 与终态原子一致。合法长回答按每帧最多4000个 UTF-16 code units 分块，不拆开代理对；拼接保持原文本，不扩大七词 schema。
- `event_seq` 是不透明全局游标。内部快照造成间隙合法；同 conversation 对外追加序列化分配和提交，避免小游标晚提交被 GET 永久漏读。游标锁采用与外键 KEY SHARE 兼容的 NO KEY UPDATE，避免并发终态消息写者升级锁死锁。
- WS/ws-ticket、Web Push/其他推送按原阶段与 Deferred 决策，不因 native 接入自动扩展。

## 引用

- B02§2/B04/AF§4–§7、B06§8 仅作机制参考，不复制外部产物。
- [11 工具链与分工](11-cangjie-runtime-spike.md)、[API](../api/conversations/conversations_routes.md)、[存储](../schema/conversation-and-runs-schema.md)、[ADR0009](../adr/0009-cangjie-harness-ts-capabilities.md)。
