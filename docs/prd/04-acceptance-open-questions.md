# 04 验收标准与待决事项

> 状态：草案 / 范围：v0 四条验收、Deferred 清单（含阻塞阶段）、重开门槛 / 不包含：测试用例实现、Spike 执行细节（见 agent/04）/ 阶段：P1（验收）+ Deferred 各归属阶段

## v0 验收（四条，全部按自家可测指标）

- [Required] A1 喝水恰好一次：输入"明天 9:20 提醒我喝水"（已确认时区）→ 回显冻结 → 确认 → 建单次 task → 登记回执 → 到点 15 分钟内应用内通知恰好一次；task_events 含 scheduled（含回执号）→ fired 全链；对外只说已记录步骤。
- [Required] A2 重复确认单任务：同一 approval 连点两次确认，只回同一个 task（"这是重复确认，没有新建第二条"）；改字段后重回显，旧 approval 作废（superseded），确认旧键被挡（APPROVAL_SUPERSEDED）。
- [Required] A3 kill 后恰好一次：worker kill -9 后 resume，副作用（触发请求）恰好一次：lease + fencing 保证单 claim；发了没回只核对不重发；取消已提交后触发数 = 0。
- [Required] A4 DST 追问：不存在的本地时刻拒收（NONEXISTENT_LOCAL_TIME，不猜不存不排）；出现两次的时刻必须追问两候选（AMBIGUOUS_LOCAL_TIME 带 first/second + 偏移）；未知时区别名报 UNKNOWN_TIMEZONE；规则缺失报 TZDB_UNAVAILABLE 且服务不就绪。
- [Required] 验收环境：单镜像 all 角色 + compose 冒烟；Postgres 唯一事实源；Redis 缺席不得影响验收（Redis 已延后）。

## Deferred 清单（每条写明阻塞阶段）

| #   | 事项         | 现状                                                                        | 阻塞阶段                                      |
| --- | ------------ | --------------------------------------------------------------------------- | --------------------------------------------- |
| D1  | 目标市场     | 未定；多租户隔离只预留，v0 跑单租户行为                                     | 阻塞 P5 计费与组织模型；不阻塞 P1             |
| D2  | 是否练仓颉   | 未定；CangjieMagic 只作第二实现，v0–P3 不用                                 | 阻塞 P3 联调排期；不阻塞 P1/P2                |
| D3  | 鉴权方案     | 已定：Better Auth 自建 credential（D7 空环境冒烟不依赖外部 IdP；v0 单租户） | 已冻结；schema/05 与 api 鉴权章节按此落地     |
| D4  | Web 框架     | 已定：Next.js，RSC 开、Turbopack 开（默认配置，偏离另开 docs PR 说明）      | 已冻结；apps/web 脚手架按此落地               |
| D5  | 推送渠道     | Web Push 仅兜底；邮件/系统推送未选                                          | 阻塞 P5 触达扩展；不阻塞 P1（应用内通知先行） |
| D6  | LLM 供应商   | 未选；预算护栏（BUDGET_EXCEEDED）先行                                       | 阻塞成本核算；不阻塞 P1 功能验收              |
| D7  | 计费模型     | 未定；额度字段留占位不冻结                                                  | 阻塞 P5；不阻塞 P1                            |
| D8  | 每日任务粒度 | 每日重复任务进 v1；v0 只做单次 + missed 一键重约                            | 阻塞 P2+ 重复语义设计；不阻塞 P1              |

- [Required] 正文不得猜 Deferred 字段：相关 schema/API 留占位，由归属阶段决策解冻；解冻前 /readyz 按类型化错误如实报告，不降级。
- [Required] D3、D4 已在 P0 冻结，不再阻塞 P1 开工（见 03 准入）。

## 重开门槛（什么情况重开已定事项）

- [Required] 取消后触发数破 0：重开 P1，Scheduler claim/lease/fencing 与 outbox 核对逻辑必须复审，人复核放行前不得发版。
- [Required] missed 率或触发延迟持续超基线 2 倍：重开实验起步值（24h/15min/1min/30s/3 退避），以 P1 实测 rescues 为准重新冻结。
- [Required] S1–S3 任一结案项不达标：不得进 P3；CangjieMagic 第二实现无限期保持 Proposed。
- [Required] presentation_hash 比对失败率异常（展示与快照系统性对不上）：停在待核对，重开 stream-protocol 版本对照（thread-stream.schema.json）与卡片渲染链。
- [Required] /readyz 类型化错误（tzdb/别名表缺失）出现：服务保持不就绪，重开 deploy 单镜像构建流程，不得手动放行。
- [Proposed] 用户连续要求"范围提醒/尽快/有空时"类模糊时间：记入未支持请求列表（30 天归档、一年删除），只在用户主动查看或 v1 评审时翻出，不为此重开 v0。
