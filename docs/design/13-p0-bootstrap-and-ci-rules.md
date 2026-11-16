# 13. P0 Bootstrap 与 CI 规则设计

## 文档状态

- **状态**：草案 v0.1（design 为真源，prd 跟随）
- **范围**：P0 开工清单（命名/许可证/main 保护/monorepo/ports/glossary）、推送三问、CI 死规矩（每条映射变红测试）
- **不包含**：选型理由（见 01）、路由语义（见 10）、Spike 执行（见 11）
- **阶段标签**：P0 开工前冻结；死规矩自 P0 生效，长期有效

> 合同演进：D1–D10 和 A1–A4 保留，CI 按变更范围选择检查。授权相关的“必须逐项按钮”与时间必问按 legacy/new profile 分别覆盖，目标裁决见 [design/20 §1、§10](20-goal-scoped-delegation.md)（Proposed），不能用源码文案冻结阻止正式新合同或删除有效行为保护。

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

| #   | 死规矩                                           | 变红测试（任一红即合并不通过）                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `time-core` 禁引 `agent-runtime`/时钟/env/网络   | ① depcruise 断言 `time-core` 出边为零；② 单测注入反向钟（`TZ=Pacific/Kiritimati`、伪造 `Date.now`）结果仍与 fixture 一致；③ 删 `TZDB_VERSION` 后 `/readyz` 返回 `TZDB_UNAVAILABLE`                                                                                                                                                                      |
| D2  | 展示层禁算时间                                   | 单测：展示投影只读冻结字段；变异测试：把快照 `fire_at_utc` 改 1 小时，展示输出必须不变（否则红）；Oxlint 1.89.0 JS 插件沿用 `NewExpression[callee.name='Date']` 与 `CallExpression[callee.object.name='Date'][callee.property.name='now']`，限定 `apps/web/**/*.{ts,tsx,js,jsx}` 并保持原全局忽略路径，不扩大或缩小语法边界                             |
| D3  | `UNIQUE(task_id, fire_at)` 存在                  | 迁移扫描门：`pg_constraint` 存在性断言；并发测试：同键双写一成一 `23505`，无第二条 scheduled                                                                                                                                                                                                                                                            |
| D4  | `recreated_from` 唯一（同一旧号只有一个后继）    | 迁移扫描门 + 双写测试：同一旧 task 建第二后继必须唯一冲突                                                                                                                                                                                                                                                                                               |
| D5  | `task_events` 只追加（DB 禁 UPDATE/DELETE）      | 迁移扫描门：无该表 UPDATE/DELETE 语句/触发器；运行时测试：UPDATE/DELETE 尝试被拒绝（权限/RLS 或触发器报错）                                                                                                                                                                                                                                             |
| D6  | append-only：revision/事件/确认/审计错了另起一行 | 单测：对 `agent_revisions(name, revision)` 同 revision 二写必须失败（`UNIQUE(name, revision)`，23505）；对 `prompt_versions(name, version)` 同版本二写必须失败；`agent_revisions`/`prompt_versions` UPDATE/DELETE 与 `run_checkpoints` UPDATE/DELETE 尝试必须被 trigger 拒绝（P0001）；`tool_calls` 审计行随 #9 ToolGateway 落表，复用同一 trigger 形状 |
| D7  | 空环境冒烟                                       | `docker compose up` 全新卷 → `/healthz` 200、`GET /me` 401、`GET /brief` 401（未登录）；缺 TZDB 时 `/readyz` 503 + `TZDB_UNAVAILABLE` 类型化体                                                                                                                                                                                                          |
| D8  | 契约双跑                                         | 保留 healthz/契约包；正式 native、真实 PG 与同一业务场景在本地公共用例/签名 HTTP 两入口覆盖成功、拒绝、批准恢复、取消及重放；严格 wire 与 unknown 核心子合同分别取证；必要步骤被省略时同一根入口必须失败（§4.2）                                                                                                                                        |
| D9  | 取消后触发数=0                                   | 故障注入测试：cancel 提交后 firing 窗口内触发请求计数必须为 0（分不清先后按违规计）；破 0 写 `security_events`（一年留存，不跟 task 走）                                                                                                                                                                                                                |
| D10 | 口径天花板                                       | 文案扫描门：对外字符串禁止“一定响/必达/已读”类承诺；只允许“已记录/待排期/未观察到”类表述                                                                                                                                                                                                                                                                |

