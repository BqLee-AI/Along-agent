Issue: #67

## Why

R1 已有正式 Linux native、TS MCP、PG 与文档任务闭环，但用户启动仍依赖手工配置、分开启动 Web 和容器。根 dev 不建立正式 native 环境；apply.sh 重放全部迁移，不能用于旧库日常启动。缺少稳定配置和升级边界会使再次启动换密钥、换卷或破坏原工作区身份。

## What Changes

- 定义四个根入口的目标合同：初始化、启动、停止、显式升级；复用现有 Bun/Compose/正式镜像与 Windows Web，不引入常驻管理平台。
- 私有配置固定原认证/已授权模型配置、origin、项目/卷和登记来源；启停保留原数据、owner 和 root 身份，只管理本安装进程，不自动恢复 Agent 或重写 unknown。
- 区分空应用库、核实完整的 0016 基线、未知/部分旧库；保留旧迁移，禁止猜版本、stamp、清库和全量重放旧库。升级先停旧写者，单一部署许可内迁移，失败不开新写者，接纳新事实后前滚。
- 准确区分进程健康、配置齐备与真实模型可用。新安装允许账户/工作区未配置；#67 提供配置和重载入口，#68 独立完成管理员选择、身份绑定及登记收尾。

## Spec

- 设计真源：docs/design/15-r1-local-lifecycle.md §1–§7；所有权：docs/design/02-modular-monolith-and-split-triggers.md §1。
- 工作区与原 Run/文件边界沿用 docs/design/14-r1-document-task-loop.md §3、§6–§7，不重定义授权/执行状态机。
- 新增 local-lifecycle 行为增量；同步 docs/prd/04-acceptance-open-questions.md、docs/README.md 和根 README 导航。四入口名称是设计合同，不在使用说明中冒充现有命令。

## Capabilities

### New Capabilities

- local-lifecycle：本机配置、生命周期、迁移分流、既有登记与准确诊断；归 scripts/infra 部署工具，不新增业务存储模块。

### Modified Capabilities

无；保留 workspaces、agent-runtime、tool-gateway 和 gates 主合同，生命周期验收只补受影响路径。

## 非目标／Deferred

不实施代码、运行配置或旧库操作；不在本 PR archive 或关闭 #67/#66。正式登录、原账户转正和新 owner 绑定归 #68，历史归 #69，视觉/MVVM 归 #70。不开公众注册、不改认证/CSRF/owner/精确批准/取消/unknown，不进入 R2，不移植 Windows native，不建设通用部署/配置平台。不更换已授权 provider、默认模型或路由，不新增市场/推送/计费决定，不读写 .env 或提交真实凭据。
