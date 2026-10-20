# 13. P0 Bootstrap 与 CI 规则设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：P0 开工清单（命名/许可证/main 保护/monorepo/ports/glossary）、推送三问、CI 死规矩（每条映射变红测试）
- **不包含**：选型理由（见 01）、路由语义（见 10）、Spike 执行（见 11）
- **阶段标签**：P0 开工前冻结；死规矩自 P0 生效，长期有效

## 标记约定

Observed / Required / Proposed / Deferred 同 01。

## 1. P0 开工清单（Required，半天级，B06§12-P0）

| #   | 项                   | 冻结内容                                                                                                                            |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 命名                 | 项目英文名 + 中文名（中性，容纳提醒/待办/Agent 三义）；仓库 `Along-agent` 保持                                                      |
| 2   | 许可证               | Apache-2.0 或 MIT 二选一，写进 README（一句话 + v0 范围 + 不承诺口径）                                                              |
| 3   | 分支                 | `main` 禁直推（约定式：私有免费版无强制保护，升级后再启用 required review + CI）；`.gitignore`（secrets/`.env`/运行时数据不进 Git） |
| 4   | monorepo             | 01 §2 布局建空目录 + 读写占位 `README`；`apps/api` 三角色 `main.ts` 空分发                                                          |
| 5   | ports                | api `3000`（`ROLE=all`）、web `3100`；`DATABASE_URL`、`TZDB_VERSION` 环境变量占位                                                   |
| 6   | glossary             | `docs/references/glossary.md`：task/approval/normalize/幂等/outbox/门禁/墓碑/回执，一句话一个                                       |
| 7   | 鉴权                 | Better Auth 自建 credential（已定：D7 空环境冒烟不依赖外部 IdP；v0 单租户）                                                         |
| 8   | 推送三问（风险先验） | 通知渠道三问（见 §2），答不上按降级写，不许假设                                                                                     |

## 2. 推送三问（Required，B06§12-风险先验）

开工第一周向所选通知渠道（v0 先站内通知 + 活动页）确认，答不上按括号内降级写：

1. 认幂等键吗？（不认 → Notifier 自存键 + 去重表，同一键二次 send 直接回原回执）
2. 能按键查状态吗？（不能 → `ACK_UNKNOWN` 只核对不重发：30s/2min/5min 各核一次，仍未知转持久对账）
3. 取消能拦住已收的吗？（不能 → 触发门禁本机拦截 + 对外明示“系统排期是否撤掉仍无法确认”）

## 3. CI 死规矩（Required，每条必有变红测试）

| #   | 死规矩                                           | 变红测试（任一红即合并不通过）                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `time-core` 禁引 `agent-runtime`/时钟/env/网络   | ① depcruise 断言 `time-core` 出边为零；② 单测注入反向钟（`TZ=Pacific/Kiritimati`、伪造 `Date.now`）结果仍与 fixture 一致；③ 删 `TZDB_VERSION` 后 `/readyz` 返回 `TZDB_UNAVAILABLE`                                                                                                                                                                      |
| D2  | 展示层禁算时间                                   | 单测：展示投影只读冻结字段；变异测试：把快照 `fire_at_utc` 改 1 小时，展示输出必须不变（否则红）；grep 门：`apps/web` 禁止 `new Date(` 参与拼装（白名单仅解析展示字符串）                                                                                                                                                                               |
| D3  | `UNIQUE(task_id, fire_at)` 存在                  | 迁移扫描门：`pg_constraint` 存在性断言；并发测试：同键双写一成一 `23505`，无第二条 scheduled                                                                                                                                                                                                                                                            |
| D4  | `recreated_from` 唯一（同一旧号只有一个后继）    | 迁移扫描门 + 双写测试：同一旧 task 建第二后继必须唯一冲突                                                                                                                                                                                                                                                                                               |
| D5  | `task_events` 只追加（DB 禁 UPDATE/DELETE）      | 迁移扫描门：无该表 UPDATE/DELETE 语句/触发器；运行时测试：UPDATE/DELETE 尝试被拒绝（权限/RLS 或触发器报错）                                                                                                                                                                                                                                             |
| D6  | append-only：revision/事件/确认/审计错了另起一行 | 单测：对 `agent_revisions(name, revision)` 同 revision 二写必须失败（`UNIQUE(name, revision)`，23505）；对 `prompt_versions(name, version)` 同版本二写必须失败；`agent_revisions`/`prompt_versions` UPDATE/DELETE 与 `run_checkpoints` UPDATE/DELETE 尝试必须被 trigger 拒绝（P0001）；`tool_calls` 审计行随 #9 ToolGateway 落表，复用同一 trigger 形状 |
| D7  | 空环境冒烟                                       | `docker compose up` 全新卷 → `/healthz` 200、`GET /me` 401、`GET /brief` 401（未登录）；缺 TZDB 时 `/readyz` 503 + `TZDB_UNAVAILABLE` 类型化体                                                                                                                                                                                                          |
| D8  | 契约双跑                                         | 同一 `contracts.test.ts` 在进程内与 HTTP 双跑；任一模式红即红                                                                                                                                                                                                                                                                                           |
| D9  | 取消后触发数=0                                   | 故障注入测试：cancel 提交后 firing 窗口内触发请求计数必须为 0（分不清先后按违规计）；破 0 写 `security_events`（一年留存，不跟 task 走）                                                                                                                                                                                                                |
| D10 | 口径天花板                                       | 文案扫描门：对外字符串禁止“一定响/必达/已读”类承诺；只允许“已记录/待排期/未观察到”类表述                                                                                                                                                                                                                                                                |

## 4. CI 布局（Required）

- `static` 一次安装后执行 `node scripts/verify.mjs`，顺序与本地相同，涵盖 lint、typecheck、depcruise、治理脚本、unit、OpenSpec 与阻塞式 format。
- `migration-scan(D3/D4/D5/D6)`、`scheduler-fault(D9)`、`contracts-dual(D8)` 只依赖 `static`，各自独立执行，不共享数据库状态。
- `compose-smoke(D7)` 依赖上述三个 job 全部通过；任一失败即禁止合并。Required checks 为这五个工具链无关的 job 名。
- Spike 报告（S1–S3）走独立 job，不阻塞主链，但 P2 末缺报告即“未结案”（见 11）。

## 引用

- B06§12 全文；01/02/09/10/11/12。
