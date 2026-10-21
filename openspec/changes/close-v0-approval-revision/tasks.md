# close-v0-approval-revision 任务

> Issue: #31。合同PR仅 `Refs #31`；只有实际验收、review、archive完成的收口PR `Closes #31`。勾选仅代表合同起草，不代表批准、实施或验收。

## 1. 独立契约

- [x] 1.1 只读核对创建/详情/confirm/reject/expiry/schema/错误与Web，记录Observed和Proposal边界（design/06 §9.1）。
- [x] 1.2 起草显式revise的API、owner/UUID/body/错误优先级、完整回显/新关联与A4共享接口依赖（API §6；design/06 §9.2、§9.4）。
- [x] 1.3 起草持久anchor、同键重放/冲突、原子替代、唯一后继、新迁移和发布失败/脏链规则（design/06 §9.3–§9.5；schema增量）。
- [x] 1.4 起草对应行为delta与R1–R11测试/真实验收计划，不修改主spec。
- [ ] 1.5 主线程同步保留所有权的PRD/API/文档索引与业务端点清单，交叉核对#30共享接口。
- [ ] 1.6 独立review，OpenSpec 1.3.1严格校验及精确head固定五门SUCCESS/CLEAN后合入合同；此前禁止实现。

## 2. 实施（合同合入后）

- [ ] 2.1 接入#30/A4公共时间上下文/用例及结构化失败，不复制fixture/alias/解析。
- [ ] 2.2 新增迁移（编号按合入顺序）：唯一后继和approvals自有最小预约表；不改旧迁移。
- [ ] 2.3 实现owner后预约、首次持久anchor、规范摘要匹配、预约→目标锁序及已完成重放。
- [ ] 2.4 实现INSERT新pending/旧superseded/保存结果单事务，以及confirm/reject/revise锁后实时时限/到期正常提交后返回410。
- [ ] 2.5 接通严格JSON路由/envelope与详情Web完整编辑、稳定重试键、fold候选、成功跳新详情重回显再确认。

## 3. 变红测试与A2验收（全部待执行）

- [ ] R1：生产修改新ID/关联/hash/回显；修改零task/created/outbox/notification；同会话正常新建不替代（A2/D2/D8）。
- [ ] R2：四字段必选/可选、边界/null/额外字段；不完整内容和typed时间错误；A4共享上下文/候选/缺规则，已完成重放无需规则（A4/D1/D6）。
- [ ] R3：双跑认证/CSRF/非法UUID/404/403和完整失败envelope；他人状态/后继零泄漏、零写入（D6/D8）。
- [ ] R4：同键同body与fold缺省等价重放；同键异body/跨目标409，跨owner隔离，键并发（A2/D3/D6）。
- [ ] R5：预约提交后重启、成功后响应丢失重启、跨午夜重试anchor不漂；后继已消费/过期/再次替代仍回原关联（A2）。
- [ ] R6：revise/confirm、revise/reject两种获胜顺序、两键修改只一个后继及显式后继再改（A2/D3）。
- [ ] R7：expires_at/fire_at锁等待到期和归一过程中到期；三action一致410、持久expired、零新task/后继（A2）。
- [ ] R8：旧键/新键确认旧项409 superseded；展示实质变化后旧材料不匹配409；相同presentation的新详情合法确认；新三件套双击回同task（A2/D3）。
- [ ] R9：替代三项各失败点全回滚、预约保留可恢复；直接双写后继23505；既有数据库完整性门不降级（A2/D3/D4）。
- [ ] R10：新库/已有干净库迁移；重复/跨owner/缺失/非法链中止且行不删；迁移和版本失败的受控恢复（D4/D7）。
- [ ] R11：真实session/CSRF/Web详情→完整修改→新回显→旧确认被挡→新确认单task；未决键重试、候选选择及失败旧项保留证据（A2/D2/D10）。
- [ ] 3.12 保留D1–D10与Bun 1.4.2/OpenSpec 1.3.1；精确最终head的static、migration-scan、scheduler-fault、contracts-dual、compose-smoke五门SUCCESS，包含既有取消与调度安全回归（D5/D9不因本change降级）。

## 4. 收口

- [ ] 4.1 保存真实A2的脱敏HTTP/ID/SQL/Web/版本证据并判定旧#26证据适用范围，不重开未受影响的brief/通知/取消。
- [ ] 4.2 独立代码与证据review；精确head五门SUCCESS和CLEAN，未决/缺证据不得标完整v0收口。
- [ ] 4.3 archive本change，合入delta至主spec并同步索引；仅收口PR `Closes #31`。

实际验证：本契约起草阶段未运行任何build/lint/tests/formatter/OpenSpec验证/迁移/真实验收；未执行Git或外部操作。
