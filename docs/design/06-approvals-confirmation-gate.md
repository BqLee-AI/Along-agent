# 06. 确认门一等公民（approvals）

## 文档状态

- **状态**：设计真源（design 为真源，prd 跟随）
- **范围**：approval 对象、快照冻结、状态机、确认规则、presentation_hash 幂等消费、显式完整修改、持久预约和唯一后继
- **不包含**：task 调度触发细则（见 08）、事件账词汇（见 07）、time-core 归一（见 05）；实现代码
- **阶段标签**：v0 / P0（P1 起为三差异化之首常驻）

## 引用

- B06 §5 确认与 C 草稿；B03 §4.3 HITL；B02 §2.9 HITL；AF checkpoint 思想

## 0. 设计结论

- [Required] 确认门是 v0 唯一“点头”：confirm 之前无 task、无排期；草稿只是 approval(pending)。
- [Required] v0 只认确认按钮；整句文本确认不参与意图解析（S0 #14，见 §4）。
- [Required] 确认绑定三样：`approval_id` + 当时看到的完整内容 + `presentation_hash`；对不上即 PRESENTATION_MISMATCH。
- [Required] 批准消费与创建任务或取消请求保持受控单事务；同步公共用例/只读投影/异步 outbox 的适用范围见 02 §1–§2。

## 1. approval 对象（字段到名）

```text
Approval
  approval_id        UUID，永不复用（短号仅定位、不授权）
  owner_id           归属
  original_text      用户原话（原样存）
  fire_at_utc        time-core 输出（触发依据）
  timezone_id / local_datetime / fold / resolved_utc_offset_seconds
  tzdb_version / presentation_version / presentation_hash
  occurrence         single（v0 只单次）
  status             pending | consumed | rejected | expired | superseded
  consumed_task_id   消费产出的 task（重复确认回它）
  supersedes_approval_id（新行指向旧行；后继反查，不存双向字段）
  created_at / expires_at（24h 起步值，待校准）
```

- [Required] 除 `state / consumed_task_id` 外快照建后冻结；展示层只读冻结字段。上表 `status` 是 API 名，数据库列为 `state`。
- [Proposed] 过期顺路清（启动/读取/确认时），不另养后台进程；过期清内容留号 30 天。

## 2. 快照与回显

- [Required] 回显模板普通版：“请确认 A-0051：你说‘明天 9:20’，我将它归一为 2026-10-17 09:20（Asia/Shanghai），设为单次提醒；确认前不会创建正式提醒，也不会排期。”
- [Required] 歧义选第二次版：“原话‘2027-11-07 01:30’，按 America/New_York 选择第二次出现的 01:30（UTC−05:00），单次提醒；确认前不会创建正式提醒或排期。”
- [Required] 显式选第一次的新提议冻结 `presentation_version=v2`：“原话‘2026-11-01 01:30’，按 America/New_York 选择第一次出现的 2026-11-01 01:30（UTC−04:00），单次提醒；确认前不会创建正式提醒或排期。”创建器只在结构化 first 选择且归一结果 `fold=0` 时选用此模板；普通提议、第二次与取消仍冻结各自既有 v1 模板，不新增 `fold_choice` 持久列。
- [Required] 模板带版本，approval 冻 `presentation_version`；旧 approval 用旧模板直到过期；语言是独立维度，切语言重生成重确认；旧模板有显示 bug → 作废旧 approval 重来，不悄悄替换。
- [Required] 新 first 模板不套用于旧 v1 行。已确认有次数/偏移展示缺陷的旧提议须拒绝后重新提议，或按显式修改生成后继；保留旧冻结字段、版本及原回显，不用读取/部署过程悄悄补写。修复不重算已建 task。
- [Required] 摆错了（回显 09:20、快照 10:00）→ 暂停待核对，不建不排；快照自洽不过（墙上+时区+偏移推不出 UTC）→ 待修复，换新 approval 重来，旧转墓碑。

## 3. 状态机 [Required]

