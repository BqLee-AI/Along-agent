# 01 产品概览与范围

> 状态：草案 / 范围：产品定位、用户、P0–P5 范围切片、非目标、差异化 / 不包含：路由表与字段定义（见 api/schema）、Spike 细节（见 agent/04）/ 阶段：P0–P5

> 授权作用域：下文 v0“点头/确认唯一入口”仅约束现行和 legacy profile。新目标合同见 [design/20](../design/20-goal-scoped-delegation.md)（Proposed）：本人委托内自主正常步骤，只问实质缺口或新增影响；本规范不启用权限。

## 产品定位

- [Required] Along-agent 是云端多租户 SaaS：Web 先行，后用 Electron 套同一份 Next.js。
- [Required] 服务端为 TS 模块化单体：一个镜像，三种角色 api|worker|all；Postgres 唯一事实源；Redis 延后。
- [Required] 终态产品形态：长久记忆 + 提前行动 + 落地执行 + 任务卡（B01）；架构思想：harness 可替换、checkpoint 可恢复、自托管（B01）；
- [Proposed] v0 只验证"说清一件事和一个时间 → 服务端算出唯一触发瞬间 → 用户点头 → 到点私下响一次"的最小确定性闭环（B06 §1）。

## 目标用户（v0）

- [Proposed] 单人 Web 用户：用自然语言立一次提醒，到点收到应用内通知，事后可在活动页核对。
- [Deferred] 多成员协作、组织管理、计费分级：目标市场未定，租户隔离按多租户 SaaS 预留，v0 只跑通单租户行为。

## 范围：P0–P5

- [Required] P0 前置决策：Better Auth 自建 vs OIDC 二选一拍板；目标市场与计费方向的最小假设；技术栈冻结（Web 框架、LLM 供应商起步选择）。P0 不定，schema/05 与 api 鉴权章节不得冻结。
- [Required] v0 保留八步 Web 闭环、time-core、确认门和只追加事件。五缝是主要能力边界，不强制全模块接口空壳或远程化（design/02/04）。
- [Proposed] 旧 P2 实时增强（WS 等）仍是独立后续能力，不作为仓颉候选第二实现竞赛阶段。
- [Required] R1 起仓颉唯一 Harness，负责模型/工具循环、本次上下文、计划、预算、等待/恢复/停止；TS 长期保留 ToolGateway/tools/memory/grep/MCP/PC/browser/办公、身份/批准/时间/任务/worker、API/Web/Run 存储。R1 未实现；旧 P3 转正定位停止适用（design/09/11）。
- [Deferred] P4 Electron 套壳：套同一份 Next.js；v0 不做任何客户端常驻逻辑。
- [Deferred] P5 规模化：K8s、计费、推送渠道扩展；以 P1 可测指标为准另行立项。

## 差异化三点（全落 P1）

- [Required · legacy] 确认门保护旧批准路径的所见/hash/时限，不以“好/嗯/行”消费 pending。[Proposed · 新 profile] 目标内自主执行本人设置、明确提醒创建/取消与受管资料创建/修改，不把所有写入变成逐项审批；模型不直接排期/通知，仍走领域事务与真实回执。
- [Required] 服务端确定性时间层：time-core 纯函数 normalize(wall_time,timezone_id,fold_choice,ruleset)→{fire_at_utc,offset,fold,ruleset_id}；LLM 只产出自然语言方案，不算时间。
- [Required] 只追加事件账 + 可解释主动行为：task_events type / evidence_ref 可核对；未观测到的能力不作承诺引用，以自家可测指标为准。

## 非目标（v0 明确不做）

- [Required] 不做本机提醒器：06 喝水提醒降级为调度子用例（task.kind=notify_only），不走 LLM 先验调度 + time-core 归一之外的任何本机钟表逻辑。
- [Required] v0 只做 13 个业务端点 + 2 探针（含显式修改 pending approval）；工具侧 v0 仅 ToolGateway 白名单 + zod 校验 + Fake 实现。
- [Required] v0 不做 RAG、沙箱、多 Agent：知识库检索、代码执行隔离、多智能体协同全部进 v1 盒子（B06 §11）。
- [Required] v0 不做重复任务、日历忙闲授权、条件触发、跨路数据冻结；改期用"取消旧 + 建新"（recreated_from 指回旧 task，唯一约束，不继承确认）。
- [Required] v0 不做 D/网关投递对账、巡检、独立审计库：只靠 Postgres 本库 + 用户打开应用时对账发现（诚实口径见 03）。
- [Deferred] Web 框架选型、推送供应商、LLM 供应商、计费模型：见 04 Deferred 清单，正文不得假设。

## 成功标准（v0）

- 用户说清一件事和一个时间，服务端给出唯一触发瞬间，用户一次点头，到点私下响一次；任何一步没把握就停下来说明白，绝不报成功。
- 取消已提交后触发请求数 = 0；超 15 分钟只标 missed 不补发；重复确认只回同一 task。
- "明天"按服务端首次接收时刻 + 已确认时区解析一次并冻结；DST 不存在时刻拒收、歧义时刻追问两候选。

### 本人委托助理的成功标准（Proposed，#104/#105）

- 一次混合委托可检索资料、保存真实简报文件、创建明确提醒并核实结果；用户不需指定工具、抄内部 ID 或逐步批准。明确重写/取消不重复索同一授权。
- 时间、对象、目的位置确有影响结果的缺口才问；资料可提供事实不能自己授权。只摘要不执行嵌入指令，按资料建提醒又可合法完成。
- 严格 elapsed 从可信 UTC 锚计算，无关时区/时段不问；completed/partial/blocked/unknown 与实际任务/文件效果分开，语义误判不宣称消除。
- 资源有界、显式停止和真实结果可核对；新 profile 才有新能力，旧 pending/快照/冻结展示不迁写或自动消费。实施验收见 [PRD 04](04-acceptance-open-questions.md#本人目标内委托105proposed)。

## 术语（本目录内）

| 术语            | 说明                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| 简报 / 卡片     | /brief 聚合视图与其条目呈现；卡片只读 presentation 冻结字段                       |
| 提议 / 确认门   | Agent 产出待确认方案；approval confirm/reject 为唯一放行点                        |
| task / approval | 调度任务与其确认单；状态机见 prd/README Required 列表                             |
| 活动账          | task_events 只追加账本的面向用户投影                                              |
| 五缝            | AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault 五个模块缝合面 |
