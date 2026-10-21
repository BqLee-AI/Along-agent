# A2 显式审批修改：设计导航 [Proposal]

Issue: #31

本 change 是独立契约草案，不含实现。详细字段/事务设计真源已集中在 `docs/design/06-approvals-confirmation-gate.md` §9，API §6 和 schema“审批修改持久化增量”；本文件只说明关键因果和实施顺序，不建立第二套规则。Observed依据、R1–R11验收矩阵均见design/06 §9.1、§9.6。

## 关键选择

1. **显式 action 而非猜会话目标。** 目标ID、owner、行锁与替代关系都归approvals；不让conversation run/checkpoint承担跨阶段替代原子性。只支持有效pending create_task，普通新建不替代，已消费提醒继续取消/重建。
2. **先持久预约，再原子替代。** 单一事务最终保存结果不足以恢复“预约接收后、替代前”死亡时的相对anchor；因此仅将owner+键、目标、请求摘要、接收anchor独立短事务提交。替代事务同时插新项、标旧superseded、填同表结果。NULL结果就是可恢复未完成状态，不另造通用作业/状态机。
3. **owner+操作+键，不按目标分键空间。** 同键跨目标返回既有STATE_CONFLICT，避免错误重放另一条结果；同键同请求完成后不重归一、不再检查旧pending。结果只返回旧/新ID及duplicate，新详情是当前状态和冻结回显真源，不冻结一个会过时的pending DTO。
4. **数据库兜底唯一后继。** 0003已有supersedes字段，缺的是唯一约束；新增迁移而不改旧SQL。预约表归approvals，不借outbox、跨模块幂等表或内存缓存。新迁移与表保留是持久重试所需的最小成本。
5. **共享时间用例，不在approvals造解析器。** 依赖#30/A4的应用上下文和`classifyEntry/normalize`边界（design/05 §5.2、§9.1）；显式UTC持久anchor/时区/fold输入，统一typed失败与两候选。规则/alias/可用性所有权不迁到approvals。旧项有效性在锁后和提交前取DB实时时刻，不拿冻结anchor当现在。
6. **不伪造新hash算法。** 重新计算现有canonical v1，不加UUID/随机盐；相同presentation可得到相同hash，不新增无变化拒绝规则。新项必须读取新详情重新按钮确认，旧目标因superseded不能再确认；真正改变展示输入时旧展示不能确认新项。

## 所有权与失败边界

HTTP负责session/CSRF/UUID/严格body和envelope；approvals用例拥有owner、键匹配、锁序、时限、唯一链与事务；A4公共用例拥有规则和归一；Web只编辑输入、保留未决body/键、显示服务端候选并读取新详情，不算UTC或自动确认。

认证/CSRF/结构/ID/owner失败不建预约，绝不顺路写他人expired。已预约的业务失败可以保留anchor，且锁后到期可以正常提交expired再返回410；不把“零task”夸成“零持久写入”。替代三项失败则全回滚，未完成预约仍可恢复；未知异常保留脱敏500，不吞错伪装冲突。

锁序为预约→目标，confirm/reject只锁目标；不同键竞争同目标由同一行锁串行化，唯一索引防分叉。先赢者决定终态，旧superseded先于旧confirm幂等/展示检查；已consumed重复确认回原task保持不变。到期、并发和错误矩阵见design/06 §9.4。

## 实施与发布顺序（全部待做）

- 独立契约review、精确head五门SUCCESS、CLEAN后合入，PR只Refs #31。
- A4公共接口合同与实现可用后接入A2；不得以fixture副本跳过依赖。
- 先完成owner后/锁后时限共享修正，再完成新迁移、预约/替代用例、路由与Web；测试按R1–R11覆盖，保留既有预置superseded用例但不能冒充生产修改证据。
- 受控停写，备份/只读检查既有链；脏数据停止，不自动删除或修状态。新迁移事务失败全回滚。schema成功后才上线新版本；版本失败保留additive表和数据，若旧版本不满足新有效性规则则保持停写前滚修复。
- 真实session/CSRF/API/Web完成旧详情→修改→新回显→旧确认被拒→新确认单task与同键恢复；独立代码/证据review后archive，收口才Closes #31。

## 验证声明

本次仅只读核对源码/既有测试/schema并起草合同；未运行OpenSpec validate、build、lint、tests、formatter、迁移、HTTP或真实Web验收，也未进行Git/外部操作。待主线程在合并前统一运行既定验证；R1–R11均为待执行验收，不写成通过。
