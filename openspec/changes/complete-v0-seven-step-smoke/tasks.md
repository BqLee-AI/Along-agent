# Tasks：#26 真实七步 smoke

本 change 按「独立契约 → 实现 → 同次真实七步 → archive」执行。起草不代表 review/合并/运行通过；仅凭实际证据勾选。通知以本 change delta 为新增合同，取消与七步安全约束沿用已冻结合同。

## 1. 独立契约 PR（不得夹带实现）

- [x] 1.1 核对既有 schema 与模块入口，完成 design/03 §3.1–§3.2、API tasks §2.1、PRD04、索引及本 change；通知只投影已存字段，实际状态域、owner、空态、错误与无副作用语义一致。
- [x] 1.2 将七步手册/closeout plan 校正为真实请求、响应、通知观察入口与证据要求；标明通知/取消尚待实现，不把计划或静态测试写成通过。
- [x] 1.3 主线程使用固定本地 OpenSpec 1.3.1 完成严格校验及既有格式/静态要求，由独立 reviewer 审查增量与范围；PR 仅 `Refs #26`。本地 140 tests/623 assertions、strict 3/3；格式的既有 CRLF 检出差异仅在工作区归一化，确认无内容 diff；ReviewSmokeSpec26 approve 0.93，无 findings。
- [x] 1.4 独立契约 PR #27 在精确 head `86aba44aa809487c066facbebbbbacb99f6ac7c7` 的 run `39560622469` 五门全部 SUCCESS、ReviewSmokeSpec26 approve 且 REST `mergeable_state=clean` 后 squash 合入 `94c3c0cf5506151a57dd1843c766cef8f30b3180`，之后才启动新增行为实现。CodeRabbit completed 不作为人工或平台强制批准。

## 2. 合同合并后的最小实现

- [x] 2.1 notifications 自有 repository 按 owner/task ID 查询，公开 service 供先验 owner 的 tasks 详情组装必有数组；详情 HTTP/进程内、空态、隔离与查询失败测试通过，列表形状不变。
- [x] 2.2 Web 任务详情新增真实通知/空态区域，原样标题正文、实际状态/可空发送时间与非收悉说明；生产构建通过。实际页面取证列在第 3 节，不以构建代替浏览器观察。
- [x] 2.3 生产 worker 实际撤销旧版本 PG outbox/lease，核验后持久回执再原子 cancelled/event；移除 registry Map/Set、RevokeCheck 与调用。相同生产函数复现从修复前 pending 变为 cancelled，无手注回执；跨进程/回滚/重放测试通过，无旧迁移修改。
- [ ] 2.4 调试设备未提供可核验的 Bun 非暂停 logpoint，已在实际 provider 调用紧邻前补原生诊断通道，仅订阅时发布 taskId，不含内容、默认无日志；Bun 1.4.2 通道能力 probe 通过。临时 preload 观察器不替换 provider；正向调用控制与连续零调用仍待第 3 节实际运行。
- [x] 2.5 相关真实 PG16 测试最终 71 pass/9 文件/311 assertions，覆盖通知隔离、状态/null、冻结、无读副作用、HTTP 错误/成功、取消无回执/回滚/恢复及实际调用零的故障测试。新增旧版本 ack fixture 首次错误保留 delivered=true 导致真实 sent，已纠正为丢失回答+后续对账的测试输入，未改生产 outcomeOf 或削弱断言。
- [x] 2.6 lint/typecheck/depcruise/治理门与后续 copy-claims/unit/strict/format 分段完成；unit 140/21 文件/623 assertions，契约双跑 14/4 文件/33 assertions，API/Web 生产构建通过。ReviewSmokeImpl26 approve 0.88，无 findings；仅 fixture 修正补审 approve 0.97。实现 PR 在同次真实 smoke、证据审查和 archive 后收口合并；不是实际七步完成证据。

## 3. 同一受控环境的真实七步

- [ ] 3.1 按手册记录源码版本/差异、环境所有权、Bun/PG/ROLE、真实 session、owner 时区、规则版本、服务端/PG 时间与基线；只用合成身份/提醒并脱敏，不清空用户库、不泄漏 session/CSRF/secret/DSN。
- [ ] 3.2 以真实对话准备未确认卡片；完成简报与只读卡片两步，保存 Web/API/只读 SQL 对照，无新增 task/outbox（A1、D2）。
- [ ] 3.3 浏览器真实 SSE 生成新的正向 approval，保存卡片/终结帧与关联 ID；按钮确认及已提交请求重放回同一 task，核同一 approval 的 task/created/schedule 各一条（A1、A2 重复确认子集、D3/D5/D8）。
- [ ] 3.4 近未来真实钟到点，不回拨 DB/时钟替代等待；核登记回执、一次 provider 调用正控制、真实通知一行、Web notifications 与活动事件链，并继续观察稳定计数。missed 不作为正向成功（A1、D2/D10）。
- [ ] 3.5 另建未来取消任务，先见登记回执再经页面取消；核 cancel_pending 提交、实际本地撤销与持久回执、cancelled 事件，保持真实 worker 运行，覆盖原到点后完整宽限窗并再观察两个 tick（A3 取消子集、D9）。
- [ ] 3.6 独立保存取消提交后的 provider 实际调用为零证据，另核通知/fired/cancel_breach 为零、无待处理非 cancel 命令；正控制缺失、调用顺序不清或无调用记录均不能放行。保存七步 Web/API/SSE/只读 SQL/调用记录、实际结果、执行与复核者，不拿五门或零通知替代（D9）。

## 4. 独立证据审查与 archive

- [ ] 4.1 独立 reviewer 逐项复核七步关联证据与新增通知场景；失败或缺证据先解决，不以手注回执、假 provider、直接改终态制造通过。报告明确本次只覆盖代表性七步，完整 A2 替代确认、A3 kill/resume、A4 合同冲突仍未完成，不宣称完整 v0 结案。
- [ ] 4.2 仅在实现、真实验收及相关 tasks 有证据完成后执行 `openspec archive complete-v0-seven-step-smoke`，同步主 specs/文档索引并严格校验归档结果；收口 PR 独立 review、五门全绿/CLEAN 后才 `Closes #26`。
- [ ] 4.3 汇总新增场景的变红/验收映射：D1 为绕过通知 service 的跨模块引用拒绝，D2 为冻结标题/正文不受 UTC 变化影响，D8 为真实详情 HTTP 合同及既有双跑，D10 为不承诺送达/已读；A1 为真实通知可见、A2 为重复确认子集、A3/D9 为真实取消回执与实际调用零证据。D3–D7 与其余 D/A 的既有门不降级，本次未覆盖部分明确列出。
