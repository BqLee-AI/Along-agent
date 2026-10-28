## 1. Proposed合同与评审（独立OpenSpec-only）

- [x] 1.1 评审design/17的范围、owner边界、公开DTO、错误、分页/并发及旧数据语义；保持Proposed，不冒充实现。
- [x] 1.2 同步conversation/approval API、conversation schema、PRD与索引；design/17引用design02/14/16原合同，不作无必要改写，不改用户已有主规格/归档编辑。
- [x] 1.3 评审新增conversations capability及与agent-runtime/workspaces/identity的引用边界；确认#69六项验收覆盖。
- [x] 1.4 对合同草案执行openspec validate close-r1-conversation-history --strict并完成独立文档审查；非收口仅Refs #69。

## 2. 行为测试与实现（合同获准后）

- [x] 2.1 先为新strict query/DTO、cursor作用域/边界/微秒/tie、空/错误、原话与多Run表达可观察行为并取得有效Red，再实现；不以编译或环境失败冒充Red。
- [x] 2.2 新迁移增加查询必需索引，同步迁移扫描、#67版本核验和旧0017→新版本升级覆盖；保留所有旧迁移及owner/消息/Run事实。
- [x] 2.3 实现owner-scoped会话/消息/Run分页、Run点查与事件可选Run过滤，保持旧事件响应、默认limit、SSE和RunView。
- [x] 2.4 实现可信input引用和旧幂等引用只读关联，完整保留原文；缺失/非法引用明确反馈，不回填猜测关系。
- [x] 2.5 复用approvals公共决议为task详情补真实task/后继结果，共享strict schema替换重复消费者；document effect继续使用既有公共证据投影。
- [x] 2.6 交付Web列表→会话→指定Run→全部批准/结果及旧深链，覆盖所有分页、加载/空/局部失败/错误状态；历史回复不重复拼接最终assistant消息。
- [x] 2.7 接通#68安全401 returnTo、显式退出和登录后GET恢复；验证mount/back/分页/网络中断不补业务POST，迟到响应不污染新目标。
- [x] 2.8 为受影响公共用例、HTTP、Web真实消费者和真实PG补边界覆盖；复用现有snapshot过滤、唯一继续、unknown和撤权覆盖，不重复无价值底座测试。
- [x] 2.9 同步用户历史使用说明及本次实现证据，运行根脚本既有相关门并如实记录Red/Green、替代依据及未跑项。

有效 Red 的具体范围、其余行为覆盖及真实运行限制见[2026-10-28 验证记录](../../../../docs/conversation-history-verification-2026-10-28.md)。不是每个新增测试都先观察过 Red；事后覆盖不称为 TDD。

索引与聚合补证：原 47 场景 smoke 对应三索引状态；新增第四个 `conversation_idempotency(run_id)` 索引后，实际 PG16 查询计划从逐 Run 全账本扫描变为索引查找，历史响应与账本摘要相同，扩展后的 53 场景 smoke 全部通过。多 Run 单次事件聚合经旧新输出等价、隐藏文本零读取及实际 Web 验证；根校验 347 pass / 0 fail。版本边界、定向独立复核与未重跑项见验证记录；新提交五门证据记录在实现 PR。

## 3. 真实浏览器与真实PG16验收（独立于合同/单元通过）

- [x] 3.1 清空临时状态且不保留旧URL，正常退出并以同账户正式登录，从服务端列表找回指定会话和Run；不用seed、手工Cookie或助手指定ID。
- [x] 3.2 同会话多个Run/多个批准/多个attempt，原文含空白换行；跨越集合和事件多页恢复全部可见回复、所有批准及真实提醒/文档结果，不静默截断。
- [x] 3.3 验证同时间微秒/tie、新插入、旧Run更新、分页失败及刷新，符合明确的keyset与新事实可见性合同。
- [x] 3.4 跨owner发现/读取拒绝；system/internal snapshot与私有grant/root不外泄；空、不存在、无权、依赖故障和局部失败均可区分。
- [x] 3.5 在静止的隔离历史夹具上记录列表/打开/刷新/back/重登前后Run、attempt、批准决议、invocation/audit、模型/MCP调用和文件证据不增加；网络中断后无自动业务POST。
- [x] 3.6 原深链、Run和批准明细可读；撤销/改变workspace后历史与冻结效果仍可读，新确认/拒绝/继续/工具动作按当前授权拒绝；unknown不重写、不假报成功。

## 4. 门映射、独立审查与后续归档收口

- [x] 4.1 D1：检查Web仅用共享合同、模块公共读取及SQL owner边界；D8：真实公共/HTTP/strict消费者；D10：partial、approved/applied/verified/unknown真实口径。
- [x] 4.2 D3–D6：新迁移与已有唯一/只追加/冻结事实不变；D7：沿既有Compose门和#67升级验证持久化；D2、D9：复用既有展示禁算时间与取消/unknown回归，不虚称本issue新增时间/调度能力。
- [x] 4.3 保持static、migration-scan、scheduler-fault、contracts-dual、compose-smoke五门全部成功；A1–A4复用有效安全证据，只补历史打开真实消费者的缺口，不把#69当新的全链路时间/调度验收。
- [x] 4.4 实现与真实验收后开展独立审查，修复有效发现并核对六项验收证据及未覆盖限制。
- [x] 4.5 最后独立执行OpenSpec archive与归档校验，同步主规格/索引及任务证据；仅收口PR Closes #69并Refs #66，#66总路径仍由自身验收决定。

五门证据：质量修正提交 `8f7167b9c887e263eec0407f3beefcca35fdcaad` 的 [CI 40655581196](https://github.com/BqLee-AI/Along-agent/actions/runs/40655581196) 五门全部成功，对应 [实现 PR #78](https://github.com/BqLee-AI/Along-agent/pull/78)；运行与静态审查边界见验证记录，不把归档视为重新运行完整产品验收。

归档检查：执行 `openspec archive close-r1-conversation-history --yes` 生成 conversations 主规格并移入本目录；随后补齐归档自身的 4.5，`openspec validate --all --strict` 为 8/0，活动 change 为 0。归档新增 7 条 requirement，不改已评审的要求或场景；此检查不代替实现运行证据。