```text
pending -> consumed（confirm 单事务，建出 task）
pending -> rejected（reject）
pending -> expired（超 24h 起步值或目标已过）
pending -> superseded（被新 approval 替代；改字段重回显，旧键作废）
```

- [Required] 事务内验三样：owner 一致、status=pending、`now < expires_at`；迟到确认按过期/被替回话。
- [Required] 两条 pending 躺着、光说“确认”不指明 → 挡回，请指明一条。
- [Required] 23:50 摆的日期，00:05 点头还是那一天（冻住的不重算）；超 24h 或目标已过旧确认作废。

## 4. 确认规则 [Required]

- v0 只认点确认按钮（S0 #14 冻结：整句“确认 A-XXXX”文本只做展示，不做意图解析；文本确认能力延 P1，届时补意图→confirm 路由与多 pending 消歧契约）；“好/嗯/行”不算。
- 确认请求带三样：路径 `approval_id` + 当时看到的完整内容 `seen_content` + `presentation_hash`（规范编码：排版空格不算，原话空格算，时间先归一再编码；三件套缺一即 `400 VALIDATION_ERROR`）。
- 服务端按快照重建预期比对，对不上 → PRESENTATION_MISMATCH，停在待核对。
- 连点两次只回同一个 task：“这是重复确认，没有新建第二条。”（幂等键 + consumed_task_id 双保险）
- 多条待确认必须指明；改字段重回显，旧键作废（superseded）。

## 5. presentation_hash + version [Required]

```text
presentation 输入
  original_text（原样，空格算） + 归一本地时间 + timezone_id + fold/偏移
  + occurrence + presentation_version
  排版空格不计入；时间先归一再编码
```

规范编码算法（v1，实现唯一真源 `apps/api/src/modules/approvals/presentation.ts#computePresentationHash`）：

- 字段按序取 `[domain, presentation_version, original_text, local_datetime, timezone_id, fold, offset_seconds, occurrence]`，其中 `domain = "along-presentation/v1"`，`local_datetime` 为 time-core 归一后的 `"YYYY-MM-DD HH:mm"`，`fold` 为 `"0"|"1"`，`offset_seconds` 为十进制秒数，`occurrence` 为 `"single"`。
- 每字段做长度前缀 `len(bytes):bytes`（UTF-8 字节数），直接拼接（无分隔符）得 canonical。
- `hash = "ph_" + sha256(canonical, hex)`。模板排版空白永不进 hash；`original_text` 逐字节精确。
- first 的 v2 是回显内容版本，不另改规范编码域：仍用 `along-presentation/v1` 算法，第二字段按冻结值编码 `v2`。读取和确认均使用行内 `presentation_version`；不能拿当前默认 v1 重算新 first 的 hash，也不能接受缺少次数/偏移的旧普通模板作为 v2 的 `seen_content`。未知版本仍拒绝确认。

## 6. 受控同事务（创建与取消）[Required]

- 同一事务：验 owner/pending/有效期 → 比 hash → 建 task(saved) → 写 task_events.created → 写 outbox → approval→consumed。
- cancel_task 分支：同一冻结确认门校验后，经 tasks 公共取消用例提交取消状态/事件/旧工作失效/取消命令并消费批准；不得拆成消费后异步请求取消。撤销回执前仍是 cancel_pending，consumed 不等于已撤销外部效果（07/08）。
- 任一步失败全回滚；对外只说“没记上”，不报成功。

## 7. 展示只读 [Required]

- 展示层只读冻结字段做固定格式呈现，不换算、不推断、不改写。
- 确认按钮上方常驻短告知（起步文案，待校准）：“提醒保存在云端；到点在调度器成功运行时尝试通知。设备关机、休眠或进程未运行时可能错过，不保证准时响。”

## 8. 错误码

| 错误码                | HTTP | 含义              |
| --------------------- | ---- | ----------------- |
| PRESENTATION_MISMATCH | 409  | 摆与存对不上，停  |
| APPROVAL_EXPIRED      | 410  | 超 24h 或目标已过 |
| APPROVAL_SUPERSEDED   | 409  | 已被新确认单替代  |