[Observed] D1 的模块规则阻断跨模块存储实现导入、允许公共用例，不解析 SQL 表归属/owner/事务；静态绿色不能替代对应人工/行为验证（02 §2、CONTRIBUTING D1）。D8 的 enforced 只适用于 manifest 明列且本次正式消费者实际执行的范围，不代表所有工具接缝或完整 R1。

## 4. CI 布局（Required）

- CI 保留三个稳定 required checks：`checks`、`database`、`integration`，分别负责静态/Web、PostgreSQL/升级、正式 native/Compose。三者独立执行，没有跨 job 构建制品或 matrix。验证入口集中在 `scripts/ci/`；`ci/` 保存门禁及 native 测试归属，`infra/` 保留产品构建、迁移与 Compose 配置。
- PR 按 base 与 checkout 的实际 diff 分类；main push 按事件的 `before` 分类，仅纯文档可跳过重检查，代码 push 仍完整验证。文档范围包括 `docs/`、`openspec/` Markdown 及根 `README.md`、`CONTRIBUTING.md`，允许删除和重命名，但同时检查新旧路径。空 diff、无效/不可用 base、删除代码、未知路径和非 push/PR 事件回退 full。Web-only 运行 verify 和 Web 构建；已知非 identity API 业务模块变更运行完整数据库业务、native 和 Compose，但跳过历史升级；仅修改独立数据库测试则只运行选中测试。`ci/native-tests.txt` 中依赖正式 native 的文件不能归类为数据库测试独立范围。
- `checks` 运行同一本地 verify，Web/full 范围另做 Web 生产构建。`database` 独占 PG16，仅构建 API 及依赖，执行原迁移、约束、并发唯一、调度和适用历史升级；不等待 Next.js 或镜像构建。`integration` 不在宿主安装 Bun 依赖，调用 `scripts/ci/runtime.sh` 构建一次当前生产镜像，同机并行运行合同和两轮全新卷 Compose；任何消费者失败都失败，退出或取消后等待消费者清理，再删除本次镜像。三个 job 均须成功；跳过的测试不作为执行证据。
- `database.sh` 在独立进程组中构建 API，与历史升级验证重叠；五个历史测试文件统一文件级限并发 2，各自使用随机数据库和临时迁移目录。业务 API 测试仍在构建成功及 SQL 检查后限并发 4 执行，不与历史测试叠加；退出/取消时回收构建进程组。历史迁移仍从原始状态真实执行，不引入模板库。
- 每个 job 独立满足自己的构建前置，不借用其他 job 的 `dist/`。`bun run build:packages` 保留 Bun 按依赖拓扑构建共享包，`bun run build` 先包后应用，`bun run build:api` 构建 API 及依赖；开发、类型检查和测试入口同样先满足包依赖。共享包构建成功后，`typecheck` 使用 Bun `--sequential` 串行执行各 workspace 的类型检查，保留全部源码、测试与 Next route typegen。同次 `verify` 仅在 `typecheck` 成功后允许单元步骤复用其共享 packages；失败即停、不消费失败构建。独立单元入口及跳过 typecheck 的 verify 仍真实构建，不通过旧 `dist/` 或跨次运行标记判定准备完成。
- 测试使用 `bun:test`，保留既有断言、文件级状态隔离及 mock/spy/时钟恢复，不把文件级并行换成共享状态的用例内 concurrent。只读边界 fixture 最多同时启动两个真实 dependency-cruiser CLI。`bun run test:unit` 排除数据库集与正式 native 合同集；`bun run test:contracts` 经 `scripts/ci/runtime.sh contracts` 独立构建并运行合同及 `ci/native-tests.txt` 中的 native 集成文件。CI 数据库全量入口排除这份清单，防止缺 native 的静默跳过及重复执行；native 文件中的数据库场景一并在正式镜像执行。D9 仍包含在数据库集，不重复跑指定子集。DB 使用真实 PG16、原迁移和明确测试环境，不削弱约束换绿。
- D1 继续由 Bun 下的 dependency-cruiser 执行原出边、契约依赖与环检测规则；D2 仍由 AST 插件及展示投影测试守护，不以独立文本扫描代替。非 D2 lint 规则须显式映射并记录差异，不整体关闭正确性规则或扩大 ignore。
- `runtime.sh` 唯一拥有本次镜像构建与清理；内部 `contracts.sh` 和 `compose-smoke.sh` 只消费它提供的镜像。Compose 使用基础配置加 `infra/compose/ci.yaml`，禁止隐式构建/拉取 API 镜像，不使用带用户外部卷的 `local.yaml`。两轮全新卷检查缺/有 `TZDB_VERSION` 的 readiness、healthz 与未认证业务401。正式镜像的 frozen install、API/native 编译和运行方式不变。
- CI 专用 Compose override 清空 PostgreSQL 的宿主端口发布，仅让 API 动态绑定 `127.0.0.1`；smoke 在每次全新卷启动后查询实际端口，不占用或探测其他本机服务。产品基础 Compose 与本地安装配置保持原端口合同。
- CI Buildx 使用 Actions 缓存持久化 Docker 层，键包含 Dockerfile、工具链锁、Bun 锁及提交；恢复旧缓存后仍由当前构建输入决定命中，不复用旧测试通过结果。每次仍执行必需消费者和 D8 本次报告校验。保留 Linux x64 正式工具链与动态库闭包；不引入跨 job 镜像分发或第二套生产镜像。
- 正式 Dockerfile 在 API 构建前仅复制依赖 manifest/锁、共享包与 API 源码及 TypeScript 编译配置，构建后再复制完整受 `.dockerignore` 约束的上下文。测试、文档和 Web 源码仍进入镜像，但不使 API 编译层失效；依赖、编译配置或编译源码变化仍必须重建。最终 native 动态库、运行资源和启动命令保持不变。

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
- Oxfmt 保留宽度 100、单引号、生成目录与 `next-env.d.ts` 排除；`bun.lock` 由 Bun 维护。禁用新增的 package.json 排序，不开启 import 或 Tailwind 排序；格式检查返回非零仍阻塞 CI。

