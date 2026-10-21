# v0-safety-contract：显式审批修改增量 [Proposal]

本delta仅为#31契约草案，合入并archive前不修改主spec。字段/路由/DDL不在spec复制；真源引用 `docs/design/06-approvals-confirmation-gate.md` §9、`docs/api/approvals/approvals_routes.md` §6 与 `docs/schema/commitments-schema.md`“审批修改持久化增量”。以下R编号对应design/06 §9.6及tasks。

## ADDED Requirements

### Requirement: 明确目标的完整修改与重新确认

系统 SHALL 只通过design/06 §9.1–§9.2定义的显式修改动作，替代本人有效pending create_task提议；新提议冻结完整内容/时间和重新计算的回显hash，旧提议只变superseded，修改不等于确认，也不推断同会话其他pending为修改目标。

#### Scenario: R1 完整修改仅产生新待确认提议

- WHEN owner对有效目标提交完整且可唯一归一的内容
- THEN 原子形成旧superseded与唯一新pending，新详情冻结新回显/hash且指向旧项，修改及重放均零task/task_events/outbox/notification；同会话独立新建不自动替代（A2/D2/D8）

#### Scenario: R2 严格body和不可归一输入

- WHEN 修改缺必选字段、包含非法类型/null/超界/未知字段，或完整内容仍缺必要信息/模糊
- THEN 依API §6返回既有VALIDATION_ERROR，无新提议/替代；fold省略仅等价none，不能替用户猜歧义或补账户/会话默认内容（A2/D6）

#### Scenario: R8 新提议必须重新按钮确认

- WHEN 用旧确认键或新键确认已superseded旧项，或展示输入已改变后用旧hash/旧所见确认新项，再以新详情三件套重复按钮确认
- THEN 旧项409 APPROVAL_SUPERSEDED，新项旧展示409 PRESENTATION_MISMATCH，错误均零task；正确新确认只产生同一task及既有单事务结果，不因修改自动确认（A2/D3）

#### Scenario: R8 相同展示仍可按新详情重新确认

- WHEN 合法修改产生与旧项相同的canonical presentation，客户端读取新ID详情并重新按钮确认
- THEN 沿既有v1允许相同hash及相同所见值，不因来源相同拒绝；旧ID仍因superseded不能确认，新ID重复确认只产同一task，不引入盐或额外无变化校验（A2/D2/D3）

### Requirement: 修改边界不得越权或改变冻结时间权威

系统 SHALL 按design/06 §9.2、§9.4与API §6执行既有session/CSRF/UUID/owner错误边界，使用#30/A4公共时间上下文与纯归一用例，不复制fixture/alias/解析，不在Web算UTC或以修改重算旧冻结任务。

#### Scenario: R3 安全边界先于任何持久写入

- WHEN 未认证、CSRF不符、路径非UUID/不存在，或actor修改他人目标
- THEN 沿用401/403/404/403及既有numeric/symbolic envelope；不产生幂等预约、替代或task，不暴露他人successor/task，亦不将他人pending顺路写expired（D6/D8）

#### Scenario: R2 共享时间失败不废旧项

- WHEN 共享入口判定不存在/重复未选/未知时区或别名/规则不可用或超批准范围
- THEN 按A4公共合同分别返回422/503与既有码及结构化歧义候选，不静默回退；旧项不supersede、新项/task不创建，允许已接受请求的预约留存；公共规则不可用不阻断已有冻结详情、确认、执行或取消（A4/D1/D6）

#### Scenario: R11 真实详情入口明确编辑再回显

- WHEN owner在真实Web的有效pending create_task详情修改完整内容/显式时区，必要时选择服务端fold候选并提交
- THEN 客户端保留未决body/键以安全重试，修正输入才换键；失败保留旧项/输入，成功读取新详情显示真实状态和新回显再按钮确认，不算UTC、不自动confirm、不将本地持久记录宣称必达（A2/D2/D10）

### Requirement: 修改幂等与首次持久时间跨重启成立

系统 SHALL 依design/06 §9.3将修改键、目标、规范请求摘要、首次持久接收anchor及可空结果关联存于approvals自有最小持久映射；安全/结构/owner通过后才预约，完成结果优先重放，保留期不以自动清理释放键，禁止借outbox或conversation幂等表。

#### Scenario: R4 同键重放与不同请求冲突

