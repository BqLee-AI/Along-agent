# 术语表

> 状态：随 design 演进。范围：全 docs 通用术语 + 旧称映射。不包含：外部私有协议原文。阶段标签：全阶段。

## 核心术语

| 术语 | 一句话 |
| --- | --- |
| Task（正式调度对象） | 确认后创建、到点触发的单次提醒（旧称 R） |
| Approval（确认草稿/回显） | 确认门载体；绑定回显快照 + `presentation_hash`（旧称 C） |
| time-core | TS 服务端纯函数 `normalize(...)`，时间归一唯一权威 |
| 归一 | 墙上时间 + 时区 + fold → `fire_at_utc` + 偏移的确定性计算 |
| 锚 | 服务端首次接收时刻 + 已确认时区，“明天”解析一次冻结 |
| 存摆分家 | 存（`fire_at_utc` + 墙上 + 时区 + fold + 偏移 + 库版本）vs 摆（原话 + 本地时间 + 时区） |
| 触发门禁 | 到点三查（对得上 + `scheduled` + 登记凭据绑同一 task） |
| outbox | 跨边界垫单（`task_id` + 期望版本 + 命令 + 幂等键） |
| 事件账 | `task_events` 只追加证据链 |
| 墓碑 | approval 过期清内容留号 30 天 |
| 五缝 | AgentRuntime / ToolGateway / Scheduler / Notifier / ConnectorVault |
| 回执 | 调度登记/发送凭据；无回执不标终态 |
| 幂等键 | 重试同一键，不再问用户 |
| lease / fencing | Scheduler claim 租约；失活 attempt 标 `fenced_out` |
| checkpoint | 边做边存档（`run_checkpoints`），resume 重放依据 |
| revision | 不可变版本（agent/skill/prompt + `presentation_version` + `tzdb_version`） |
| AG-UI 投影 | `packages/stream-protocol` 版本化 zod 事件投影 |
| 15 分钟线 | 到点 15min 内触发有效，超则 `missed` 不补发 |
| 取消优先 | 取消提交后排队重试全作废；取消后触发数 = 0 为一级指标 |
| 诚实口径 | 只说已记录步骤，不承诺必达 |

## 旧称映射（R/C → Task/Approval）

| 旧称（B06） | 新称 | 说明 |
| --- | --- | --- |
| R（正式提醒） | Task | `tasks` 表；状态机 `saved → ... → fired/missed/cancelled` |
| C（确认草稿/回显） | Approval | `approvals` 表；状态机 `pending → consumed/rejected/expired/superseded` |
| pending_confirmation（一行） | approvals（一行） | 字段全量迁移（`fire_at_utc`/墙上/时区/fold/偏移/库版本/`presentation_hash`） |
| 登记回执 | `schedule_receipt` | 有回执才 `scheduled` |
| 未支持请求列表 | Deferred（v1 盒子） | 30 天归档、一年删除的语义保留，表 Deferred |

## 代号

- B00–B06 = 蓝图篇章代号。
- [AF] = 开源参考。