### 4.2 D8 正式 Harness 消费者合同（Required）

`bun run test:contracts` 是本地合同命令，调用 `scripts/ci/runtime.sh contracts`；CI 的同一入口省略参数，额外运行 Compose。两种模式均自行构建当前树镜像，不接受调用方的预置镜像。执行环境为 Linux x64（Windows 使用 WSL）与 Docker；合同消费者自建独立网络和全新 PG16，仅传本次测试身份 secret，不继承个人数据库或模型配置。缺前置即失败，必需消费者不得跳过。

入口从当前工作树构建 `infra/docker/Dockerfile` 的生产镜像，在同一固定 Bun/native runtime 中执行合同，避免编译镜像与宿主 ABI 不一致。锁定 SDK/stdx、正式仓颉源与动态库闭包沿用生产构建，不改用旧 `dist/`、预置 ELF 或脚本 Harness。可复用与当前输入完全一致的 Docker 层缓存；这不等于借用另一个 job 的产物。每次使用独立镜像标签、容器及报告目录；成功、失败均清理本次资源，不删除用户数据库或其他镜像标签。

测试只控制 OpenAI-compatible 模型 HTTP 响应；native 仍完成工具提议解析、调用引用、实际结果纳入、循环、预算与停止。每个 PG 测试文件沿用 `createIntegrationDatabase()` 应用原迁移，使用随机 schema；签名 HTTP 走真实身份/CSRF、SSE 和读取接口。本地入口使用相同公共用例、正式 native 与工具实现，不手工推进 answer/finish 冒充 Agent。