## 9. 显式修改待确认提议 [Required，#31]

本节定义修改的合同，不代表运行验收通过。契约、实现与真实验收证据分开记录；独立 review、精确 head 五门 SUCCESS/CLEAN 与 OpenSpec archive 遵循既有流程，D1–D10 不变。

### 9.1 已观察到的边界与目标

- `approvals/create.ts#createTaskApproval` 只 INSERT pending，不替代旧项；`repository.ts#findSuccessorId` 目前 `LIMIT 1`，不是唯一性约束。
- 迁移 0003 已有 `supersedes_approval_id`，没有 `superseded_by_approval_id` 或后继唯一约束。详情 `service.ts#detailOf` 将前驱投影为已有 `recreated_from`；HTTP 详情未输出内部 `successorId`。
- `confirm.ts` 已识别 superseded，并使用 `409 APPROVAL_SUPERSEDED` / `details.successor_approval_id`；现有相关 PG 用例是预置替代链，不是生产修改入口。
- confirm/reject 现先在事务外按 DB `now()` 顺路过期，再加行锁，锁后不重新比较时限；本 change 必须修正等待锁期间过期的缺口，且 owner 校验前不得写他人到期状态。
- Web `ApprovalActions.tsx` 只有 confirm/reject，每次点击生成新键；本 change 增加独立修改提交及稳定重试键，不改变已 consumed 重复确认回原 task 的语义。

目标是**明确修改一个本人、有效、pending、create_task approval**。已建 task 的改期仍走取消/新建；cancel_task 不可修改。普通同会话新建提醒不自动 supersede 任一 pending，`card_ref` 不是修改授权。

### 9.2 HTTP、时间与展示所有权

唯一入口为 `POST /api/v1/approvals/{id}/actions/revise`，JSON body/成功 envelope/错误表见 `docs/api/approvals/approvals_routes.md` §6。提交完整 `raw_text` 与显式 `confirmed_timezone`，不接受 patch，也不从旧会话、账户默认或原提议暗补缺失内容。旧 `conversation_id` 可原样继承用于关联，但不创建 conversation/message/run。

应用层注入 **#30/A4 公共规则上下文及归一用例**（`docs/design/05-time-core.md` §5.2、§9.1），消费同 readiness 的实际规则、alias、版本、支持范围和可用性判定，再由公共用例调用现有 `classifyEntry → normalize`。这是实施依赖，不在 approvals 复制 alias、正则、支持范围检查或硬编码 `FIXTURE_V1`，也不预设一个尚不存在的函数名。time-core 保持零 I/O；公共用例接受显式 UTC anchor/receivedAt、原文、timezone 与 fold，并保留 typed 时间错误及结构化 candidates。普通缺年/缺时段/模糊表达在此非 SSE action 返回既有 `400 VALIDATION_ERROR`，要求完整重述；时间四错不伪装成功澄清。AMBIGUOUS details 及其他时间错误省略details的规则只引用 A4 §9.1，不建立 A2 私有变体。

修改的相对时间锚点是**本次修改的首次持久接收时间**，不是原会话 anchor、客户端时钟或每次重试当前时间。先通过认证、CSRF、结构、目标存在及 owner 校验；首次有效接收将 DB `clock_timestamp()` 写入幂等预约并独立提交，此提交是服务端接受该修改请求的线性化点。提交前死亡不算已接受；不承诺恢复尚未持久的 socket 到达时间。预约提交后即使业务事务开始前死亡，重启同键仍使用原 anchor；不会跨午夜把“明天”改为另一天。相对解析的 `anchorReceivedAtUtc` 与用于跨日检测的 `receivedAtUtc` 均取该冻结 anchor，不传重试时钟；当前可执行性仍另用锁后 DB 当前时间判定。

