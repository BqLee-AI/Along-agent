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
| 4   | monorepo             | 01 §2 布局；Bun 1.4.2 workspaces + 单一 bun.lock，根 scripts 显式安排依赖优先构建（ADR 0006）；`apps/api` 三角色入口                |
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

| #                                                                                                                                                                                                                                                                                   | 死规矩                                           | 变红测试（任一红即合并不通过）                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                                                                                                                                                                                                                                                                                  | `time-core` 禁引 `agent-runtime`/时钟/env/网络   | ① depcruise 断言 `time-core` 出边为零；② 单测注入反向钟（`TZ=Pacific/Kiritimati`、伪造 `Date.now`）结果仍与 fixture 一致；③ 删 `TZDB_VERSION` 后 `/readyz` 返回 `TZDB_UNAVAILABLE`                                                                                                                                                                      |
| D2                                                                                                                                                                                                                                                                                  | 展示层禁算时间                                   | 单测：展示投影只读冻结字段；变异测试：把快照 `fire_at_utc` 改 1 小时，展示输出必须不变（否则红）；Oxlint 1.89.0 JS 插件沿用 `NewExpression[callee.name='Date']` 与 `CallExpression[callee.object.name='Date'][callee.property.name='now']`，限定 `apps/web/**/*.{ts,tsx,js,jsx}` 并保持原全局忽略路径，不扩大或缩小语法边界                             |
| D3                                                                                                                                                                                                                                                                                  | `UNIQUE(task_id, fire_at)` 存在                  | 迁移扫描门：`pg_constraint` 存在性断言；并发测试：同键双写一成一 `23505`，无第二条 scheduled                                                                                                                                                                                                                                                            |
| D4                                                                                                                                                                                                                                                                                  | `recreated_from` 唯一（同一旧号只有一个后继）    | 迁移扫描门 + 双写测试：同一旧 task 建第二后继必须唯一冲突                                                                                                                                                                                                                                                                                               |
| D5                                                                                                                                                                                                                                                                                  | `task_events` 只追加（DB 禁 UPDATE/DELETE）      | 迁移扫描门：无该表 UPDATE/DELETE 语句/触发器；运行时测试：UPDATE/DELETE 尝试被拒绝（权限/RLS 或触发器报错）                                                                                                                                                                                                                                             |
| D6                                                                                                                                                                                                                                                                                  | append-only：revision/事件/确认/审计错了另起一行 | 单测：对 `agent_revisions(name, revision)` 同 revision 二写必须失败（`UNIQUE(name, revision)`，23505）；对 `prompt_versions(name, version)` 同版本二写必须失败；`agent_revisions`/`prompt_versions` UPDATE/DELETE 与 `run_checkpoints` UPDATE/DELETE 尝试必须被 trigger 拒绝（P0001）；`tool_calls` 审计行随 #9 ToolGateway 落表，复用同一 trigger 形状 |
| D7                                                                                                                                                                                                                                                                                  | 空环境冒烟                                       | `docker compose up` 全新卷 → `/healthz` 200、`GET /me` 401、`GET /brief` 401（未登录）；缺 TZDB 时 `/readyz` 503 + `TZDB_UNAVAILABLE` 类型化体                                                                                                                                                                                                          |
| D8                                                                                                                                                                                                                                                                                  | 契约双跑                                         | 同一 `contracts.test.ts` 在进程内与 HTTP 双跑；任一模式红即红                                                                                                                                                                                                                                                                                           |
| D9                                                                                                                                                                                                                                                                                  | 取消后触发数=0                                   | 故障注入测试：cancel 提交后 firing 窗口内触发请求计数必须为 0（分不清先后按违规计）；破 0 写 `security_events`（一年留存，不跟 task 走）                                                                                                                                                                                                                |
| D10                                                                                                                                                                                                                                                                                 | 口径天花板                                       | 文案扫描门：对外字符串禁止“一定响/必达/已读”类承诺；只允许“已记录/待排期/未观察到”类表述                                                                                                                                                                                                                                                                |
| [Observed] D1 的模块规则阻断跨模块存储实现导入、允许公共用例，不解析 SQL 表归属/owner/事务；静态绿色不能替代对应人工/行为验证（02 §2、CONTRIBUTING D1）。D8 当前只证明最小 healthz 双跑/partial，不证明仓颉 Harness、等待/恢复或工具合同；目标补证沿既有入口，本次不改门状态与 CI。 |

