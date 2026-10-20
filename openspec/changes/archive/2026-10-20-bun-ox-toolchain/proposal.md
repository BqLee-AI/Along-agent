Issue: #13

# Bun/ox 工具链等价切换

## Spec

docs/design/01-tech-stack-and-repo-structure.md §1.1、§2–§3；docs/design/13-p0-bootstrap-and-ci-rules.md §3–§4；CONTRIBUTING.md §1、§6–§8。行为增量归属 `specs/gates/spec.md`。

## 原因与变更

当前 pnpm/Turbo、ESLint/Prettier、Vitest 的多入口工具链将切为 Bun/ox；只换执行方式，不改变 D1–D10 或业务断言。

- 固定 `bun@1.4.2`，用 workspaces 与单一 `bun.lock`；显式保留依赖包先构建、应用后构建/检查/测试的顺序，移除 Turbo。
- 用 `oxlint@1.89.0` 和 JS 插件原样承接 D2 两个 selector；其余现有 lint 规则逐项映射、说明差异，不以关闭规则或改业务掩盖迁移问题。Prettier 切为 oxfmt，格式检查仍阻塞。
- 27 个测试文件迁到 `bun:test`；保留时钟隔离、单元/数据库分组与进程内/HTTP 契约双跑，dependency-cruiser 保留。
- 本地、CI 和 Docker 的真实安装/构建/运行路径同时切换，不留 pnpm/Turbo/ESLint/Vitest 活动调用；沿用 #12 的五 job DAG，不另改门的拓扑或数据库隔离。
- 同步当前设计、贡献说明、模板、ADR 状态及 `ci/gates.json` 的执行证据；本地与 CI 使用同一阻塞式 `bun run verify`。

## 证据与验收

隔离 Windows spike 已证实 Bun 1.4.2 可获取；Oxlint D2 正例 0 错、红例 17 错；Bun 下 depcruise D1 红例 2 错；27 文件运行 148 pass、0 fail、0 skip（含重复注册的 2 个 case）。这不替代冻结安装、干净构建、Ubuntu CI 和 Docker 验收。收口须完整 verify、五 checks 全绿、D1/D2 红例及前后 CI 墙钟证据；目标 ≤3 分钟、冲刺 ≤2 分钟，不以跳门达标。

## 非目标/Deferred

不改业务逻辑、路由/schema、D1–D10 语义、已合并迁移或真实 secret，不部署发布；不顺带重构测试共享 helper 或扩大 D2 禁令。鉴权扩展、LLM、市场、推送、计费继续 Deferred；`@fission-ai/openspec` 保持现有 pin。
