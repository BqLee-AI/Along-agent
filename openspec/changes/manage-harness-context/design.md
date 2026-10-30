# R2-A 合同决策与证据入口

> 状态：正式设计及证据边界；运行结果单列于 tasks。
> 范围：Issue #83，单 Run 上下文实现与分级验收。
> 不包含：R2-B 路由、跨 Run 记忆、LLM 摘要、任意崩溃恢复、接管并行安装或发布。
> 阶段：合同 → 独立实现 → 正式消费者/真实任务 → 归档。

## 1. 真源与审定决定

唯一详细设计为 [design/18](../../../docs/design/18-r2a-harness-context.md) §1–§9；本文件只记录证据边界与变更导航，不复制第二套字段合同。原草案路径保留导航，不保留平行设计。

- 采用独立输出 cap 与完整包装计量，不用 remaining_tokens 直接作 max_tokens。
- 采用不可变 per-Run policy；不动 frozen_context 的建后冻结。
- 采用 harness/v4；snapshot2 语义不变，不造 snapshot3。
- 采用 typed observation union 和确定性来源投影；回取与淘汰一起交付。
- context_source 收窄为已接受单个观察的 full/projected 重呈现，不接受分页参数、不作为模型的免费回取工具。主动分页只走 read_run_observation。
- 采用 16384-byte 整结果页上限，依据、单位、超大单元素失败见 design/18 §7；不是 token 换算或每个 Run 同时容纳 64 页的承诺。
- 不引入摘要模型请求、自动重试、后台恢复或新的 Web 配置/DTO/SSE。

## 2. 基线与 #70 对齐

本 worktree 建立基线为 `7f282e3`（#70 OpenSpec-only 设计）；2026-10-30 续验快进至 `f8863f5`，包含 #70 实现 `96ca073`（PR #82）及归档（PR #84）。Issue [#83](https://github.com/BqLee-AI/Along-agent/issues/83) 的实现保留为未提交工作树；集成差异和续验结果记入 tasks，不以基线快进代替行为证明。

正式 #70 体验合同保持：目标选择仍明确映射 business/harness；批准仅授权，原 Run 显式继续；GET/刷新/重登零执行；完整预览、当前登记、取消、unknown 和 verified 效果守卫不变。R2-A 不要求公开 API、RunView 或七事件新增字段。接口核对覆盖 harness/v3 streaming 的 start/model 帧、usage 缺失合并、assistant/tool_calls 配对与流式文本中途失败/取消；v4 必须保留它们有效语义，不能回到仅非流式/工具零历史路径。

2026-10-30 只读对照：main 为 `7f282e3`；#70 分支 head 为 `da216fb`，其四个本地提交及后续未提交流式/历史改动未进入本 worktree。基线 `buildHarnessStart` 仅一条当前 user 输入，协议 harness/v2；63＋1、`model_next{model_ref}`、`HarnessModelStepSchema(delta|complete)`、异步流 transport、authority 的 modelStream 拉取/ack 状态机均来自 #70 并行改动。v4 明确保留 model_next 和 step 协议，仅为新额度/来源语义升级版本，不删除 streaming。modelStream 活跃期间仍只允许 model_next/answer/取消收尾，不允许 measure/context_source 插入改变在途候选；complete 后才装配下一轮。#70 的 length 暂映射 BUDGET_EXCEEDED；R2-A 明确修订为 HARNESS_CONTEXT_LIMIT（输出容量截断），累计预算耗尽仍原码。64 refs 保持 HARNESS_CONTEXT_LIMIT，不混为 token 余额耗尽。

实现承接 63＋1 与流式拉取/ack 语义，并以 #70 合并源码核对最终差异。正式安装升级另与现用服务串行；功能续验可在独立端口、独立 PG/资料卷和既有真实模型配置下进行，不把升级现用安装当作隔离 Web 验收的前置条件。

## 3. 已有证据及其限度

原草案保存的离线合成实验：十工具目录 3782 bytes，provider mapping 3952 bytes，转义目录约 4242 bytes；5/6 次 200000-byte 读取的简化合成 HTTP 为 1011016/1211501 bytes；schema 接受的合成恢复 start 为 1206057 bytes；投影原型 6849 bytes。没有运行新 wire 或模型，不把这些值充当性能/token/成功率。正式设计沿用问题证据，不重复实验为新成果。

历史只读对照中的 `listHarnessMessageRefs` 的 63＋1 与输入冻结来自 #70 并行实现；对应能力随 `96ca073` 合入。#70 的[Web验证记录](../../../docs/web-task-experience-verification-2026-10-28.md)保存其三轮 refs 为 1/3/5、工具调用0及五轮流式 refs 为 1/3/5/7/9、工具调用0的补验，并分列原安装资料闭环。该记录不证明 #83 六份大资料的投影、恢复、回取、精确修改和新回读；本 change 按实际集成状态独立取证。

## 4. 影响、迁移及验收

[design/18 §3/§8](../../../docs/design/18-r2a-harness-context.md#3-冻结策略及旧-run) 定义策略补录、旧 allowlist、同批 wire 切换、停写迁移/前滚；[schema](../../../docs/schema/conversation-and-runs-schema.md#r2-a-上下文策略83) 定义存储，现有迁移不可改。[对话 API §7](../../../docs/api/conversations/conversations_routes.md#7-r2-a-上下文容量83) 记录公开不变面与错误边界。

实现顺序/每项验证负责人见 design/18 §9 与 [tasks.md](tasks.md)。文档 strict 校验和引用核对不计运行验收；受控 native/HTTP/PG 与真实模型分别取证，不降低 #83 的六份资料、失败、冲突、真实回取、批准后新读取及小任务对照要求。
