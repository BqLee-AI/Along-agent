# ADR 0008：static 内部调度

- **Status**: Accepted
- **Date**: 2026-10-20
- **Deciders**: issue #24（static 调度优化）
- **Supersedes**: [0007](0007-ci-critical-path.md) 中不改变 typecheck 或用例并发的边界；其五门编排、构建复用和失败传播继续有效

## Context

共享包构建需要依赖拓扑，但构建成功后的各 workspace 类型检查不再需要等待其他 workspace 的检查结果。双核 Linux 对照中，同时运行多个 TypeScript 检查进程比串行更慢；全量并行不能作为提速假设。边界 fixture 创建后只读，各真实 CLI 没有可变共享状态，可以受控重叠，而不改变共享时钟、mock 或数据库用例的隔离方式。

## Decision

保留共享包的 Bun 依赖拓扑构建；成功后用 Bun `--sequential` 执行全部 workspace 类型检查，保留源码、测试和 Next route typegen。类型或构建错误仍使入口失败；同次 verify 的成功构建复用规则不变，不引入持久缓存或新编译器。

仅边界 fixture 使用文件内并发，最多两个真实 dependency-cruiser CLI 同时运行。各红例仍独立验证非零退出、规则名与实际解析目标，绿例保留 err/JSON 两种真实扫描；启动、信号和输出缓冲错误不能冒充规则拒绝。清理先停止接收扫描、等待排队和运行中的 CLI 结束，再删除 fixture。

## Consequences

- 收益：针对双核环境减少类型检查进程竞争，重叠独立边界 CLI；不删用例、合并逐项扫描或放宽断言。
- 权衡：串行检查不是所有多核环境的最快方案；只读边界测试的单例超时包含排队时间，单文件使用 30 秒超时，其余测试不变。
- 守护：包构建不能改用按名称排序的串行调度代替依赖拓扑；全部类型检查、D1–D10、五门全成功、格式阻塞、真实 DB 与新卷 Docker 门继续有效。性能计时和故障演练记在 issue / PR，不作为通用耗时承诺。

## References

- [ADR 0007](0007-ci-critical-path.md)（仍有效的五门编排、构建复用及失败传播）
- `docs/design/13-p0-bootstrap-and-ci-rules.md §3–§4`
- issue #24（隔离双核对照、实际 CI 和故障证据）