## 4. CI 布局（Required）

- `static` 使用 Bun 1.4.2 执行 `bun install --frozen-lockfile`，随后运行本地同一 `bun run verify`：`lint → typecheck → depcruise → gate-manifest → gates-executable → frozen-names → copy-claims → test:unit → OpenSpec 严格校验 → format:check`。保留 `scripts/verify.mjs` 的 Bun/Node 调用兼容性，内部统一执行 Bun 命令；任一步非零即停，Oxfmt 0.74.0 格式检查仍阻塞。
- `migration-scan(D3/D4/D5/D6)`、`scheduler-fault(D9)`、`contracts-dual(D8)`、`compose-smoke(D7)` 四条下游都只依赖 `static`，static 通过后各自隔离并行；static 失败则阻止全部下游，不共享可变数据库或用户数据。
- Required checks 仍为这五个工具链无关的 job 名，必须全部成功才允许合并。Compose 不等待三个 DB/契约 job；权衡是其中一项失败时 Compose 可能已经消耗构建与冒烟资源，以换取通过路径不再串行等待，不削弱任何 SQL、并发、故障、契约或 D7 断言。私有免费版的人工保护约定不变（见 §1）。
- 每个 job 独立满足自己的构建前置，不借用其他 job 的 `dist/`。`bun run build:packages` 保留 Bun 按依赖拓扑构建共享包，`bun run build` 先包后应用，`bun run build:api` 构建 API 及依赖；开发、类型检查和测试入口同样先满足包依赖。共享包构建成功后，`typecheck` 使用 Bun `--sequential` 串行执行各 workspace 的类型检查，保留全部源码、测试与 Next route typegen。同次 `verify` 仅在 `typecheck` 成功后允许单元步骤复用其共享 packages；失败即停、不消费失败构建。独立单元入口及跳过 typecheck 的 verify 仍真实构建，不通过旧 `dist/` 或跨次运行标记判定准备完成。
- 测试使用 `bun:test`，保留既有测试集合、断言与文件级状态隔离；文件级并行不能替换成共享状态用例的文件内 concurrent，mock/spy/时钟按原生命周期恢复。只有只读边界 fixture 使用文件内并发，最多同时启动两个真实 dependency-cruiser CLI；各红例仍独立检查退出码、规则名与实际解析目标，绿例保留 err/JSON 两种真实扫描，清理前等待已排队及运行中的 CLI 结束。`bun run test:unit` 只跑非数据库集；`bun run test:contracts` 包含 API `contracts.test.ts` 的进程内/HTTP 两组及契约包；`bun run test:integration` 包含全部 9 个 DB 文件；`bun run test:scheduler` 跑 D9 指定集。DB 测试使用真实 PostgreSQL 16、原迁移和明确测试环境，不以跳过约束断言换绿。static 内部调度依据见 ADR 0008。
- D1 继续由 Bun 下的 dependency-cruiser 执行原出边、契约依赖与环检测规则；D2 仍由 AST 插件及展示投影测试守护，不以独立文本扫描代替。非 D2 lint 规则须显式映射并记录差异，不整体关闭正确性规则或扩大 ignore。
- `compose-smoke` 宿主不安装没有宿主消费者的依赖；构建真实 Dockerfile，在镜像内执行固定 Bun 的 fresh frozen install、依赖优先构建并以 Bun 启动服务，不要求宿主机 `dist/`，不引入缓存捷径。两轮全新卷分别检查缺失/显式提供 `TZDB_VERSION`：`/healthz` 200，未登录 `/api/v1/me`、`/api/v1/brief` 401；缺 TZDB 的 `/readyz` 503 + `TZDB_UNAVAILABLE`，提供后 200。不改变 D7 角色或就绪语义。编排及失败传播的局部修订见 ADR 0007，Bun/Ox 工具选型仍遵循 ADR 0006。
- [Required] 仓颉 Harness 后续构建/真实消费者验证按能力进入已有五门流程；旧 Spike S1–S3 不再是候选第二实现转正门（11），本次不新增 job、不提前宣称 R1 已通过。

### 4.1 非 D2 lint 规则映射

