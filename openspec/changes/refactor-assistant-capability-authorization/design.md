# 合同设计裁决

## 1. 责任真源与证据

字段、接口、状态、一致性和迁移的唯一详细设计为 [design/20](../../../docs/design/20-goal-scoped-delegation.md) §1–§10。本文记录本次变更为何选择该合同及如何对齐，不复制第二份字段表。现行实现、Required 目标、Proposed 接缝与 Deferred 分别标记；规范通过不证明业务已实现。

现行证据入口：conversations/service.ts、reminder-date.ts 负责接纳锚/可信来源；harness-authority.ts 组装 start 并持有请求执行；contracts/harness.ts 与 apps/harness/src/main.cj 严格 v5/snapshot2；tools/invocations.ts 负责稳定调用/接受结果/一次许可；workspaces/replace.ts 和 approvals/document-service.ts 分离精确授权与文件效果。路径以 docs/demo/agent-capability-refactor-plan.md §2 为索引，源码事实不自动成为新授权。

## 2. 不选择的替代方案

| 方案                                | 不选择的原因                                           | 采用                                                 |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| 隐藏按钮、自动 confirm              | 冒充用户批准并复制错误授权，不补齐能力                 | 新 profile 的真实直接用例，legacy 原门不变           |
| 所有写入都问一次                    | 用户一次委托被拆成审批队列；明确重写/取消重复索权      | 正常步骤自主，仅实质缺口/新增影响问                  |
| 全盘/任意工具或全局自主开关         | 目标语义不能替代部署资格和能力                         | 冻结资源集合、当前资格、精确对象/效果                |
| 第二模型或消息 hash 证明授权        | 不能证明自然语言委托，增加另一语义裁判                 | 唯一助理模型解释，TS 证明确定事实，明示残余风险      |
| 输入长等待/目标表/可执行计划引擎    | #103 已有可信跨 Run 来源，不需要第二生命周期           | 扩充同一来源核验责任，GoalResult 与每 Run 预算       |
| 模型 item_key/effect_key/supersedes | 模型自报身份不能消除语义重复，内容合并还吞合法重复目标 | 原入站/稳定调用身份、已接受收据与 unknown 停止       |
| 只删除 SSE abort                    | 请求不再持有执行，但没有唯一执行者或失联收尾           | 同 executeHarness 薄 driver、PG session 占有与资格门 |
| 改写旧 Run 或等24小时清空等待       | 扩权、破坏冻结事实；文档批准没有任务的统一 TTL         | 只接纳新 profile，受限旧恢复与发布前等待清点         |

## 3. 规范增量的边界

- v0-safety-contract 裁决授权分支、时间和只读简报；原 Requirement 4/5/6 的事务、回执和冻结展示不弱化。新 profile 不是 legacy 的自动确认。
- identity 拥有真实时区写入与退出/禁用差异；tools 只调公共用例。
- tool-gateway 拥有本地效果/结果原子性、确定性资格与稳定调用；不用自然语言正则代替模型。
- workspaces 拥有登记集合、自主选择、有限创建、精确修改/版本/一次许可和新回读。旧精确批准场景明确仅 legacy 或新增影响授权。
- agent-runtime 拥有真实阶段能力、独立冻结生命周期、目标结果及最终server-owned；conversations拥有可信来源/真实投影/只读历史，并允许新profile新增影响一次精确授权并继续。决议不是效果，不预设HTTP次数；legacy仍原合同，不另立目标表/第二循环。

所有 MODIFIED requirement 以完整行为段和场景给出；仍适用的旧场景保留语义或限定 legacy。原编号 Requirement 4/6 直接按原标题修改，不重写历史归档。新/legacy 策略的适用关系见 design/20 §1，冲突以本 change 对新 profile 的明确裁决为准；没有获得新 profile 的运行仍受现行主规格约束。

## 4. 实施与证据接缝

本阶段不运行任何业务链。后续顺序沿 #104：可信上下文/设置 → #90直接提醒 → elapsed/展示 → 查询取消/接续 → 资料编辑 → 有限创建 → 页面解耦 → 混合验收/历史收口。共享 v6/GoalResult 接缝由单一集成负责人维护；必须同时满足相应 TS/native/Web 消费者，不能合空工具或以未实现能力命名充数。

阶段生效见design/20 §1、§4、§8：2.1偏好等完整价值可以request-bound交付，授权修订不依赖2.7后台完成；未交付elapsed修订/创建工具/输出资格不得声明。server-owned验收后只进入新接纳相应Run，历史及先前request-bound不随部署改义；最终后台与混合验收仍必需。新增影响交互见design/20 §3，拒绝/停止/unknown/迟到不能推进，不把授权决议当真实保存。

用户价值、模块和唯一验收负责人映射见 design/20 §10；任务列表逐项记录合同阶段与未授权实施阶段。实施需要受影响的确定性行为覆盖及真实消费者/模型/产物证据，不能用本阶段文档绿或历史运行升级为通过。#103来源、#102交互可复用，#100/#101及其他安装不接管。整体 change archive 只在全部适用实施与验收完成后进行。
