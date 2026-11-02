# 任务与验证

## 1. #105 合同阶段（不启用权限）

- [x] 1.1 核对 #104/#105、交接输入、#103 基线与现行合同；保留两份 Proposed 规划输入。
- [x] 1.2 在 design/20 明确自主/缺口/升级/硬拒绝及唯一规则所有者；裁决资料事实、可信时间、效果、停止和历史边界。
- [x] 1.3 起草 proposal/design 与六个 capability spec 增量，覆盖正反例；不修改主 spec 或 archive 来伪造已生效能力。
- [x] 1.4 同步 PRD、Agent、适用 design/API/schema、AGENTS、CONTRIBUTING 与索引的 Proposed/legacy 作用域。
- [x] 1.5 执行目标 change 和全量 OpenSpec strict、格式、引用/合同一致性检查；记录实际结果，不跑无关业务。
- [x] 1.6 检查暂存列表/diff/秘密，仅提交合同输入；push 并建 Draft 规范 PR，Refs #104/#105，向 #105 更新交付评论；不合并/关闭/自动建单。
- [x] 1.7 根据总指导R1/R2聚焦修订：独立冻结实际能力/执行生命周期，新增影响可一次精确授权并继续；补正反场景、同步指引，仅验证本轮文档，不实施或推进下一议题。

## 2. 后续实施范围（仅路线，不授权本阶段执行）

- [ ] 2.1 可信执行上下文与本人默认时区真实保存/清除：接纳锚、优先级、同委托设置回执，v6/GoalResult 共享接缝单一所有者；按 design/20 §1 冻结并显示实际能力及 request-bound，不依赖2.7、不虚报后台/elapsed/创建；后端验证偏好原子性，Agent验证可信事实，Web验证真实限制。
- [ ] 2.2 复用 #90 完成明确提醒直接创建：tasks 公共创建用例、task/created/outbox/接受结果原子提交；legacy confirm 调同用例，不能模拟 consumed；后端负责 PG/重放，Web 负责真实免逐项批准。
- [ ] 2.3 完成严格 elapsed/UTC：纯计算、真实锚/规则身份/过窗、来源约束及 task/今日列表/详情/通知冻结展示同交付；未完成时elapsed修订为空/不可用，完成后仅新接纳相应Run获能力；后端负责时间/数据库，Web负责真实表面与到点结果。
- [ ] 2.4 完成完整任务查询/唯一取消/歧义接续：复用 #103 来源核验与接纳事务唯一后继，仅续未完成部分；后端负责并发/回执，Web 负责缺口旅程。
- [ ] 2.5 完成受管资料自主检索/编辑：冻结登记集合、真实MCP、精确版本/许可/新回读；正常步骤不审批，新增影响允许一次精确授权并继续，拒绝/停止/unknown/迟到不推进，legacy仍原合同；workspaces负责文件边界，Web负责无机械第二按钮旅程，不预设HTTP次数。
- [ ] 2.6 完成有限输出目录真实文件创建：no-replace、不覆盖/链接/资格边界、独立回读；完成前不暴露对应工具/输出资格，完成后仅新Run冻结真实创建能力；workspaces负责真实文件系统，Web负责创建结果。
- [ ] 2.7 完成执行/订阅解耦：同Harness服务端唯一占有、刷新/离开继续、显式停止、退出/禁用、失联中断/unknown；验收后仅新接纳相应Run冻结server-owned，既有legacy/request-bound不迁写；最终重构不得用早期request-bound替代本项，Agent负责所有权故障，Web负责重连只GET。
- [ ] 2.8 完成历史与前向发布：旧有效等待受限恢复、v5拒绝v6、TS/native/Web配套、旧模板/快照/结果不迁写；集成负责人只补跨模块和迁移缺口，不触碰冻结实验。

## 3. D/A 行为证据与整体收口（后续负责人执行）

- [ ] 3.1 D1/D6/D8：新/legacy profile、owner、来源、资源集合、登记外/链接拒绝；“只摘要注入不执行”与“按资料建提醒可执行”的独立人工 gold 真实模型正反例。
- [ ] 3.2 D1/D2/D7/D8/A4：elapsed 锚+180秒、无时区不问、TZDB坏但UTC依据真实；墙上时间/DST/过窗不顺延；新旧冻结与今日投影边缘，不能造规则版本。
- [ ] 3.3 D3/D4/D5/D8/A1/A2：本地事务任一步失败全回滚；同入站/同调用/异参、并发取消和接续；明确相同新请求不吞并，既成效果不重做。
- [ ] 3.4 D8/D9/D10/A3：文件许可/响应丢失/真实回读、零写冲突自主修正、unknown不换身份重写；运行失联/停止/预算门不发后续动作，任务仍守取消优先/真实回执。
- [ ] 3.5 A1–A4/D1–D10：复用适用证据，在已有产品安装完成真实 Web→native→TS/MCP→PG/文件→自然通知混合目标；分别呈现 completed/partial/blocked/unknown，不以 Run done 或受控响应代替真实结果。
- [ ] 3.6 集成负责人核对所有合同/代码/API/schema/PRD/规则、当前五门与真实模型评估；只在整体实施/验收收口授权后 archive 本 change，不因规范先合入关闭 #104/#105。

