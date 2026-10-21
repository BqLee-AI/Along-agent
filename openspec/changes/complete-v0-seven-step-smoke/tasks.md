# Tasks：#26 真实七步 smoke

本 change 按「独立契约 → 实现 → 同次真实七步 → archive」执行。起草不代表 review/合并/运行通过；仅凭实际证据勾选。通知以本 change delta 为新增合同，取消与七步安全约束沿用已冻结合同。

## 1. 独立契约 PR（不得夹带实现）

- [x] 1.1 核对既有 schema 与模块入口，完成 design/03 §3.1–§3.2、API tasks §2.1、PRD04、索引及本 change；通知只投影已存字段，实际状态域、owner、空态、错误与无副作用语义一致。
- [x] 1.2 将七步手册/closeout plan 校正为真实请求、响应、通知观察入口与证据要求；标明通知/取消尚待实现，不把计划或静态测试写成通过。
- [x] 1.3 主线程使用固定本地 OpenSpec 1.3.1 完成严格校验及既有格式/静态要求，由独立 reviewer 审查增量与范围；PR 仅 `Refs #26`。本地 140 tests/623 assertions、strict 3/3；格式的既有 CRLF 检出差异仅在工作区归一化，确认无内容 diff；ReviewSmokeSpec26 approve 0.93，无 findings。
- [ ] 1.4 独立契约 PR 的 static、migration-scan、scheduler-fault、contracts-dual、compose-smoke 全绿，独立 review 通过且合并状态 CLEAN 后合并；此前不实现新增行为。

## 2. 合同合并后的最小实现

- [ ] 2.1 在 notifications 公开 service/自有 repository 增加 owner/task ID 限定的只读查询；tasks 详情 DTO/schema 调用该服务，返回必有 notifications 数组，不改任务列表、不直读通知表、不增加通知路由。
- [ ] 2.2 Web 任务详情展示真实站内通知与空态；同步 Web DTO 与受影响调用点，保留冻结文本与口径，不用 fired 事件合成通知，不承诺设备送达或已读。
- [ ] 2.3 按既有 safety Requirement 5 与 design/07 §3 补齐生产取消链：实际本地队列撤销和 fencing 核对后，持久化撤销回执再转 cancelled；无回执仍 pending。移除被替代的内存回执事实源/调用，不用测试手注回执或修改旧迁移。
- [ ] 2.4 在真实 provider 调用边界准备受控非暂停 debug logpoint，正向任务作正控制；只有确需时才补无内容的最小调用证据及定向测试，不建立通用框架或测试 API。
- [ ] 2.5 补齐任务读取、通知展示与取消回执相关测试：owner/404/403、空态、所有合法通知状态与 sent_at 空值、GET 无业务副作用、冻结正文、已持久通知可见、无回执仍 pending、持久回执可恢复/幂等、取消后实际 provider 零调用；复用既有测试入口，不以源码扫描或测试预置终态代替生产链。
- [ ] 2.6 主线程统一运行相关既有单元/真实数据库/调度/契约与依赖门，独立 review 实现及测试证据；实现 PR 待同次真实 smoke、证据审查和 archive 完成后作为收口 PR 合并，不把实现完成等同于真实 smoke 完成。

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