| 合同                         | 必须观察的消费者结果                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一批准场景的本地/HTTP 双跑 | 初段真实挂起且不建 task；pending 继续被拒；按钮确认只建原 task；同 Run 唯一后继 attempt；native 下一模型请求观察原批准决议和真实 task ID，最终回答与 PG task 精确关联         |
| 拒绝、工具参数拒绝与错误状态 | 原批准拒绝后 native 失败且不重提；非法工具参数的真实 denied 被 native 消费；错 checkpoint、终态后新继续和旧 attempt 不推进事实                                                |
| 取消与重放                   | 已提交取消中断实际模型连接，唯一 cancelled 且无成功回答；迟到调用不产生效果；同入站键/继续键/取消键重放及 GET 补读不新建 Run、attempt、工具或 task                            |
| 公共 DTO 与 native wire      | 额外权威字段、非法版本/关联引用/结果结构被各自真正消费者拒绝；公共 HTTP 拒绝在 SSE/写入前发生，不假装 HTTP 客户端可提交内部 pipe 帧                                           |
| unknown 核心子合同           | 真实非事务调用核心的许可与实际 fsync 效果后强杀，重交得到真实 unknown；正式 native 消费后停下，不再次模型/预约/调用；原调用仍 unknown、无 accepted_result，实际文件字节不重复 |

unknown 子合同使用测试专用协议对端连接真实调用核心和正式 native，不把内部探针注册成产品工具。对端如需确认 snapshot/finish，必须先真实保存本次协议观察，不回随机未落地引用或手写 accepted 业务结果；保存位置属于测试夹具，不作为生产可恢复快照。该项不证明生产 RunAuthority 接受 unknown 快照、unknown 跨请求恢复或产品 HTTP 外部工具。原业务工具的 local/read_only 合同、通用非事务调用核心合同与 §4.3 的文件产品合同分别声明。

`ci/gates.json` 的 D8 沿用 `status/scope/owner/enforced_by`、必需消费者 case ID 列表及 remaining 的 partial 范围，不建立通用能力注册表。case ID 是执行证据接口，不锁定测试描述或生产函数名。根入口要求本次 Bun 实际报告中每个必需 ID 唯一通过且非 skipped；本地、HTTP 与独立子合同各有自己的 ID。缺报告、缺 case、重复或跳过、消费者非零退出均失败，旧 healthz/契约包绿色不能补足。报告放本次唯一目录，不读旧报告；代码变更时 `checks` 仅校验声明、证据文件及报告解析边界，不启动 PG/native。

必要步骤负例在隔离临时源/构建上下文中运行，不给生产代码加 bypass 开关。省略当前 native 构建、移除消费者集合或其执行步骤，根入口必须失败；这类前置/发现失败不冒充业务 Red。分别省略真实结果纳入和执行资格裁决后，同一消费者必须因错误结果或具体越权效果变红，而非缺依赖、格式错误或超时。记录 baseline、单项变异和恢复后的实际结果；变异证据不冒充测试先行。

有限 enforced 只覆盖 manifest 明列且本次正式消费者实测的行为。未列入的工具/连接器合同、真实 provider 任务质量、完整 R1 用户材料验收、任意崩溃恢复、unknown 的通用产品恢复及 external exactly-once 保持 partial/Deferred；不能由 scope 文案、文件存在或绿色 job 名升级。

### 4.3 R1 文件/MCP 扩展的证据准入（Required）

[14 §11](14-r1-document-task-loop.md) 的文件、文档批准和实际 MCP 消费者沿用既有根入口和按范围执行的 CI 检查；精确 case ID 与本次报告共同限定 `ci/gates.json` 的执行范围。文件产品消费者覆盖原生循环中的实际 SDK 观察、精确批准、唯一替换、独立新读、写前冲突的新批准链，以及写后接受失败的 unknown；已写入但缺少新读取时必须拒绝完成。取消先提交的零新增动作另取真实等待及竞争证据。受控模型只证明这些反馈合同，真实 provider 的任务质量、实际产物和用户材料验收分别取证。

## 引用

- B06§12 全文；01/02/09/10/11/12。
