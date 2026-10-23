Issue: #45

## 为什么

工具先创建批准再独立写审计，审计失败可能遗留脱节批准；按 Run/tool/args_hash 忽略冲突不能区分合法新调用与重交，也不能找回已接受结果。引入 TS 所有的稳定逻辑调用身份和结果账，供既有工具及后续 Harness 接口使用。

## 行为变更

- 工具执行前持久预约调用引用；同引用同内容顺序／并发重交返回原结果，同参数的新引用仍是新操作。
- 本地批准创建、接受结果与只追加审计同事务；保存拒绝、澄清、类型化错误与已证实回滚的失败，不把审计行当业务结果。
- 已接受批准只关联原冻结批准；只读工具重放原输出快照。重交重验当前访问资格，不改写历史结果，不自动恢复 Run。
- 非事务动作在调用前持久取得一次资格；未知只核对，不盲重发。以真实文件副作用和进程终止验证共同执行边界，不宣称现有 MCP／文件产品工具或 external exactly-once。

## Spec

- `docs/design/04-five-seams-contract.md` §3、§7；`docs/design/06-approvals-confirmation-gate.md` §4–§7；`docs/design/09-agent-runtime-and-checkpoint.md` §5–§6。
- `docs/agent/02-tool-gateway-and-v0-tools.md` 的网关、权限与审计边界；本 change 的 `design.md` 是实施合同，落地时同步长期真源。
- 新行为契约：`specs/tool-gateway/spec.md`。验收映射 issue 六项 I1–I6，保留 A2/A4、D1/D2/D3/D5/D6/D8/D9/D10 原保证范围。

## 非目标／Deferred

不实施 #46/#47、仓颉 Harness、Run 自动恢复或远程权限协议；不新增生产文件／MCP 工具、provider、注册平台、后台重试、通用分布式事务；不提升 D8 状态。不改按钮确认、time-core、事件账、调度许可、旧迁移、凭据或供应商决策。