新快照使用现有 v1 规范重新计算 `presentation_hash`、生成新 ID/回显、冻结版本及归一字段；插新项时显式取锁后 DB `clock_timestamp()` 为 `created_at`，`expires_at=该时刻+24h`，不沿用预约时间或事务起点的 `now()`。hash 不加 ID、不加随机盐；相同 canonical presentation 可以得到相同 hash，不为制造不同 hash 拒绝合法输入或修改算法。旧项 frozen 字段不改。新详情 `recreated_from=旧id`，新项再确认必须读取新详情，带该详情 hash 和完整回显；旧目标仍因 superseded 不可确认。

### 9.3 最小持久幂等与事务

选择 approvals 自有 `approval_revision_requests`，固定操作即 revise，主键 `(owner_id, idempotency_key)`；目标 **不进主键**，因此同 owner 同键跨目标一律 `409 STATE_CONFLICT`，绝不误重放另一个目标。同键同规范请求返回同一新 approval；同键异 body 同样冲突。不同 owner 的键隔离，confirm/reject 键命名空间不变。

规范请求摘要为 SHA-256：以 `along-approval-revise/v1` 为 domain，对顺序固定的 `[domain, target_approval_id, raw_text, confirmed_timezone, fold_choice]` 做 §5 相同 UTF-8 长度前缀编码。UUID 规范小写；fold 缺省与显式 none 相同；其余字符串逐字节、不 trim、不 Unicode 归一；JSON 字段顺序无关。不存原始请求副本，也不借 outbox 或 conversation_idempotency 表。表字段及约束见 schema `approval_revision_requests`。

执行顺序固定：

1. 按 §9.2 校验边界，再插入或读取预约。唯一键竞争等待已提交预约；目标或摘要不符返回冲突，不改预约。无效认证/CSRF/body/ID/owner 不留预约且不写业务表。
2. 业务事务先锁预约，再锁目标 approval（`FOR UPDATE`）；所有 revise 都按同序。完成预约直接重放已存新 ID，不重归一、不检旧项 pending、不受新规则缺失或后继后来 consumed/expired/superseded 影响；只返回关联，不把旧成功描述成当前仍 pending。
3. 未完成预约：目标锁后再次核 owner，按 §9.4 检查 kind、状态和有效性。使用**获得锁后的 DB `clock_timestamp()`**，不能用事务起点固定的 `now()`。完整归一后、写入替代之前再读当前 DB 时间，旧项或新触发时刻在处理期间到期也拒绝。
4. 单一 approvals 事务 INSERT 新 pending（同 owner，`supersedes_approval_id=旧id`），旧项改 `state=superseded`，预约填 `successor_approval_id`。任一步失败全回滚这三项，不会出现无后继 superseded 或双后继。预约本身仍保留原 anchor/摘要，可供同请求恢复；不把预约误报为修改成功。
5. 修改本身以及成功重放均不创建 task、task_events、schedule/send outbox 或 notification，不消费新项。唯一建 task 入口仍为按钮 confirm 的既有单事务。

v0 不自动清理预约，不设短 TTL 或键复用窗口。预约与关联审批标识在有效服务数据生命周期内保留，即使以后审批正文变墓碑也保留键、摘要、anchor 与结果关联；无原文副本。删除/账号清理策略不在本 change，后续若引入必须先修订重放合同，不能自动删键后当作新请求。

### 9.4 错误优先级、锁后到期与竞争

顺序为认证 → CSRF → 路径 UUID → body → 目标存在/owner → 幂等匹配/已完成重放 → 未完成请求的 kind/state/时限 → 时间内容/展示变化 → 原子替代。非法 UUID 与不存在同为 `404 NOT_FOUND`；他人为既有 `403 FORBIDDEN`，不返回 successor/task，也不把其状态改 expired。body 字段全部约束见 API §6。

未完成请求的 `cancel_task` 为 `409 STATE_CONFLICT`。create_task 的 terminal 优先顺序：superseded→`409 APPROVAL_SUPERSEDED`（唯一 successor）；consumed→`409 STATE_CONFLICT`（本人可带既有 `details.task_id`，提示用取消）；rejected→`409 STATE_CONFLICT`；expired 或 pending 且 `expires_at <= clock` / `fire_at_utc <= clock`→`410 APPROVAL_EXPIRED`。已完成的同请求重放优先于这些旧状态。

