# 12. a13n 原则落点设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：a13n 六条原则各自落到哪个模块、CI 门、Postgres 贯穿原则
- **不包含**：模块拆分指标（见 02）、AgentEvent 语义（见 09）、Spike 数字（见 11）
- **阶段标签**：v0 落前三条；P1–P2 落全六条

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. 六条原则 → 落点（Required）

| # | a13n 原则（Observed, AF） | 本项目落点模块 | 落法 |
| --- | --- | --- | --- |
| 1 | harness 可替换 | 五缝 + 双实现同一契约（09/11） | `AgentRuntime/ToolGateway/Scheduler/Notifier/ConnectorVault` P1 起全接口化；Ts 与 Cangjie 同一 `contracts` 测试双跑；替换任一缝只需过同一套契约 |
| 2 | checkpoint 可恢复 | `agent_runs/run_attempts/run_checkpoints` + lease（09 §6） | P1 落库可续跑；P2 lease+fencing；Spike S2 同标准验收 |
| 3 | 自托管 | 单镜像 + compose 冒烟（01/13） | 一个镜像 `api\|worker\|all`；`docker compose up` 空环境冒烟为 CI 门；K8s Deferred |
| 4 | 不可变 revision | `agent/skill/prompt` + `presentation_version` + `tzdb_version`（09 §7；B06§5） | DB 禁 UPDATE/DELETE（迁移层强制）；旧 revision 跑完旧 run；模板 bug 只作废重来 |
| 5 | AG-UI 投影 | `packages/stream-protocol` 版本化 zod（09 §3；10 §4） | 事件名开工对照 `thread-stream.schema.json`；投影只读 AgentEvent，不反写运行时 |
| 6 | 不支持组合 → 类型化错误不降级 | `/readyz`（10 §6） | 规则缺失/依赖未就绪只返回 `TZDB_UNAVAILABLE/NOT_READY` + `details.missing[]`，永不降级为可用 |

## 2. CI 门（Required，实现见 13）

| 门 | 拦截内容 | 对应原则 |
| --- | --- | --- |
| depcruise 依赖门 | `time-core` 零依赖、`spikes/*` 不碰业务、跨模块只经 `contracts` | #1、红线 |
| 纯函数门 | `time-core` 禁时钟/禁 env/禁网络；单测用 fixture 规则 | #4（可复现） |
| 约束存在门 | `UNIQUE(task_id,fire_at)`、`recreated_from` 唯一、`task_events` 无 UPDATE/DELETE 迁移扫描 | #4（DB 承载规则） |
| 契约双跑门 | 同一 `contracts.test.ts` 进程内 + HTTP 双跑全绿 | #1 |
| 冒烟门 | 空环境 `compose up` + `/readyz` 类型化失败演练（缺 TZDB 时） | #3、#6 |

## 3. Postgres 贯穿原则（Required，AF 三硬约束 Observed AF§5）

1. PG 决定一切，Redis 只加速（且 v0 无 Redis）：状态机跃迁、幂等去重、lease 抢占一律以 PG 约束/事务为准。
2. 每个规则只有一个实现：状态机只在迁移约束 + 模块 service 各一处；不出现“service 与触发器双实现”。
3. 能用结构承载就用结构：不可变 revision、审计、lease token、幂等键、只追加账全部用 DB 约束表达，CI 门守护。

## 引用

- AF§2–§7；B03§6–§7、B06§4–§6；01/02/09/10/11/13。