- WHEN 同owner同键以同请求（包括fold省略/none等价）重复或并发修改，或以异body/跨目标复用该键
- THEN 同请求成功只关联同一新提议，后续200 duplicate=true；异body/跨目标409 STATE_CONFLICT且不返回其他目标结果；不同owner独立，不用confirm/reject的键误命中revise（A2/D3/D6）

#### Scenario: R5 预约后死亡或成功响应丢失

- WHEN 首次持久预约后、替代前进程死亡，或替代结果已提交但响应丢失并重启重试，且重试跨本地午夜
- THEN 前者沿原持久anchor恢复，后者重放同关联而不重归一；相对表达不被原会话/重试/客户端时间改义；预约提交前未被服务端接受的请求不被谎称已有可恢复到达时间（A2）

#### Scenario: R5 成功后状态变化仍只回原结果

- WHEN 同请求成功后其新项已消费、过期或再次被替代，或者当前规则不可用，原请求再次到达
- THEN 返回原旧/新ID与duplicate=true，不假称当前仍pending、不重建后继/重算/延寿；详情读取现状态，当前request_id不冒充首次调用ID（A2）

### Requirement: 替代原子性与锁后有效性一致

系统 SHALL 按design/06 §9.3–§9.4将新pending、旧superseded和成功结果一次提交，以同一目标行锁与confirm/reject串行化；获得锁后及写入前使用DB实际当前时间核对有效期，不用事务起始时间或冻结anchor充当现在。新迁移唯一后继约束禁止分叉。

#### Scenario: R6 修改与确认或拒绝竞争

- WHEN revise与confirm或reject竞争同目标，各自可能先获锁提交
- THEN 修改先赢时旧confirm/reject均409 APPROVAL_SUPERSEDED；confirm先赢时修改409 STATE_CONFLICT并保留原task语义，reject先赢时修改409 STATE_CONFLICT；不自动取消task、不创建失败替代（A2/D3）

#### Scenario: R6 两次修改及后继再次修改

- WHEN 两个不同键竞争修改同旧项，或用户后续明确修改已生成的pending后继
- THEN 同旧项仅一个直接后继，落后请求409 APPROVAL_SUPERSEDED；后继再改需显式以该ID为目标，形成单链而非重复修改旧前驱；cancel_task和rejected/consumed非可修改状态沿既有STATE_CONFLICT（A2/D3）

#### Scenario: R7 等锁或归一期间到期

- WHEN confirm/reject/revise等待目标锁期间expires_at或fire_at到期，或修改归一后写入前旧项/新目标时刻已过
- THEN 依API §6返回410 APPROVAL_EXPIRED，旧pending到期须正常提交expired后返回错误；不因抛错回滚该状态，不建新task/后继，不因锁前曾有效而放行（A2）

#### Scenario: R9 业务故障全回滚并保留可恢复预约

- WHEN 新项插入、旧state更新或结果关联填写任一步失败，或试图直接插第二个同前驱后继
- THEN 三项业务改动全回滚而已提交预约保留原anchor可恢复，数据库唯一约束拒绝重复后继；不产生无后继superseded、双替代或task，非预期DB错误脱敏500而不伪造成功（A2/D3/D4）

### Requirement: 修改契约通过受控迁移及真实证据收口

系统 SHALL 依design/06 §9.5–§9.6仅用新迁移部署修改能力，保留已有迁移和业务行，按独立契约→实现→真实验收→review→archive顺序交付，不把合同草稿或预置superseded测试当作A2完成。

#### Scenario: R10 干净库与脏后继迁移

- WHEN 在全新/已有干净库应用迁移，或预检发现重复、缺失、自指、跨owner、循环或非法关联后继
- THEN 干净库原子建立最小映射及唯一约束；脏库中止发布并保留原行待明确修复，不自动删除/改owner/state、不LIMIT 1掩盖（D3/D4/D7）

#### Scenario: R10 迁移或版本发布失败

- WHEN 迁移失败，或schema成功但新API/Web版本发布失败
- THEN 迁移事务全回滚且不暴露revise；版本失败保留additive schema/数据并受控恢复，无法满足新owner/锁后时限的旧版本不得恢复写流量，不以删表或独立新建静默降级（D4/D7）

#### Scenario: R11 独立合同与真实A2证据

- WHEN 提交合同PR或申请关闭#31
- THEN 合同只Refs且经独立review、精确head固定五门SUCCESS和CLEAN后才实施；关闭前有真实详情修改/旧确认拒绝/新回显确认单task及重试竞争证据、独立代码和证据review与archive，保留D1–D10和固定工具版本；未覆盖项不得写已收口（A2/D6/D10）