旧 `typescript-eslint.configs.recommended` 不包含 `eslint:recommended`。原 20 条 TS 规则与 TS-only 的 4 条 core 规则均保留为 `error`；Oxlint 额外 correctness 规则为 `warn`，不降低下列错误级别。配置只加载 `eslint`、`typescript` 和仓库 D2 插件，不借工具默认值新增其他规则集。

| 原规则                                                   | Oxlint 1.89.0 规则                               |
| -------------------------------------------------------- | ------------------------------------------------ |
| `@typescript-eslint/ban-ts-comment`                      | `typescript/ban-ts-comment`                      |
| `@typescript-eslint/no-array-constructor`                | `no-array-constructor`                           |
| `@typescript-eslint/no-duplicate-enum-values`            | `typescript/no-duplicate-enum-values`            |
| `@typescript-eslint/no-empty-object-type`                | `typescript/no-empty-object-type`                |
| `@typescript-eslint/no-explicit-any`                     | `typescript/no-explicit-any`                     |
| `@typescript-eslint/no-extra-non-null-assertion`         | `typescript/no-extra-non-null-assertion`         |
| `@typescript-eslint/no-misused-new`                      | `typescript/no-misused-new`                      |
| `@typescript-eslint/no-namespace`                        | `typescript/no-namespace`                        |
| `@typescript-eslint/no-non-null-asserted-optional-chain` | `typescript/no-non-null-asserted-optional-chain` |
| `@typescript-eslint/no-require-imports`                  | `typescript/no-require-imports`                  |
| `@typescript-eslint/no-this-alias`                       | `typescript/no-this-alias`                       |
| `@typescript-eslint/no-unnecessary-type-constraint`      | `typescript/no-unnecessary-type-constraint`      |
| `@typescript-eslint/no-unsafe-declaration-merging`       | `typescript/no-unsafe-declaration-merging`       |
| `@typescript-eslint/no-unsafe-function-type`             | `typescript/no-unsafe-function-type`             |
| `@typescript-eslint/no-unused-expressions`               | `no-unused-expressions`                          |
| `@typescript-eslint/no-unused-vars`                      | `no-unused-vars`                                 |
| `@typescript-eslint/no-wrapper-object-types`             | `typescript/no-wrapper-object-types`             |
| `@typescript-eslint/prefer-as-const`                     | `typescript/prefer-as-const`                     |
| `@typescript-eslint/prefer-namespace-keyword`            | `typescript/prefer-namespace-keyword`            |
| `@typescript-eslint/triple-slash-reference`              | `typescript/triple-slash-reference`              |
| `no-var`（仅 TS）                                        | `no-var`（仅 TS）                                |
| `prefer-const`（仅 TS）                                  | `prefer-const`（仅 TS）                          |
| `prefer-rest-params`（仅 TS）                            | `prefer-rest-params`（仅 TS）                    |
| `prefer-spread`（仅 TS）                                 | `prefer-spread`（仅 TS）                         |

- `no-unused-vars` 显式配置 `after-used`、检查 catch、无下划线忽略，并启用 `reportVarsOnlyUsedAsTypes`；仅被 `typeof` 类型查询引用的值仍报错。Oxlint 整体跳过 `.d.ts`，不同于旧规则的逐声明处理；仓库声明文件为 Next 生成文件，不靠此规则检查它。
- `no-unused-expressions` 显式启用 `ignoreDirectives`，使 `'use client'` 合法；short-circuit、ternary、tagged template 仍不放行。`void` 表达式与 `this as T` 的既有语法行为不变。
- `no-array-constructor` 的原生差异：Oxlint 放行被局部变量遮蔽的 `Array`，额外拒绝单 spread 参数形式。该差异不是 D2 的 Date 遮蔽行为；D2 仍原样匹配 selector，不做 scope 放宽。
- `scripts/test/lint.test.ts` 用真实 CLI 检查 D2 的 17 个拒绝位置、合法语法/目录/扩展名/忽略路径，以及 explicit any、下划线及类型位置未使用值、无用表达式的拒绝行为。故意非法的 lint fixture 只作为测试输入，不参与根 lint/format；业务与测试代码本身不豁免。
- Oxfmt 保留宽度 100、单引号、生成目录与 `next-env.d.ts` 排除；`bun.lock` 由 Bun 维护。禁用新增的 package.json 排序，不开启 import 或 Tailwind 排序；格式检查返回非零仍阻塞 verify/static。

## 引用

- B06§12 全文；01/02/09/10/11/12。