## Verification

#105 仅为文档合同阶段。检查结果按所检查提交状态记录在本节；没有执行业务测试、部署或真实用户任务的验收声明。后续业务证据不得提前勾选。

### #105 首轮文档状态验证（2026-11-02，合同提交512df82）

- 策略：纯规范，不适用业务 TDD；不把文档校验当实现或真实用户验收。检查范围为本 change、design/20、两份交接输入及必要跟随文档，共47个 Markdown 文件。
- `bun x --no-install openspec validate refactor-assistant-capability-authorization --strict`：目标 change 通过；`bun x --no-install openspec validate --all --strict`：10项通过、0失败。
- `bun run format:check`：首次发现3个文档格式问题，经既有 `bun run format` 修正后通过；`git diff --cached --check` 通过。
- 仓库外一次性文档检查：6个 capability、31条 requirement（20 modified / 11 added）、91个场景；MODIFIED原标题均匹配主spec，新增无重名，每条2–4个WHEN/THEN场景且有D/A映射；实际OpenSpec CLI同样解析出31个增量，不只检查Markdown外形。
- 新增/变更行的98个本地文档链接及锚点存在；暂存范围仅文档，凭据模式扫描未命中。未纳入业务代码、迁移、配置、缓存、产物或本机调度台账。
- 人工合同核对：接续复用conversations行接纳锁；入站幂等有效24小时，不冒称永久重放；task批准24小时不泛化到文档；新自然目标不要求TS入站语义分类，wall动作缺规则零该动作效果，legacy预检保持。
- 未跑 `verify`、typecheck/unit/contracts/integration/scheduler、模型/数据库/Web/native/MCP或部署：本阶段只定合同且明确不运行业务，未实施能力保持未验收，五门由CI/后续实施按原门槛举证。

### 外部交付（2026-11-02）

合同提交 `512df82` 已推送 `docs/105-spec-assistant-delegation`；[Draft PR #106](https://github.com/BqLee-AI/Along-agent/pull/106) 关联 Refs #104/#105/#90，[#105 交付评论](https://github.com/BqLee-AI/Along-agent/issues/105#issuecomment-6576836156) 已发布。本节补记外部交付，不改变前述31条合同；后续实施/业务验收未执行，不归档、不合并、不关闭或自动建后续议题。

### R1/R2聚焦修订验证（2026-11-02，基于70ee500）

- 范围：仅修授权/能力/生命周期耦合及新增影响授权交互，共23个Markdown文件、4份spec；design/20 §1/§4/§8为R1唯一详细真源，§3为R2交互真源，其余为场景/跟随指引。未重做已有效的首轮全量检查。
- R1：`agent-runtime`新增“冻结阶段能力与执行生命周期”的3个场景，覆盖偏好先交付但后台/elapsed/创建未交付、新server-owned断订阅继续、旧/早期request-bound不随部署改义；`conversations`补真实生命周期/能力显示场景，`identity`退出场景按冻结生命周期区分。tasks 2.1不依赖2.7，最终2.7及混合验收仍必需。
- R2：`conversations`“精确批准与显式继续原运行”的4个场景保留正常自主和legacy原合同，明确新增影响一次用户动作、拒绝/停止/unknown/迟到/无效等待点不推进；`workspaces`精确批准场景同步。未把旧“显式继续”武断判为现有界面需两次点击，不预设HTTP请求数量或新自动恢复平台。
- `bun x --no-install openspec validate refactor-assistant-capability-authorization --strict`通过；实际CLI解析当前change为32条requirement、96个场景。定向检查4份变更spec的20条requirement/60个场景：原标题、2–4个WHEN/THEN场景及D/A映射通过，未将旧head校验冒充新head。
- 仅对23个变更文件执行既有Oxfmt检查；发现design/20责任表格式需调整，定向修正后通过。25个本轮新增/修改行本地链接及锚点检查通过，文档范围/凭据及机器路径模式扫描未命中；没有把一次性脚本入库。
- 不运行业务、模型、数据库、Web/native/MCP、安装或部署；未重跑首轮全量strict/98链接检查，不引用旧head的CI作为本轮通过。以上只证明规范与文档一致性，不证明生命周期或一次授权交互已实现。
