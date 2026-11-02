# 任务与验证

## 1. #105 合同阶段（不启用权限）

- [x] 1.1 核对 #104/#105、交接输入、#103 基线与现行合同；保留两份 Proposed 规划输入。
- [x] 1.2 在 design/20 明确自主/缺口/升级/硬拒绝及唯一规则所有者；裁决资料事实、可信时间、效果、停止和历史边界。
- [x] 1.3 起草 proposal/design 与六个 capability spec 增量，覆盖正反例；不修改主 spec 或 archive 来伪造已生效能力。
- [x] 1.4 同步 PRD、Agent、适用 design/API/schema、AGENTS、CONTRIBUTING 与索引的 Proposed/legacy 作用域。
- [x] 1.5 执行目标 change 和全量 OpenSpec strict、格式、引用/合同一致性检查；记录实际结果，不跑无关业务。
- [x] 1.6 检查暂存列表/diff/秘密，仅提交合同输入；push 并建 Draft 规范 PR，Refs #104/#105，向 #105 更新交付评论；不合并/关闭/自动建单。

## 2. 后续实施范围（仅路线，不授权本阶段执行）

- [ ] 2.1 可信执行上下文与本人默认时区真实保存/清除：接纳锚、优先级、同委托设置回执，v6/GoalResult 共享接缝单一所有者；后端验证偏好原子性，Agent 验证正式双消费者，Web 验证一次委托。
- [ ] 2.2 复用 #90 完成明确提醒直接创建：tasks 公共创建用例、task/created/outbox/接受结果原子提交；legacy confirm 调同用例，不能模拟 consumed；后端负责 PG/重放，Web 负责真实免逐项批准。
- [ ] 2.3 完成严格 elapsed/UTC：纯计算、真实锚/规则身份/过窗、来源约束及 task/今日列表/详情/通知冻结展示同交付；后端负责时间/数据库，Web 负责真实表面与到点结果。
- [ ] 2.4 完成完整任务查询/唯一取消/歧义接续：复用 #103 来源核验与接纳事务唯一后继，仅续未完成部分；后端负责并发/回执，Web 负责缺口旅程。
- [ ] 2.5 完成受管资料自主检索/编辑：冻结登记集合、模型选择、真实 MCP、精确版本、零写冲突重读、一次许可及新回读；workspaces 负责文件/unknown，Web 负责无机械选择/审批。
- [ ] 2.6 完成有限输出目录真实文件创建：no-replace、不覆盖/链接/资格边界、独立回读；workspaces 负责真实文件系统，Web 负责创建结果。
- [ ] 2.7 完成执行/订阅解耦：同 Harness 服务端唯一占有、刷新/离开继续、显式停止、退出/禁用、失联中断/unknown；Agent 负责所有权故障，Web 负责重连只 GET。
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

### #105 文档状态验证（2026-11-02）

- 策略：纯规范，不适用业务 TDD；不把文档校验当实现或真实用户验收。检查范围为本 change、design/20、两份交接输入及必要跟随文档，共47个 Markdown 文件。
- `bun x --no-install openspec validate refactor-assistant-capability-authorization --strict`：目标 change 通过；`bun x --no-install openspec validate --all --strict`：10项通过、0失败。
- `bun run format:check`：首次发现3个文档格式问题，经既有 `bun run format` 修正后通过；`git diff --cached --check` 通过。
- 仓库外一次性文档检查：6个 capability、31条 requirement（20 modified / 11 added）、91个场景；MODIFIED原标题均匹配主spec，新增无重名，每条2–4个WHEN/THEN场景且有D/A映射；实际OpenSpec CLI同样解析出31个增量，不只检查Markdown外形。
- 新增/变更行的98个本地文档链接及锚点存在；暂存范围仅文档，凭据模式扫描未命中。未纳入业务代码、迁移、配置、缓存、产物或本机调度台账。
- 人工合同核对：接续复用conversations行接纳锁；入站幂等有效24小时，不冒称永久重放；task批准24小时不泛化到文档；新自然目标不要求TS入站语义分类，wall动作缺规则零该动作效果，legacy预检保持。
- 未跑 `verify`、typecheck/unit/contracts/integration/scheduler、模型/数据库/Web/native/MCP或部署：本阶段只定合同且明确不运行业务，未实施能力保持未验收，五门由CI/后续实施按原门槛举证。

### 外部交付（2026-11-02）

合同提交 `512df82` 已推送 `docs/105-spec-assistant-delegation`；[Draft PR #106](https://github.com/BqLee-AI/Along-agent/pull/106) 关联 Refs #104/#105/#90，[#105 交付评论](https://github.com/BqLee-AI/Along-agent/issues/105#issuecomment-6576836156) 已发布。本节补记外部交付，不改变前述31条合同；后续实施/业务验收未执行，不归档、不合并、不关闭或自动建后续议题。
