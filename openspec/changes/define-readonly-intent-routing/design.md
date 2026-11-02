# R2-B 合同决策与边界

> Proposed；Issue #88。本轮仅正式设计与 OpenSpec，用户审阅前不实现、部署、自然流量实验或归档。

## 1. 唯一真源与选择

详细设计唯一真源为 [design/19](../../../docs/design/19-r2b-readonly-intent-routing.md) §1–§14；本文件仅导航决定与兼容边界，不再维护算法、帧字段或模型性能表。

- 仓颉唯一决定下一步、工具与停止；TS 提供可信事实、匹配/参数来源、编码打分、原 authority/网关、持久化和纯展示（§3、§6–§9）。不复制两语言规则，不设第二 TS Agent。
- 采用默认 off 的首步 L1/L2/L3；shadow 最终 fallback 且不旁路执行，enforce 仅批准白名单。参数与当前资格优先于分数，拒识保留完整请求（§4、§6、§10）。
- 主候选为已固定资产的 BGE-small 中文 INT8；E5 仅独立离线对照，不在线切换或双编码。目标独立内网 CPU sidecar 复用已实测 ORT/tokenizer 路径，正式 Linux 镜像与服务仍须目标宿主最小实验后锁定（§5、§11）；不沿用旧草案的 Qwen/TEI 选型。
- 采用 v5 同批切换与 append-only 内部 checkpoint；snapshot2、frozen_context、公开执行选择与 SSE 七词不变。direct 绑定唯一原 reserve/invoke 与真实结果，再纯投影展示；失败不借 LLM 重做（§7–§10）。
- 采用新的分组 calibration、冻结未见留出、正式消费者/真实 Web、自然 shadow、逐意图受控启用门；预算是 Proposed，不是 SLA。缺目标部署或收益证据就保持 L2 off（§11–§14）。

## 2. 兼容与主规格冲突处理

既有 [agent-runtime](../../specs/agent-runtime/spec.md)、[tool-gateway](../../specs/tool-gateway/spec.md)、[conversations](../../specs/conversations/spec.md) 的身份、时间、批准、冻结展示、取消、unknown、结果重放及有限恢复合同保持。

唯一需要完整 MODIFIED 的 Requirement 是 conversations“常驻输入与连续会话”：旧“不选工具的多轮交流”场景无条件要求第二轮模型收到冻结输入，与合格 direct 的零模型交付硬冲突。delta 保留完整 Requirement 及四个场景，只明确所有新 Run 仍冻结63＋1、实际进入模型的 fallback 才装配模型上下文；不借 direct 跳过接纳/容量前提。其余新增路由限制均作为已有能力下的 ADDED，不重述无冲突的旧要求。

R2-A 的 context policy 有有效批准恢复补录规则；R2-B routing policy 是不同事实，旧 Run 缺策略即 off，恢复不补录、不重路由。原“真实流式聊天”只约束 provider 实际增量，继续保持；确定性工具展示另受真实结果/render 来源约束，不冒充 provider 流或 usage。

## 3. 证据与阶段边界

证据入口为 [脱敏实验记录](../../../docs/verification/r2b-embedding-evidence-2026-10-31.md)，机制及验收见 design/19 §2、§12–§14。BGEINT8 暴露的是时区读取误派活动提醒；“先读时区再切换”遗漏第二目标来自已淘汰 Dmeta，不能归到 BGE。两者分别成为工具目标正确性与完整多目标回归。共同误挡覆盖过去添加与当前活动语义、动词中的“到”、否定更长列表、场景时间与明确日期，不按单句开白名单。

原92条与已暴露的两轮 test 只作回归，合成非盲数据不作自然分布或独立留出证明；Windows batch1 离线计时不能证明 Linux HTTP/共存/端到端。资产或规则修改后新建 bundle 并重新校准，不能换标签、删失败或沿用旧阈值冒充上线资产。

后续任务与证据所有权见 [tasks.md](tasks.md)。299 独立接受/意图只是零错时特定统计上界的示例，不是开发或受控小批前置；受控顺序、提议比例及停用边界见 design/19 §12，均不构成本轮发布授权。
