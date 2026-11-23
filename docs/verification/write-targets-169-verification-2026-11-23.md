# #169 关键写操作目标与字节核对

> 日期：2026-11-23。
> 基线：main `ea01db0452fa53509958412a14734901acfdbf60`；实施分支 `fix/169-write-targets`。
> 范围：合成资料、正式 TS 工具网关、任务公共事务/PG 调度撤销、真实 MCP 和文件系统；生产逻辑未修改。
> 限制：不是原安装、真实 provider 或 Web/native 的新一轮自然语言验收；不将受控参数测试当作模型选目标的可靠性证明。

## 结论与修复范围

错误 ID/元数据错配、自洽但无关的目标、同名歧义均被现行网关拦截；唯一和日期明确的目标正常执行，并经真实 PG 撤销回执转为 `cancelled`。文件撞名保持原文件，替代文件实际字节与提交的 `content` 一致。本轮没有复现需要修改生产逻辑的缺口，只补强回归覆盖，不重复实现已有范围门，不增加审批、意图解析器或内容自动修正。

这不撤销历史误取消和多换行的失败结论，也不能据此关闭任意自然语言目标选择风险。

## 历史精确内容和归因边界

### #118 错误目标和同名歧义

依据：[PR #119 正文及评论](https://github.com/BqLee-AI/Along-agent/pull/119)、[归档任务记录](../../openspec/changes/archive/2026-11-12-refactor-assistant-capability-authorization/tasks.md) 的 #118 段落。

- 早期真实事故：取消工具收到另一条已有提醒的 ID，目标外提醒实际取得撤销回执。公开材料确认到参数错配；没有恢复当次完整原话、完整工具参数及原任务全文，不能编造字面重放或模型内部成因。
- 另一受保护样本：用户只提供同名事项，完整列表有两个候选，模型自行提交一条；ID、事项、时间和时区四字段自洽，临时 DB 保护挡住写入，两个候选均无 `cancel_requested`。它说明仅核对四字段不足，不是现行范围门的失败证据。
- 后续已有修复：新 Run 冻结 `scope/1`，写入前核对有限支持的原话范围、当前同名集合和可信展示候选；旧 Run 不扩权。历史独立回归及实际旅程见上述 PR，不记作本轮执行。

本轮用下表明确的合成原话和工具参数重建这两种故障形态，不称恢复了历史原始请求。

### #104 撞名改名的换行

[事前确认记录](https://github.com/BqLee-AI/Along-agent/pull/139#issuecomment-6799174595)的完整输入：

> 请在输出目录创建 `acceptance.md`，内容是‘撞名改名验收完成。’；如果这个名字已存在，请保留原文件，改用 `acceptance-copy.md`，再读回新文件。

原文件预期内容为 `原有文件，请保留。`；新文件预期为 `撞名改名验收完成。`，UTF-8 27 字节、不带换行。历史实际新文件为该文本加 `\n`，28 字节；原文件哈希不变。历史两次创建冻结内容均已有换行，且创建与新读一致。详见[证据矩阵“撞名与登记外失败的只读分析”](assistant-delegation-104-evidence-matrix.md#撞名与登记外失败的只读分析)。

历史没有持久化 provider 原始工具参数，不能断言已经直接观察到模型输出多换行，也不能以文件内容不符直接归罪发布器。本轮显式提交无换行和有换行两种 `content`，分别验证链路保持原字节；不从自然语言抽取内容来静默覆盖模型参数。

## 本轮场景与实际效果

### 取消：5 个新增收据场景

位置：`apps/api/test/integration/direct-reminder.test.ts`，`checks actual cancellation receipts for ...`。

每例独立合成 owner，通过任务公共创建事务建立两条提醒并运行真实排期阶段，先核对两条均为 `scheduled`。所有取消均经 `reserveToolInvocation` / `invokeTool`，没有临时触发器替网关挡写。

| 场景                      | 用户原话与提交参数                                                                               | 实际结果                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 错 ID，元数据来自请求目标 | `取消“核对报告”这条提醒。`；ID 指向“另一条”，其余字段来自“核对报告”                              | `clarify`；两条仍 scheduled；零取消请求、零撤销回执     |
| 自洽但无关的目标          | 同上原话；ID、名称、时间和时区全来自“另一条”                                                     | `clarify`；两条仍 scheduled；零取消请求、零撤销回执     |
| 自洽的同名歧义误选        | 同上原话；两条均名“核对报告”，分别为 2027-11-04/05 09:20 Asia/Shanghai；提交第二条的完整自洽字段 | `clarify`；两条仍 scheduled；零取消请求、零撤销回执     |
| 明确唯一目标              | `取消“另一条”这条提醒。`；提交唯一“另一条”的完整字段                                             | 先 cancel_pending；真实 cancel phase 后仅该条 cancelled |
| 明确日期目标              | `取消“核对报告”2027年11月5日那条。`；两条同名，提交 11 月 5 日条目                               | 先 cancel_pending；真实 cancel phase 后仅该条 cancelled |

两项正控制均核对取消 outbox 为 `dispatched`，存在 `pg-cancel:` 回执，且 `task_events.cancelled.evidence_ref` 与同一回执完全一致；未选条目保持 `scheduled`。

复用并本轮执行的现有覆盖还包括：否定取消、全部同名、未来集合及精确前缀范围、owner/事务失败、可信序号、伪造候选、候选增删、日期歧义和唯一后继。对应 `direct-reminder.test.ts`、`target-continuation.test.ts`；不改变有限表达合同。

### 文件：3 组精确提交字节

位置：`apps/api/test/integration/delegated-workspace-gateway.test.ts`，`preserves submitted bytes after collision`。

使用合成登记、实际 `workspace_create`、MCP `workspace_read` 和独立 `readFile`。测试中的 `output/occupied.txt` / `output/alias.txt` 分别承载碰撞原文件与替代文件，原文件哨兵为 `existing`；不是重用历史安装文件。

| 明确提交的 content（转义表示） | 实际核对                                      |
| ------------------------------ | --------------------------------------------- |
| `撞名改名验收完成。`           | 替代文件严格等于 UTF-8 27 字节，无尾换行      |
| `撞名改名验收完成。\n`         | 替代文件严格等于 UTF-8 28 字节，保留一个 LF   |
| `\uFEFF中文😀\r\n`             | BOM、非 BMP 字符与 CRLF 按 UTF-8 字节原样保留 |

每例都先取得 `create_conflict/zero_write:true`，独立核对原文件仍为 `existing`；随后别名创建，独立读取字节严格等于 `Buffer.from(content, 'utf8')`。旧观察回取不能作为新回读；独立 MCP 全文 read 后，创建证据才为 `verified`。既有 NUL 字符往返覆盖保留。

另运行 `workspace-create-target-successor.test.ts`：固定双目标不能仅凭同内容合并；显式改名恢复须关联真实零写、创建和独立新读；允许修订草稿时不要求失败尝试与新文件草稿相同。三项均通过。

源码责任：`agent/tools/invocations/invocations.ts` 直接将 `args.content` 编成 UTF-8/base64 并冻结；`features/workspaces/write/create.ts` 按冻结字节写入、独占 link 不覆盖、实际回读核验。二者本轮均未修改。

## 执行记录与可复现命令

环境：Docker Linux x64、Bun 1.4.2、任务自有 PostgreSQL 16（`postgres:16-alpine`）、全新隔离 schema，原迁移逐项应用；未启动已有产品安装或读取其凭据。模型配置为受控 fixture，调用方直接提交合成工具参数；文件读取实际启动 MCP 子进程，不是文件/PG mock。

准备执行 `bun install --frozen-lockfile`、`bun run build:api`。测试容器设置任务自有的 `DATABASE_URL`、`TZDB_VERSION=fixture-v1` 和合成 `BETTER_AUTH_SECRET`，不读取或写入 `.env`。在已配置这些变量的 Linux 环境中：

```sh
bun test --timeout 30000 \
  apps/api/test/integration/direct-reminder.test.ts \
  apps/api/test/integration/target-continuation.test.ts \
  apps/api/test/integration/delegated-workspace-gateway.test.ts \
  apps/api/test/integration/workspace-create-target-successor.test.ts
```

本轮实际分两次取得有效证据，不把失败整轮写成通过：

1. 首次四文件：71 pass、13 fail。`target-continuation` 的 23 项及其他既有提醒覆盖通过；8 个文件场景因缺少测试认证 secret 在 fixture 创建时失败，5 个新增取消场景因测试误用返回字段 `taskId` 而非 `task_id` 失败。它们不是产品 Red，也不是 TDD。
2. 补入合成测试 secret、修正测试字段后，重跑受影响三文件：**61 pass、0 fail、325 assertions**，无 skip。此前已通过且未修改的 `target-continuation` 23 项不重复跑。合计 84 个不同场景有本轮通过证据，不能称为同一次全绿运行。
3. 生产代码始终为基线；新增测试首次遇到的是准备/夹具错误，修正后通过。策略是现行行为探索与补强覆盖，不声称先观察到生产缺陷再修复。

本机完整日志：`D:/Temp/along-169-baseline.log`（含失败）、`D:/Temp/along-169-gateway.log`（三文件通过）、`D:/Temp/along-169-static.log`（静态检查）。日志只作本机定位，不提交私有运行产物。

静态检查：`bun run typecheck` 全部 workspace 通过；`bun run lint` 为 0 warnings、0 errors。首次 `bun run format:check` 仅两份文档不符合格式，已修正；测试文件格式通过。格式修正没有改变已验证的业务或测试行为。

## 未覆盖与后续定位

- 历史误取消的完整原话与工具参数未恢复；只能按公开证据核对故障形态，不能声称逐字重放事故。
- 历史换行在 provider 原始参数还是之前的其他参数处理环节产生，仍无直接原始证据。现行受控链路不增删字节，不能扩大为模型必然遵守精确自然语言内容。
- 本轮未新跑真实 provider、正式 native/Web 消费者、原安装升级、全量 integration 或 `test:contracts`；没有生产协议或行为变更，不用这些历史结果冒充本轮验收。
- 原安装、既有提醒、pending、资料、模型路由和全局审批策略均未改动。不合并、不关闭 #169。
