# module-boundaries tasks（Issue #14）

## 1. 契约先行

- [x] 1.1 编写 proposal、gates spec 增量及 tasks。
- [x] 1.2 `pnpm exec openspec validate module-boundaries --strict` 通过。
- [ ] 1.3 OpenSpec-only PR 经 review approve、全 checks 绿后 squash 合并。

## 2. 实现

- [ ] 2.1 在 `.dependency-cruiser.cjs` 保留现有规则，逐模块禁止引用其他模块的 repository/schema/schemas 文件、目录及连字符后缀实现，不限制合法公共服务调用。
- [ ] 2.2 禁止 Web 引用 API 源码，保留 HTTP 客户端路径。
- [ ] 2.3 为 scheduler-core 声明自身、contracts、time-core 允许范围，为 notifier-core 声明自身、contracts 允许范围，为 stream-protocol 增加仅 zod 规则；保留 time-core/contracts 现有边界，正例覆盖设计允许的跨包边。
- [ ] 2.4 每条新增规则建立真实解析的红例，覆盖嵌套与类型引用；绿例覆盖自身存储访问、公共调用、confirm→tasks/cancel 与包内/zod 合法依赖。
- [ ] 2.5 按现有 scripts 单测惯例运行真实 depcruise，断言退出状态及规则名；测试和 fixture 加入 D1 evidence。
- [ ] 2.6 更新贡献指南中的边界行为与运行方式，不改变业务代码、迁移、DAG 或工具链。

## 3. D/A 验收与收口

- [ ] D1：每条新增模块/包/跨应用规则各有越界变红输出；真实仓库 depcruise 与合法 fixture 全绿。
- [ ] D1：confirm 精确公共调用通过，跨模块 cancel-repository 仍被拒绝；不扩大事务豁免。
- [ ] D2–D10 / A1–A4：语义不变，`pnpm verify`、类型检查及测试全部通过，最终 CI checks 全绿。
- [ ] 3.1 实现经独立 review；request-changes 必须修复后复审 approve。
- [ ] 3.2 `pnpm exec openspec archive module-boundaries --yes`；随后 `pnpm exec openspec validate --all --strict`。
- [ ] 3.3 收口 PR 附变红证据、CI 链接并写 `Closes #14`，仅在 approve 与全 checks 绿后 squash 合并。
