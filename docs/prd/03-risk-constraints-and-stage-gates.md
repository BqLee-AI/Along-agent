# 03 风险、约束与阶段门

> 状态：草案 / 范围：v0 Top 风险、硬约束、可测指标、阶段准入准出、对外口径 / 不包含：Spike 执行步骤（见 agent/04）、部署操作（见 deploy）/ 阶段：P0–P2

## Top3 风险

- [Required] R1 时间语义算错：DST 不存在/歧义时刻、时区未确认却解析"明天"、展示层私自换算。对策：time-core 纯函数唯一权威；LLM 不算时间；展示层只读冻结字段；错误码 NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME（带两候选）/ UNKNOWN_TIMEZONE / TZDB_UNAVAILABLE。
- [Required] R2 确认与调度缝隙：重复确认建出双 task、确认与消费之间快照被改、Approval 消费与建 Task 非原子。对策：presentation_hash 比对（PRESENTATION_MISMATCH 即停）；消费 + 建 Task 同事务（唯一跨模块事务）；重复确认只回同一 task。
- [Required] R3 触发恰好一次失效：取消与触发竞态、重试放大、outbox 重放。对策：取消赢过一切（取消提交后排队重试全作废）；outbox 验版本发请求记结果 + 幂等键；发了没回只核对不重发；取消后触发数 = 0 为一级指标，破 0 记 security_events（一年，不跟 task 走，不留内容），人复核放行。

## 硬约束（摘录，细则见 design/api/schema）

- [Required] task_events 只追加，DB 禁 UPDATE/DELETE；UNIQUE(task_id,fire_at)；recreated_from 唯一。
- [Required] 除 approval 消费 + 建 task 外，禁止跨模块事务；模块自有 schema，跨模块只传 id；领域事件走 outbox。
- [Required] /readyz 类型化错误不降级：规则缺失（tzdb/别名表）则服务不就绪；归一禁引 CangjieMagic 由构建依赖图在 CI 拦。
- [Required] AG-UI 投影走 packages/stream-protocol 版本化 zod；事件名开工对照 thread-stream.schema.json。
- [Required] 仓颉永不直连业务库、不做时间归一；v0–P3 不用第二实现。

## 指标（一级与校准中）

| 指标 | 目标 | 级别 |
| --- | --- | --- |
| 取消已提交后仍发出的触发请求数 | = 0 | 一级（破 0 即事故，记 security_events） |
| 超 15 分钟未触发 | 标 missed，不补发 | Required（15min 为实验起步值，待校准） |
| 重复确认建出第二 task 数 | = 0 | Required |
| kill -9 后 resume 副作用次数 | 恰好一次 | Required（S2 结案标准） |
| 回显有效期 / 锚龄线 / 心跳 / 扫表周期 / 重试上限 | 24h / 1min / 30s / 30s / 3 次退避 | 全为待校准实验起步值（B06 迁移云端），P1 末复核 |

- [Required] 06 的 24h / 15min / 1min / 30s / 3 退避迁云端后全是待校准实验起步值：P1 只考核方向性达标，数值冻结需 P1 实测复核（见 04 重开门槛）。
- [Proposed] 触发窗口内送达率、简报打开聚合延迟：P1 只采集基线，不设硬目标。

## 阶段准入准出

- [Required] P0 准出：鉴权二选一拍板；Deferred 清单阻塞项认领到阶段；time-core 四测例（顺的/不存在的/没选的/选了的）先行通过。
- [Required] P1 准入：P0 准出达成；contracts 契约测试进程内可跑。P1 准出：v0 验收全绿（见 04）+ 五缝接口 Fake 全通 + 取消后触发数 = 0 实测。
- [Required] P2 准出：Spike S1–S3 结案——S1 契约全绿 + 100 并发首 token ≤150ms + 30min RSS 不涨 + cancel 2s 内；S2 kill -9 后 resume 副作用恰好一次；S3 200 卡片 zod 通过率≥TS 基线 −2pt + MCP 经网关 + OTel 贯通 + 镜像构建 ≤10min。任一不满足不得进 P3。
- [Deferred] P3 准入含 propose_task 排期回调联调；P4/Electron 与 P5/规模化门另行立项。

## 对外口径（不承诺）

- [Required] 天花板：登记回执只证明调度收了，不证明必触发；只说已记录步骤可核对，不承诺到点必达。
- [Required] 确认时显示："提醒已保存在服务端；到点会在调度器成功运行时尝试通知。调度器停机、队列积压或进程未运行时可能错过。"
- [Required] 取消后触发数分不清先后按违规计，但明说"不等于认定确在取消后发出"；程序摆证据、人复核放行。
- [Required] 未观测到的能力不作承诺引用，以自家可测指标为准。