confirm/reject/revise 必须共用 owner 后、锁后有效性规则；terminal 语义保留（consumed confirm 仍重复回原 task，rejected reject 仍重复成功）。发现 pending 到期时，将 expired 更新作为**正常事务结果提交后**在外层转 410，不能 throw 导致到期更新回滚；没有新 approval/task 等业务副作用。GET 继续只读 effective-status 投影，不借读取落库。未知 DB 错误沿用脱敏 `500 INTERNAL_ERROR`，不吞错、不伪造冲突；唯一后继冲突重新 owner-safe 读取真实状态/后继，不能随机选一个。

| 先提交者               | 后执行者的确定结果                                 | 不变量                                                         |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| revise                 | 旧 confirm（旧键或新键）、旧 reject、不同键 revise | 409 APPROVAL_SUPERSEDED，返回同一 successor；旧项零 task       |
| confirm                | revise                                             | 409 STATE_CONFLICT / 原 task 引用；无替代，不自动取消          |
| reject                 | revise                                             | 409 STATE_CONFLICT；无替代                                     |
| 同键 revise            | 同键同请求 revise                                  | 200 同 successor，后者 duplicate=true；只归一/落地一次成功结果 |
| 不同键 revise A        | revise B                                           | 仅 A 成功；B 409 APPROVAL_SUPERSEDED，不另建后继               |
| 持锁者释放时旧项已到期 | 等锁 confirm/reject/revise                         | 410，持久 expired，零新 task/后继；用真实锁等待回归            |

旧项 superseded 检查先于旧 confirm 幂等查找/展示校验，所以旧确认键不能绕过状态。新项确认材料与新详情不匹配时为既有 `409 PRESENTATION_MISMATCH`；只有相应展示输入已变化时才能断言旧材料必不匹配，相同 presentation 可复用同一 hash/所见值。无论是否相同，客户端仍读取新 ID 详情并由用户重新按钮确认。后继也可显式 revise，但目标必须是该 pending 后继 ID，形成单链，不能再次修改已 superseded 前驱。

### 9.5 迁移、部署与恢复

仅新增迁移：增加非空 `supersedes_approval_id` 唯一索引和 approvals 自有预约表；编号按实际合入顺序分配，不修改 0003/0011 或预占 A3/A4 编号。迁移前只读检测重复后继、缺失前驱、自指、跨 owner、前驱非 superseded，以及不合法的 create_task 替代链；任何脏数据停止发布、保留原行并交给明确的数据修复方案，不 LIMIT 1 掩盖、不自动删行或改 owner/state。

采用受控停写发布：先停旧 API 写入/确认入口，备份和检查，事务性应用新迁移，再切换满足本合同的新 API/Web 后恢复流量。不混跑旧/新修改写者。迁移失败则事务回滚，保持旧版本和原始数据；schema 未成功不得上线 revise。迁移成功而新版本发布失败时关闭流量/撤回到旧版本（已有列和表为 additive，保留不用，不逆向删数据），在恢复旧确认写入前确认其锁后到期/owner 修正仍可用，否则保持停写修复前滚。不能因旧程序能启动就宣称新合同已生效；不静默回退改为普通新建。

### 9.6 实施与验收对应

以下均是待实施测试，不是已运行结果；OpenSpec delta 的 Scenario 编号与这里、tasks 对应。

