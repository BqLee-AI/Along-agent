## 1. 合同

- [x] 1.1 明确未排期过窗、历史遗留恢复和取消优先合同，spec-only PR 先行。

## 2. 实现与验收

- [x] 2.1 真实 PG16 原迁移、文件级隔离失败回归：确认后首次调度已过窗，saved/pending_schedule 均终结。
- [x] 2.2 在任务锁与事务内完成 missed、事件及队列终结，兼容已终结 schedule 命令的遗留任务。
- [x] 2.3 A1/A3、D5/D9：重复/并发处理仅一条 missed；取消先提交不被覆盖；provider 实际调用零，无虚构回执。
- [x] 2.4 执行根静态/契约/集成（含调度覆盖）检查及隔离 PG16 真实 worker 恢复路径，记录 Red/Green 和未覆盖项。
- [x] 2.5 同步设计、PRD 与索引，archive 本 change；收口 PR 使用 Closes #42，五门全绿后合并结案。

## 验证记录

- 策略：重要缺陷先失败回归。修复前，真实 PG16 上 saved/pending_schedule/旧 failed_deadline 三例分别因仍停活跃态失败；事件注入失败例因缺少 missed 写入而不拒绝事务失败。取消先提交例原已通过。
- 修复后同五例 5 pass；根 `bun run verify`（168 unit）、`bun run test:contracts`（15）、`bun run test:integration`（133，14 文件，包含四个调度文件）通过。调度专门 CI 门由收口 PR 提供，不在本地重复其已含集成的全部用例。
- 临时探针使用原始迁移和随机 schema，经真实 confirm 建任务，在隔离夹具中调整到点时间模拟 worker 停机跨窗，生产 startWorkerLoop 连跑四 tick：三种未排期场景各 missed、created/missed、零回执/通知/实际调用；取消项 cancelled、零调用；窗内正控制 fired、一条通知且实际调用 1。探针退出并清理 schema，无用户数据库、旧验收服务或 .env 访问。
- 限制：SQL 时间夹具不是自然等待 15min 的停机或 SIGKILL 演练；不宣称重验历史 A1/A3、页面或真实外部推送。
