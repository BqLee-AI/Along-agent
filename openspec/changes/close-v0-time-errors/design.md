# A4 时间失败与规则边界设计

> Issue #30；分支 `docs/30-spec-time-errors`。状态：**Proposed，仅契约起草**。本change不实现、不运行验证；PR `Refs #30`，须独立review + 五门SUCCESS + CLEAN合入后才能实施。

## 1. 结论与证据

恢复冻结安全spec的typed失败，不改其Scenario 1.2迎合当前completed。推荐保留现有不可变有限规则表示，API应用装配单一上下文，不引入全IANA依赖或新的健康平台。字段/错误真源为design/05 §5/§9、design/10 §3/§4/§6及conversations §4；本篇解释责任与取舍，不另立DTO。

Observed（只读源码/文档，非运行结果）：

| 证据入口                                                                                          | 已核实事实 / 缺口                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/time-core/src/fixtures/fixture-v1.ts`                                                   | FIXTURE_V1/fixture-v1；仅Shanghai固定+08、Kiritimati固定+14、New York 2026/2027四转换，没有覆盖声明                       |
| `packages/time-core/src/normalize.ts` / `types.ts`                                                | 纯函数已返回typed时间四错；候选已有fold_choice/offset_seconds/fire_at_utc；现实现沿末偏移外推                             |
| `packages/time-core/src/entry.ts`                                                                 | ALIAS_TABLE_V1为五条；已有confirmedTz时未知显式别名可能被忽略；已知别名按表首项覆盖                                       |
| `apps/api/src/modules/tools/gateway.ts#runProposeTask`                                            | 直接用FIXTURE_V1，所有时间失败转clarify，候选只拼话术                                                                     |
| `apps/api/src/modules/conversations/service.ts#startConversationRun/#runTurn/#startPayload`       | run先落库；时区请求字段实际以_id优先；原会话时区覆盖后续请求；clarify路径completed；开始帧再直接报告fixture               |
| `apps/api/src/modules/conversations/schemas.ts` / `packages/stream-protocol/src/thread-events.ts` | 已接受两种confirmed_timezone字段、fold_choice；failed已有error.code/message/http_status/unknown details，七事件词无需扩张 |
| `apps/api/src/http/app.ts` / `http/errors.ts`                                                     | readyz只查版本字符串；实际业务envelope顶层numeric、error.code符号名；探针为status/reason非envelope                        |
| `docs/api/README.md §6` / `scripts/compose-smoke.sh`                                              | DB不可达必须非就绪是既有合同；D7有版本轮目前用2024a，与实际内容不匹配                                                     |
| `apps/web/src/app/conversations/Chat.tsx`                                                         | 仅展示失败message、不提交fold，输入发送即清空，不能证明候选选择已实现                                                     |

## 2. 责任与一次新请求

1. HTTP入口先处理session/CSRF/结构及既有owner、资源、幂等冲突/重放边界；这些边界不被规则503掩盖。相同已存结果回放不重归一。
2. 拟作新归一的用例在任何新conversation/message/run/attempt/idempotency写入与SSE头之前，消费API应用上下文的同一可用结论；不可用为503业务envelope，顶层400006/error.code=TZDB_UNAVAILABLE，不建新run、不调用normalize。只读或旧冻结取消流程不套用该门。
3. 获准后固定本轮不可变上下文。入口纯解析先处理显式时区与fold，按覆盖边界校验所需anchor/目标，然后time-core归一；普通信息缺失/模糊仍澄清。所有时间失败须在创建approval之前判定。
4. 已开SSE用既有failed事件，外层HTTP200、帧内422或503。可以解释delta，但终结只允许一次；失败后无approval/card、completed或cancelled。失败审计与承诺写分开计数。
5. 成功结果由approvals创建pending冻结项，只有既有按钮三件套确认能建task。新规则可用性不用于重算旧冻结项。

API应用拥有装载、环境版本一致性和上下文，不是time-core单例。time-core仍只吃不可变规则值，不读取env/时钟/网络/DB。公共归一用例接受显式UTC首次接收anchor、跨日判定接收时刻、原文、已确认timezone、fold_choice，只返回值；conversation提供既有会话anchor，A2 revise提供其持久首次接收anchor（两接收参数同取该值），有效期仍由approvals锁后DB clock检查。A2不得复制fixture/别名/候选或用当前钟改义。

## 3. 有界规则与错误分界

