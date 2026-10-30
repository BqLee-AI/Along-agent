Issue: #83

## Why

工具完整正文逐轮累积，批准恢复也聚合全部观察，单次合法结果不能保证整体在 1MiB 内。Run token 余额又直接成为单次输出上限。需要在不丢冻结输入、接受事实和权限的前提下管理单 Run 容量，而不是提高硬上限或引入第二套 Agent。

## What Changes

- 分开累计 Run 预算、模型窗口、独立 completion cap 与完整 wire/HTTP 字节门；区分 verified/estimated/unavailable，usage 缺失永久 unknown。
- 仓颉选择确定性有来源投影；TS 提供计量与原接受事实，不修改 snapshot2 全部引用、usage、调用号和等待身份。
- 新静态只读工具 read_run_observation 经既有网关按原版本分页，当前授权、持久调用和预算不绕过；片段不作全文基线或新回读。
- 冻结 per-Run context policy；harness/v4 与 bounded start/恢复一次切换，旧 Run 不自动扩权。

## Spec

设计真源：[design/18](../../../docs/design/18-r2a-harness-context.md) §2–§9；原职责/有限恢复：[design/09](../../../docs/design/09-agent-runtime-and-checkpoint.md) §1–§6；精确文档动作：[design/14](../../../docs/design/14-r1-document-task-loop.md) §4–§7。行为 delta 归 agent-runtime、tool-gateway、workspaces。

## Impact

实现影响共享 wire/native、conversations 策略/模型/恢复、tools 来源查询与静态工具、正式消费者及生命周期基线；新增0019迁移，公开 HTTP/SSE/RunView 不加字段或路由。与 #70 的接口证据和串行安装边界见 [design.md](design.md)，分级运行结果见 [tasks.md](tasks.md)。实现不自动关闭 #83/#66 或归档。

## 非目标 / Deferred

不做 R2-B 自动路由、R3/R4 记忆、LLM 摘要、通用 tokenizer/MCP/遥测平台、多 Agent、任意 crash 恢复、无限大文件；不选择市场、provider、推送或计费。不升级/重启 #70 安装，不 commit/push/创建 PR。真实模型验收使用原配置、独立隔离资料和运行环境，与受控合同分别取证。精确计量依据不可得时只承诺字节门和独立 cap，不承诺精确 token/费用保证。
