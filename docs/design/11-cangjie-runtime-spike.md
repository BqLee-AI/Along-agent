# 11. Cangjie Runtime Spike（第二实现）

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：Cangjie 在五缝中的位置与分工、Spike S1–S3 数字标准、灰度阶梯、结案模板、红线（永不直连库）
- **不包含**：TsAgentRuntime 本体设计（见 09）、CI 死规矩实现（见 13）
- **阶段标签**：v0–P3 不用 Cangjie；Spike 与 P1 并行、P2 末结案；是否转正另行决策（Deferred）

## 标记约定

Observed / Required / Proposed / Deferred 同 01。**本篇所有数字阈值均为“实验起步值”（Proposed，待校准）**，结案时按实测回写。

## 1. 位置与分工（Required）

- CangjieMagic 只作 AgentRuntime **第二实现**：`CangjieAgentRuntime` 经远程 HTTP/SSE 提供与 TsAgentRuntime **同一契约**（`run/resume/cancel → AgentEvent`，见 09；`contracts` 同一套契约测试进程内/远程双跑）。
- 分工：仓颉侧只管“想与编排”（选 Agent、跑 loop、调工具、产事件流）；**不做鉴权、不直连业务库、不做时间归一**（Observed B04§2/§5；B06§4：TS 只收输入、只摆快照、不重算——Spike 阶段仓颉侧同样不重算时间，需排期回调 `propose_task`，见 §5）。
- 隔离：代码只进 `spikes/cangjie-runtime/`；产物独立镜像；内网调用；失败不影响主路径（灰度外流量永不进仓颉）。

## 2. Spike S1–S3（Required 立项，阈值 Proposed 实验起步值）

| Spike               | 目标                                            | 通过标准（实验起步值，待校准）                                                                                                                                                      |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 契约+性能+稳定性 | 同一契约全绿；首 token 可接受；无泄漏；取消及时 | ① `contracts` 契约测试全绿（进程内+远程同一套）；② 100 并发下首 token p95 ≤ 150ms（本机/同内网，待校准）；③ 30min 持续流 RSS 不涨（±5% 内，待校准）；④ `cancel` 2s 内生效（待校准） |
| S2 恰好一次         | kill -9 后 resume 副作用恰好一次                | ① `kill -9` 后 `resume(from_checkpoint)` 可续；② 工具副作用计数恰好一次（含 fencing/幂等键去重证据）；③ 重放不产生第二条 Task/通知                                                  |
| S3 生态贯通         | 卡片 zod、MCP 经网关、OTel、镜像                | ① 200 张卡片 zod 通过率 ≥ TS 实现 −2pt（待校准）；② MCP 调用经 ToolGateway（直连数为 0）；③ OTel trace 贯通（run→tool→approval 同 `request_id`）；④ 镜像构建 ≤ 10min（待校准）      |

- 所有阈值标注 `[实验起步值]`；任一不达标只延期结案，不放宽标准。
- 测量方法：与主路径同负载、同 `contracts` 用例、同 OTel collector；原始数据归档 `spikes/cangjie-runtime/reports/`。

## 3. 灰度阶梯（Required，S1–S3 全绿后才可进）

1. 影子（0% 用户影响）：复制线上只读流量比对事件流一致性，不落库。
2. 内测（白名单 actor）：真实 `run`，独立 revision 标记，可一键切回 TS。
3. 小流量（≤5%，可回滚）：一級指标（取消后触发数=0、missed 不补发）无回归。
4. 转正评审：是否转正另行决策；转正前仓颉仍不得直连库、不得算时间。

任一阶梯一级指标破 0 即回滚到上一阶（Required）。

## 4. 结案模板（Required，每 Spike 一份）

```text
Spike <S1/S2/S3> 结案
- 结论：通过 / 未通过（含未达标项与数据）
- 阈值对照表：每项“起步值 → 实测值 → 建议正式值”
- 回写：本篇阈值更新 + contracts/stream-protocol 变更（如有）
- 决策建议：继续 / 暂停 / 转正评审
- 附件：reports/ 原始数据 + trace 样例 request_id 列表
```

P2 末三份齐后统一结案；缺一份即“未结案”，P3 不得转正。

## 5. 红线（Required，违反即 Spike 失败）

1. 仓颉永不直连业务库（PG）：上下文由调用方传入；需要记忆/知识走服务接口。
2. 仓颉不做时间归一：需排期回调 `propose_task{wall_time, timezone_id, fold_choice?}` 给 TS/time-core，结果以 TS 回执为准。
3. 仓颉不直接调外部 MCP Server：统一经 ToolGateway（白名单+审计）。
4. 仓颉不暴露公网：只接受 BFF/调度内网调用（Observed B03§7）。
5. 归一禁引 CangjieMagic（B06§4/P1 死规矩）：`time-core` 依赖图 CI 拦截，见 13。

## 引用

- B04 全文、B05§S1–S3、B06§4；合同 Cangjie 条款；AF 隔离思想。