精确范围与UTC边缘只在design/05 §5.1定义：三个zone均承诺本地半开`[2026-01-01T00:00:00,2028-01-01T00:00:00)`，纽约上下界均冬令偏移；含四次转换。固定偏移不等于历史任意年正确。检查墙上范围后才判断gap/fold，成功/所有候选UTC及相对表达所需anchor也须在各自UTC覆盖内；24:00跨上界和“明天”跨上界都拒绝。纯函数秒精度边界与当前分钟精度生产回显分层验收，不扩改approval展示精度。

实际ruleset、alias、标识/内容/声明zone完整性坏包为503 TZDB_UNAVAILABLE；健康包不认识的用户ID/显式别名为422 UNKNOWN_TIMEZONE，未支持的合法IANA值也只说本版本不认识；支持zone范围外用503，不外推。输入越界不污染全局readyz，坏包才使readyz非就绪。

别名/字段优先级在design/05 §9.2唯一规定：原文单一显式有效时区 > 本次`confirmed_timezone_id ?? confirmed_timezone` > 会话明确默认值；未知显式指示即使已有Shanghai也失败，多个不同有效指示问清，不按表顺序挑。fold只从结构化first/second/none取，候选用fold_choice，结果/快照用数字fold，不创造列名。

## 4. 协议、Web与数据边界

AMBIGUOUS Proposal的唯一details形状为design/05 §9.1的`{wall_time,timezone_id,ruleset_id,candidates}`；两个候选各有fold_choice、offset_seconds、fire_at_utc，按UTC升序。其余时间错误不强加新details枚举。现有unknown details能容纳但不等于专用约束已经实现。

Web保存本次意图和服务端精确日期/时区，呈现first/second+数值偏移，点击新键重提议，不使用原未选fold请求的幂等键，不用/me覆盖纽约、不用当前点击时刻重算“明天”。日期/时区改变即清掉旧选择。客户端不算UTC、不从话术猜fold；服务端重新校验，选候选不是confirm。

流中允许既有conversation/message/run/attempt/checkpoint/tool_calls失败审计；“零承诺写入”明确为approval/task/task_events/outbox/notification与provider调用均无新增/改写。预检拒绝则连上述新审计run也不创建。恢复重放同一终结，不因断连/审计尾部异常落第二终结。

## 5. readiness与兼容取舍

沿API README §6非envelope探针形状。规则/alias/标识不可用优先reason=TZDB_UNAVAILABLE；仅规则好而DB不可达用NOT_READY；二者同时坏仍单reason，不新增组合码。DB采用最小真实可达探测，不依赖业务迁移才能让D7新库就绪。healthz依旧不看DB。

不选择“非空环境字符串即规则可用”，因为会假绿；不选择“全站readyz中间件”，因为会误阻断旧冻结取消/执行；不选择“直接接全IANA库”，因为当前已有有限可证明用例，不为没有部署证据的全球范围加依赖与自动更新。

D7保留两轮全新卷、缺版本503含TZDB_UNAVAILABLE、真规则+DB可达200、healthz200/未认证业务401。现2024a应在后续实施改成真实fixture-v1，相关fixture同步，不改五门含义、不允许任意非空版本。主线程负责同步API README/PRD/共享索引；本工作树未编辑这些文件。

## 6. 可观察验收与落地顺序

按tasks.md先独立合同合入，再实现→定向回归与五门→独占真实部署取证→独立代码/证据review→archive。保留Bun1.4.2、OpenSpec1.3.1及static/migration-scan/scheduler-fault/contracts-dual/compose-smoke五门，不触旧迁移。

有效回归可按影响复用；新增行为验收覆盖：未来DST错误与first/second，未知ID/别名在空/已确认时区下失败，bad包预检零run与流中failed503，owner/CSRF优先，逐zone四个年月边缘/UTC边缘与纽约四转换，旧冻结对象不被门阻断，真实DB断开readyz503/healthz200。完整回归点见design/05 §10。

真实缺失部署必须改变生产实际装载来源/构建资源并重启同一装载链，保留源码/镜像/实际规则/alias/环境标识、HTTP/SSE和SQL关联证据；mock对象、环境换标签、单个readyz或只跑纯函数都不是完整演练。静态内嵌规则现无独立可移除资源，后续须落实最小实际装载边界或受控移除构建资源；本契约不虚构文件路径/环境变量，也不建通用注入平台。

本次只起草，未执行任何build/lint/test/formatter/OpenSpec校验、Git或外部操作。当前缺的是合同评审/合入、实现与真实证据，不将其勾成完成。
