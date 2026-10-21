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
- [x] 2.4 实际 provider 紧邻前的原生诊断通道仅订阅时发布 taskId，默认无日志、无内容；临时 preload 不替换 provider。同一 PID 26380 连续观察，T_fire 正控制调用 1，T_cancel 从提交至原到点+16min 调用 0，原始事件和心跳已保存；不以零通知顶替。
- [x] 2.5 相关真实 PG16 测试最终 71 pass/9 文件/311 assertions，覆盖通知隔离、状态/null、冻结、无读副作用、HTTP 错误/成功、取消无回执/回滚/恢复及实际调用零的故障测试。新增旧版本 ack fixture 首次错误保留 delivered=true 导致真实 sent，已纠正为丢失回答+后续对账的测试输入，未改生产 outcomeOf 或削弱断言。
- [x] 2.6 lint/typecheck/depcruise/治理门与后续 copy-claims/unit/strict/format 分段完成；unit 140/21 文件/623 assertions，契约双跑 14/4 文件/33 assertions，API/Web 生产构建通过。ReviewSmokeImpl26 approve 0.88，无 findings；仅 fixture 修正补审 approve 0.97。实现 PR 在同次真实 smoke、证据审查和 archive 后收口合并；不是实际七步完成证据。

## 3. 同一受控环境的真实七步

- [x] 3.1 源码 `914cca971f03e7a0a813a7aff8890aa36c82951a` 固定后启动无 watch 的生产 API/Web；Bun 1.4.2、PG 16.15、ROLE=all、Asia/Shanghai、FIXTURE_V1/fixture-v1、真实 session/CSRF、owner 基线与时间已记录。独占合成环境，不读写 .env、不触用户数据；凭据未进入证据。
- [x] 3.2 真实对话准备 P0，简报两次 200 投影相同，实际卡片 GET/冻结内容与只读快照一致，无 task/outbox；见 `docs/demo/v0-smoke-evidence-2026-10-21.{md,json}` 的 brief/read_only_card。
- [x] 3.3 P_fire 真实 SSE seq 6–10、单终结；实际按钮 POST 200 和 T_fire 跳转，原键重放 200 duplicate=true 同 task，task/created/schedule 各 1。首次响应 body 未留存、重构 request 非原始抓包、重放不额外证明首次 hash/seen 校验等局限均明确，持久原键已另做只读串证。
- [x] 3.4 真实到点 08:01Z 后 08:01:18.261Z 实际 provider 唯一调用、通知 1 行、登记/fired 回执、Web 原文与活动链对齐；继续到最终快照仍通知/fired/调用各 1，未回拨时间或以 missed 充正向成功。
- [x] 3.5 T_cancel 先见真实 sched 回执，页面取消 08:05:11.809933Z 返回 200 cancel_pending，worker 08:05:18.219266Z 持久撤销回执与唯一 cancelled；原到点 08:08Z、宽限 08:23Z、实际两个 tick 08:23:18.236598Z / 08:23:48.235132Z，末只读样本 08:24:00.122246Z，非心跳代替。
- [x] 3.6 同进程实际调用正控制 1、取消任务全段 0；62 次只读样本 cancelled、通知/fired/breach/非 cancel 余单均 0，末 lease 0。脱敏 Web/API/SSE/SQL/调用及采样已保存；截图已捕获但当前图像模型不可用，不声称像素视觉判读。D9 主指标独立于持久化辅证。

## 4. 独立证据审查与 archive

- [x] 4.1 ReviewSmokeEvidence26 独立核对原始 JSON、手册、必要源码、截图引用及 DOM 串证，approve 0.90、无 findings；补充取证 SQL、后来只读原键串证与中文报告的针对性复核 approve 0.94。认可代表性七步及 D9；首次确认 body/早期查询抓包、SSE 中文解码、无像素判读等局限保留。完整 A2 替代、A3 kill/resume、A4 合同冲突未完成，不宣称完整 v0 结案。
- [x] 4.2 实现、真实验收与独立证据审查完成后，使用 OpenSpec 1.3.1 归档为 `2026-10-21-complete-v0-seven-step-smoke`，主 spec 同步通知详情要求，文档索引关联独立运行记录；归档后 strict 2/2。归档命令仅因本自指归档项未勾选而提示 18/19，未跳过 spec 或 validation；生成主 spec 格式由既有格式器归一。收口 PR 在最终精确 head 五门 SUCCESS、独立 review 及 CLEAN 核实前保持 `Refs #26`，之后才添加 `Closes #26` 并精确 head 合并；最终门禁记录保存在 PR，不以源码 head CI 替代。
- [x] 4.3 验收记录“新增行为与门禁映射”汇总 D1 模块存储边界、D2 冻结正文/UTC变异、D8 详情 HTTP/in-process 与 contracts 双跑、D10 页面口径，A1 主链、A2 重复确认子集、A3/D9 真撤销与实际调用零。D3–D7 既有门不降级，完整 A2/A3/A4 与部署范围明确未覆盖；源码精确 head run 39567342047 五门 SUCCESS，不冒充最终归档 head CI。
