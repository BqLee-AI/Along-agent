Issue: #46

## Why

TS 的同进程 RunContext/ToolContext 含可信身份与权限，不能原样交给仓颉调用端自报；确定性 v0 turn 也不能充当第二套通用 Agent。#45 已提供稳定调用身份与结果账，本阶段需把真正的仓颉执行核心接到 TS 的可信运行、批准和持久化裁决上。

## What Changes

- 正式仓颉原生核心独占循环、上下文、工具提议消费、预算、等待/恢复与停止；TS 保留业务、身份、工具权限、Run/checkpoint/结果账与 Web/SSE。
- 每个有效 attempt 绑定一个原生子进程，使用版本化双向 JSON 行协议；工具提交不携带可自选的 owner、权限或执行资格。
- TS 原子裁决 Run 状态、当前 attempt、取消与终结，复用 #45 调用引用、冻结结果和未知不盲重发；无 TS Agent 回退。
- 批准等待保存有限上下文并结束当前传输，批准决议后显式恢复同一 Run；事件补读不恢复执行。
- 五工具通过所属模块公共用例/只读投影获取数据，保持原输出及受控事务；真实 Web/HTTP/仓颉/PG 边界证明授权、状态和效果。

## Spec

- `docs/design/04-five-seams-contract.md` §2–§3、§7；`docs/design/09-agent-runtime-and-checkpoint.md` §1–§6、§8；`docs/design/11-cangjie-runtime-spike.md` §1、§4–§5；`docs/design/10-api-and-stream-design.md` §3–§4。
- 本 change `design.md` 为本阶段具体实施合同；`specs/agent-runtime/spec.md` 定义六项可验收行为。工具调用继续服从 `openspec/specs/tool-gateway/spec.md`，不重复造账。
- #47 后续消费同一正式协议和实际仓颉核心，在既有 contracts-dual 中升级明确范围的契约证据。

## 非目标／Deferred

不实现完整 R1、任意崩溃无人值守恢复、全工具/连接器平台、memory/PC/browser/MCP、多 Agent、远程 RPC 服务或全后端迁移。不代选 LLM 供应商/市场/推送/计费，不在本 change spec 冻结供应商字段。CI 仅替换模型传输的受控响应，不能替代仓颉生产核心；fixture 边界验证不冒充真实 provider、模型质量或 R1 产物验收。D8 状态只由后续 #47 的真实覆盖决定。
