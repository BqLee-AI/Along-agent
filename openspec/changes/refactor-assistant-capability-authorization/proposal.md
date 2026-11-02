Issue: #105

# 本人目标内委托与授权

## Why

现行“模型只提议、写入逐项按钮确认”不能完成本人一次委托的正常多步目标。仅隐藏按钮或扩大 allowlist 会绕过合同，并不能补齐可信事实、真实能力和可核验效果。上级目标为 [#104](https://github.com/BqLee-AI/Along-agent/issues/104)，明确提醒消费场景复用 #90。

## What Changes

- 新 delegation profile 内自主完成设置、明确提醒创建/取消、受管资料创建/编辑；只问实质缺口或新增影响，硬资格不能按钮放行。
- 统一可信时间/偏好/资源事实、资料事实与授权分离、#103 可信跨 Run 接续、真实目标结果、稳定调用/unknown 和精确文件效果合同。
- 明确连接与执行所有权、停止/取消/退出/禁用差异，旧 pending/快照/结果不扩权，TS/native/Web 配套协议及前向迁移。

## Spec

设计真源：[design/20 §1–§10](../../../docs/design/20-goal-scoped-delegation.md)；现行基础为 design/04 §3、05 §3/§5/§9、06 §0/§11、09 §1–§8、14 §3–§7、17 §6–§7、18 §2–§8。

行为增量：v0-safety-contract、identity、tool-gateway、workspaces、agent-runtime、conversations；spec 不复制路由/字段表。PRD、Agent 职责、适用 design/API/schema 和仓库规则同步标明 legacy 与 Proposed 范围。

## 生效与交付

本 PR 只交合同和文档检查，不改变业务代码、数据库或当前运行行为。新权限只在相应完整切片实施/验收后由新接纳 profile 获得；历史保持原合同。两份主线程规划输入纳入本交付并保留 Proposed 身份；长期 change 不因本规范 PR 先合入而 archive。

## 非目标/Deferred

不部署、不合并、不关闭 Issue、不执行真实用户业务、不自动创建后续议题、不恢复旧混合草稿、不新建环境或触碰 #100/#101。无任意 shell/SQL/全盘、第二 Harness/语义裁判、权限 DSL、目标引擎、输入长等待或模型发号持久去重。不承诺语义 exactly-once、跨文件/PG 全局事务或崩溃自动恢复。市场、LLM 供应商、外部推送、计费及长期授权仍按 PRD 04 Deferred 管理。
