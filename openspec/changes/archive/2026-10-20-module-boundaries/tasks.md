# module-boundaries tasks（Issue #14）

## 1. 契约先行

- [x] 1.1 编写 proposal、gates spec 增量及 tasks。
- [x] 1.2 `pnpm exec openspec validate module-boundaries --strict` 通过。
- [x] 1.3 OpenSpec-only PR 经 review approve、全 checks 绿后 squash 合并（PR #17）。

## 2. 实现

- [x] 2.1 在 `.dependency-cruiser.cjs` 保留现有规则，逐模块禁止引用其他模块的 repository/schema/schemas 文件、目录及连字符后缀实现，不限制合法公共服务调用。
- [x] 2.2 禁止 Web 引用 API 源码，保留 HTTP 客户端路径。
- [x] 2.3 为 scheduler-core 声明自身、contracts、time-core 允许范围，为 notifier-core 声明自身、contracts 允许范围，为 stream-protocol 增加仅 zod 规则；保留 time-core/contracts 现有边界，正例覆盖设计允许的跨包边。
- [x] 2.4 每条新增规则建立真实解析的红例，覆盖嵌套与类型引用；绿例覆盖自身存储访问、公共调用、confirm→tasks/cancel 与包内/zod 合法依赖。
- [x] 2.5 按现有 scripts 单测惯例运行真实 depcruise，断言退出状态及规则名；测试和 fixture 加入 D1 evidence。
- [x] 2.6 更新贡献指南中的边界行为与运行方式，不改变业务代码、迁移、DAG 或工具链。

## 3. D/A 验收与收口

- [x] D1：每条新增模块/包/跨应用规则各有越界变红输出；真实仓库 depcruise 与合法 fixture 全绿（`pnpm depcruise`：368 modules / 715 dependencies；`pnpm --filter @along/scripts exec vitest run test/boundaries.test.ts`：43 tests passed，含新增模块自动发现红/绿例）。
- [x] D1：confirm 精确公共调用通过，跨模块 cancel-repository 仍被拒绝；不扩大事务豁免。
- [x] D2–D10 / A1–A4：语义不变，`node scripts/verify.mjs` 全部 10 步通过；实现提交 `ecf8afb` 的 [CI](https://github.com/BqLee-AI/Along-agent/actions/runs/39361516591) 五项 checks 全绿。
- [x] 3.1 实现经独立 review；任意模块来源漏门修复后复审 approve。
- [x] 3.2 `pnpm exec openspec archive module-boundaries --yes` 完成；随后 `pnpm exec openspec validate --all --strict`：3 passed。
- [x] 3.3 收口 PR #19 附变红证据与 CI 链接并写 `Closes #14`；合并按该 PR 最终 approve 与全 checks 绿的状态放行。