| 编号 | 待验证行为                                                                                        | 位置/证据                                     |
| ---- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| R1   | 完整输入、新关联/回显/hash，修改零 task/事件/outbox/通知；同会话新建独立                          | approvals PG + 实际详情入口；A2/D2/D8         |
| R2   | 必选/可选、null/类型/边界/额外字段、普通澄清与四类时间失败；共享规则不可用但成功重放仍可读        | API 进程内/HTTP 双跑 + A4共享上下文；D1/D6/A4 |
| R3   | 未认证/CSRF/非法UUID/不存在/他人，错误 envelope 及无他人写入/泄露                                 | API双跑 + PG；D6/D8                           |
| R4   | 同键同body/默认fold重放、异body/跨目标冲突、跨owner隔离                                           | API双跑 + PG并发；A2/D3/D6                    |
| R5   | 预约提交后进程退出、成功提交响应丢失重启、跨午夜重试、后继终态后重放                              | 独立PG持久记录+API进程重启；A2                |
| R6   | 修改/confirm、修改/reject、两键修改的双向竞争与后继再修改                                         | PG锁控制；A2/D3                               |
| R7   | 锁等待跨expires_at/fire_at，及归一期间到期；confirm/reject/revise一致且持久expired                | PG真实DB钟/锁等待；A2                         |
| R8   | 旧目标确认被挡；实质改变展示后旧材料不匹配被挡；相同 presentation 合法新详情确认；新项双击同 task | API+PG及真实Web；A2/D3                        |
| R9   | 失败点回滚三项、预约可恢复、唯一后继约束直接拒绝重复                                              | PG故障回归+新迁移；A2/D3/D4                   |
| R10  | 新库/已有干净库迁移，脏链发布中止且行不删，迁移/版本失败恢复                                      | 迁移演练/发布记录；D4/D7                      |
| R11  | Web完整编辑/明确时区/fold，稳定重试键，失败保留旧项，成功跳新详情再按钮确认                       | 真实session/CSRF/Web/HTTP/SQL串联；A2/D2/D10  |

Web 只在本人 pending create_task 显示“修改这条提议”，预填原文/显式时区并允许完整重述；不计算 UTC、不替代确认。一次未决提交保留原 body/键（响应丢失重试不换键，必要时在本浏览器会话保存未决提交）；用户编辑、选择 fold 或修正失败输入后用新键。成功只按返回关联跳新详情并读取现状态，展示新回显/告知再确认；失败保留输入和旧详情，不乐观标 superseded，竞争错误指向真实 successor/task。规则缺失不妨碍已有详情读取/确认冻结数据或取消，A2 不重算旧任务。

## 10. 工具提议与已接受结果的原子边界

[Required] `tools/gateway.ts` 的 propose_task/request_cancel_task 在持久调用预约后，经同一 PoolClient 调用本模块创建/取得批准；批准、tool_invocations 接受结果和 tool_calls 审计同事务提交。结果/审计/COMMIT 失败全部回滚，原预约可重交；不能先提交批准、再另写结果。此边界不消费批准、不建 task，按钮 confirm 的创建/取消事务及真实回执门不变。

[Required] 批准结果账只保存原 approval_id 及 fireAt/hash/版本校验材料。`approvals/tool-result.ts#readFrozenToolApproval` 返回原冻结 CreatedApproval、回显、卡片引用与期限，不带动态状态或倒计时；批准进入 consumed/rejected/expired/superseded 后仍返回原引用，不延期限、不重算、不建替代。当前状态由详情接口另查，工具成功不承诺批准仍 pending 或任务已创建。

[Required] 同调用引用顺序/并发/丢回答重交只接受一次结果；合法新引用允许同参数新动作。取消提议继续复用既有 pending 批准的业务规则，两次新调用可以关联同一个批准，不能给 approval_id 强加唯一调用约束。调用账、当前权限遮蔽与迁移边界见 design/04 §3。

## 11. R1 文档授权（Proposed）

[14 §5–§6](14-r1-document-task-loop.md) 定义独立 `document_approvals`/`document_approval_decisions`、精确基线/完整目标预览、按钮授权、唯一 apply 绑定与确定零写冲突的新批准前驱。按钮不写文件、不建 task；approved 不是效果回执。旧 task 的 consumed、有效期、修改和创建/取消单事务保持原合同，不把文件 rename 塞进该事务。对文档的 apply 唯一约束不套用到既有可复用 pending task 批准的提议调用。
