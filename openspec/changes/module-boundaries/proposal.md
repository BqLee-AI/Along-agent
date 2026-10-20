Issue: #14

# module-boundaries：依赖边界门禁

## Spec

- `docs/design/02-modular-monolith-and-split-triggers.md` §1–§2：模块所有权、confirm 单事务与读取投影。
- `docs/design/01-tech-stack-and-repo-structure.md` §3：依赖方向。
- `docs/design/13-p0-bootstrap-and-ci-rules.md` §3 D1：依赖边界验收。
- 行为增量：`specs/gates/spec.md`，复用横切治理能力。

## 变更

在现有 depcruise 配置中禁止 API 模块直接引用其他模块的 repository/schema 实现，禁止 Web 引用 API 源码；为五个共享包声明依赖范围。新增正反 fixture，接入既有单元测试与 D1 evidence，不改变 job 名。

| API 模块                       | 保留的跨模块调用目标                           |
| ------------------------------ | ---------------------------------------------- |
| identity、brief、notifications | 无                                             |
| conversations                  | tools/gateway.ts                               |
| tasks                          | notifications/service.ts                       |
| tools                          | approvals/create.ts、approvals/presentation.ts |
| approvals                      | confirm.ts 调 tasks/cancel.ts（单事务）        |

模块可依赖自身、共享 db/http 和外部包；本次不将公共服务调用收紧为封闭白名单。上述表记录需保持合法的边，不授权跨模块 repository/schema 引用。confirm 的现有精确调用无需存储层通配豁免。读取投影的 SQL 不属于 import 扫描范围。

包边界沿用 design/01 §3：time-core 仅自身源码；contracts、stream-protocol 仅自身与 zod；scheduler-core 允许自身、contracts、time-core；notifier-core 允许自身与 contracts。每条新规则须有实际越界红例，设计允许的跨包调用与模块内存储访问保持绿。

## 非目标/Deferred

不重构业务、不增加服务调用白名单、不解析 SQL、不修改迁移或 confirm 事务；不扩展 D1–D10 语义。Bun/ox 迁移由 #13 承担。鉴权、LLM、市场、推送、计费不变。
