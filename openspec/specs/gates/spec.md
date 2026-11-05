# gates Specification

## Purpose

定义 D1–D10 的机读声明、执行证据、统一验证入口及按变更范围选择的 CI 检查，使绿色结果对应实际执行的消费者和已限定的行为保证。

## Requirements

### Requirement: gate 清单机读可执行

清单 SHALL 让每条 enforced gate 可机读定位其 CI 执行位置，不靠人工对照。

#### Scenario: enforced gate 有执行指向

- WHEN 读取 `ci/gates.json` 任一 status 为 enforced 的 gate
- THEN 其 `enforced_by.job` 非空且等于 `.github/workflows/ci.yml` 中的 job 名，其 `evidence[]` 非空且每项为仓库内存在路径

#### Scenario: D8 的有限执行声明

- WHEN D8 声明有限范围 enforced
- THEN 清单包含 integration 执行指向、真实证据文件和唯一必需消费者 ID；未覆盖范围明确保留 partial，不以非空 scope 或旧 healthz 通过扩大保证（映射 D8；design/13 §4.2）

### Requirement: 缺执行即红

可执行检查 SHALL 在 gate 执行链缺失时失败，不静默放行。

#### Scenario: 删 job 必红

- WHEN 从 ci.yml 删除某 enforced gate 对应 job 名
- THEN `node scripts/check-gates-executable.mjs` exit 1 且输出含该 gate 名与缺失 job 名

#### Scenario: 删证据必红

- WHEN 删除某 enforced gate 任一 evidence 文件
- THEN `node scripts/check-gates-executable.mjs` exit 1 且输出含该 gate 名与缺失路径

### Requirement: 字样门同步验指向

清单字样检查 SHALL 与执行指向检查同进退，不出现字样绿但无执行。

#### Scenario: 缺 enforced_by 即红

- WHEN 某 enforced gate 缺 `enforced_by.job` 或空 `evidence[]`
- THEN `node scripts/check-gate-manifest.mjs` exit 1 且输出含该 gate 名

#### Scenario: 字样与执行一致

- WHEN 两脚本都通过
- THEN gates.json 中 enforced 条数等于 check-gates-executable 实际校验条数

### Requirement: D8 正式跨语言消费者与本次执行证据

完整范围的 CI 与根 `test:contracts` SHALL 运行同一正式合同入口，从当前树构建并启动锁定 native，在同一生产 runtime、真实隔离 PG16 与签名身份上验证生产者和消费者；保留既有 healthz 双跑与契约包。声明范围和执行证据 SHALL 一致，不以跳过、旧产物或旧报告替代。

#### Scenario: 同一业务在两入口消费真实结果

- WHEN 分别通过本地公共用例和真实签名 HTTP 执行相同的正式 native 场景
- THEN 原批准真实挂起、确认后同 Run 唯一后继 attempt 消费原批准与实际 task ID；拒绝、错误参数/状态、取消和重放遵守原合同，读取不执行，取消后无新效果（映射 D8；design/13 §4.2）

#### Scenario: 严格边界与 unknown 子合同不冒充完整产品恢复

- WHEN 公共 DTO 或真实 native wire 收到伪造/不兼容输入，或真实非事务调用核心在实际效果后丢失执行进程并返回 unknown
- THEN 对应真实消费者拒绝非法输入；native 消费真实 unknown 后停止且不重发，原结果不被伪造成 accepted；该子合同不作为生产 unknown 快照或跨请求恢复证据（映射 D8；design/04 §3、design/13 §4.2）

#### Scenario: 省略消费者不能借旧集合变绿

- WHEN 本次构建/启动、消费者执行或必需 case 被省略，报告缺失、损坏、包含重复/跳过/失败的必需 case，或消费者进程失败
- THEN 根入口和完整范围的 integration 非零失败；只有本次实际报告中每个必需 ID 唯一通过且消费者成功才可通过，既有 healthz/契约包通过不能补足（映射 D8）

#### Scenario: 必要业务步骤缺失导致行为变红

- WHEN 在独立临时上下文省略真实结果纳入或执行资格裁决，重跑同一消费者
- THEN 对应具体错误结果或越权效果使行为断言失败，恢复后通过；缺依赖、协议损坏或超时不计为该业务 Red，不添加生产绕过开关（映射 D8）

### Requirement: verify 主链覆盖

一键 verify SHALL 以 `bun run verify` 为本地与代码变更 CI 的共同入口，按既有顺序执行 lint、typecheck、depcruise、gate-manifest、gates-executable、frozen-names、copy-claims、unit、OpenSpec 严格校验与阻塞式 format:check；构建前置不得省略门，任一步失败即停并报告步名及非零退出码。同次执行中成功 typecheck 准备的 packages SHALL 被 unit 复用；独立入口及未执行 typecheck 的路径仍自行完成真实构建，不依据旧 dist、跨 job 产物或持久完成标记判定已准备。

#### Scenario: 本地与 CI 同一阻塞主链

- WHEN 在干净安装后运行 `bun run verify`，或代码变更的 checks job 调用该入口
- THEN 相同门以相同顺序执行，gates-executable 位于 gate-manifest 之后；成功 typecheck 完成的 packages 前置不在 unit 重复执行，全部门成功才返回 0（映射 D1/D2/D10）

#### Scenario: 格式错误不是非阻塞警告

- WHEN 被检查文件存在 oxfmt 格式错误
- THEN format:check、verify 与 checks 返回失败，不使用 continue-on-error 或退出码吞并放行

#### Scenario: 治理脚本失败阻止后续步骤

- WHEN gate-manifest、gates-executable、frozen-names 或 copy-claims 任一步失败
- THEN verify 报告失败步名并中止后续步骤，原禁词/口径与缺执行检查不因优化跳过

#### Scenario: 干净 checkout 恢复构建依赖

- WHEN 干净 checkout 尚无 workspace dist，独立执行需要依赖产物的 build、typecheck 或测试入口
- THEN 被依赖 packages 先成功构建，消费者随后执行，不以旧 dist 或跨 CI job 文件共享充当构建前置

#### Scenario: 跳过 typecheck 不等于完成构建

- WHEN verify 显式跳过 typecheck 而执行 unit
- THEN unit 自行完成 packages 构建后执行原测试集合；不因运行于 verify 就假定准备成功

#### Scenario: 准备失败不运行消费者

- WHEN 依赖包构建或 typecheck 返回非零退出码
- THEN 调用入口失败，后续 unit 不运行，不把准备失败状态复用为成功

### Requirement: D 项变红映射

每条死规矩 SHALL 有删执行链即红的演练记录。

#### Scenario: D1/D2/D10 映射

- WHEN 删除 checks job，或分别删除 D1 的 .dependency-cruiser.cjs / D2 的 presentation.test.ts / D10 的 scan-copy-claims.mjs evidence（演练后恢复）
- THEN 脚本对受影响的 D1/D2/D10 报红；checks job 缺失时三项均红

#### Scenario: D3–D6 映射

- WHEN 删 integration job 或任一 scripts/db evidence（演练后恢复）
- THEN 新脚本对 D3/D4/D5/D6 报红（对应 D3 唯一约束、D4 后继唯一、D5 只追加、D6 不可变）

#### Scenario: D7/D9 映射

- WHEN 删除 integration job 或分别删除 compose-smoke.sh / scheduler-fault.test.ts（演练后恢复）
- THEN 新脚本对 D7/D9 报红（对应 D7 空环境冒烟、D9 取消后触发数=0）

### Requirement: API 模块存储实现隔离

依赖门禁 SHALL 拒绝 `apps/api/src/modules/<name>/` 对其他模块 repository、schema、schemas 实现的直接引用，包括同名文件、目录和以 `-repository`、`-schema`、`-schemas` 命名的实现；模块内引用与公共服务调用 SHALL 保持合法。此规则落实 design/02 §1–§2，映射 D1。

#### Scenario: 跨模块存储引用被拒绝

- WHEN 任一模块引用另一模块的 repository 或 schema 实现，包括嵌套路径与类型引用
- THEN depcruise 非零退出并指出违规边与规则名

#### Scenario: 合法公共调用与自身存储访问

- WHEN 扫描现有 conversations→tools/gateway、tasks→notifications/service、tools→approvals/create 或 presentation，以及模块内 repository/schema 引用
- THEN 依赖门禁通过

#### Scenario: confirm 事务保持合法但不扩大豁免

- WHEN approvals/confirm.ts 引用 tasks/cancel.ts，或尝试改为引用 tasks/cancel-repository.ts
- THEN 前者通过，后者仍作为跨模块存储引用被拒绝；不增加整个 approvals 模块的存储层豁免

### Requirement: Web 与 API 源码隔离

依赖门禁 SHALL 拒绝 `apps/web/**` 引用 `apps/api/**`，包括类型引用；Web 通过 HTTP 访问服务端的现有路径 SHALL 保持合法。映射 D1。

#### Scenario: Web 直接引用 API 被拒绝

- WHEN Web 源码引用 API 源码
- THEN depcruise 非零退出并报告跨应用违规边

#### Scenario: HTTP 访问保持合法

- WHEN Web 通过现有代理或 API 客户端发送 HTTP 请求而不引用 API 源码
- THEN 依赖门禁通过

### Requirement: 共享包依赖逐包声明

依赖门禁 SHALL 限制 time-core 的 src 仅引用自身；contracts、stream-protocol 的 src 仅引用自身与 zod；scheduler-core 的 src 仅引用自身、contracts、time-core；notifier-core 的 src 仅引用自身与 contracts。依赖门禁 SHALL 拒绝这些声明范围外的 workspace、应用或外部依赖，保留 design/01 §3 允许方向。映射 D1。

#### Scenario: 合法依赖通过

- WHEN 扫描包内引用、contracts/stream-protocol→zod、scheduler-core→contracts/time-core、notifier-core→contracts
- THEN depcruise 通过

#### Scenario: 越界依赖被拒绝

- WHEN 任一共享包引用其声明范围外的包、应用源码或内置模块
- THEN depcruise 非零退出并报告对应包的边界规则

### Requirement: 边界规则的可执行证据

每条新增边界规则 SHALL 有运行真实 depcruise 的越界 fixture，断言非零退出与对应规则名，并有合法 fixture 防止误伤；这些测试 SHALL 纳入单元测试与 D1 evidence。映射 D1，不新增死规矩编号。

#### Scenario: 越界 fixture 变红

- WHEN 单元测试逐条执行新增规则对应的越界 fixture
- THEN 每个越界运行均失败于预期边界规则，而不是缺文件或解析错误

#### Scenario: 合法 fixture 保持绿

- WHEN 运行合法服务调用、confirm 单事务调用和模块内存储访问 fixture
- THEN depcruise 零退出

#### Scenario: 一键校验执行边界验收

- WHEN 执行 verify
- THEN 真实 apps/packages 依赖扫描和边界 fixture 测试均被执行；任一失败阻断校验，D1 evidence 缺失也报错

### Requirement: Bun 单一工具链入口

仓库 SHALL 固定 Bun 1.4.2、workspaces 与单一 bun.lock；本地、CI、Docker 的有效安装、构建和测试命令 SHALL 完成干净切换，不保留 pnpm/Turbo/ESLint/Vitest 活动调用或直接依赖。

#### Scenario: 冻结安装可复现

- WHEN 新环境按声明的 Bun 1.4.2 执行 `bun install --frozen-lockfile`
- THEN 使用已提交 bun.lock 安装全部工作区依赖；manifest 与锁文件不一致时失败，而非改写锁文件继续（映射 D1/D2/D8 的可复现门执行）

#### Scenario: 任一活动入口均走新工具链

- WHEN 检查根与 workspace scripts、verify、CI setup/workflow 和实际 Docker 构建/运行路径
- THEN 不存在 pnpm/Turbo/ESLint/Vitest 活动调用或相应旧配置入口，包依赖及测试仍由实际命令执行，历史归档文字不被误认为当前操作说明（映射 D1/D2/D7/D8 的执行链保护）

### Requirement: D2 Oxlint 语法边界等价

D2 SHALL 在 Oxlint 1.89.0 的 JS 插件内直接使用原 selector `NewExpression[callee.name='Date']` 与 `CallExpression[callee.object.name='Date'][callee.property.name='now']`，限定 `apps/web/**/*.{ts,tsx,js,jsx}` 并保持原全局忽略路径；不得回退 ESLint 或用独立扫描脚本替代。

#### Scenario: 四种源扩展名中的直接取时必红

- WHEN apps/web 中的 JS、TS、JSX、TSX fixture 含 `new Date()` 或 `Date.now()`
- THEN Oxlint 输出对应 D2 原错误文案并返回非零，所有四种扩展名均被覆盖（映射 D2 展示层禁算时间）

#### Scenario: 相近表达式遵守原 AST selector

- WHEN fixture 含 `new Date`、`new (Date)()`、被局部变量遮蔽的 `Date`、`Date[now]()`、`Date?.now()` 或 `Date.now?.()`
- THEN 对应原 selector 的表达式仍被拒绝；`Date()`、仅引用 `Date.now`、`Date['now']()`、`globalThis.Date.now()`、别名取时和 TS 包装导致 callee 不匹配的表达式不因迁移扩大禁令（映射 D2 语法边界正反例）

#### Scenario: 原允许路径与忽略路径不误报

- WHEN 同样的禁用表达式位于 apps/api、其他 packages、apps/webish、apps/web 的 mjs/cjs 文件，或任意 dist/node_modules/coverage/.next 路径
- THEN D2 插件不报告该表达式，apps/web 原覆盖路径中的对应 fixture 仍报告（映射 D2 路径边界正反例）

### Requirement: 非 D2 lint 质量约束显式迁移

工具替换 SHALL 盘点原 typescript-eslint recommended 规则与作用域，显式记录 Oxlint 对应规则、级别和差异；不得以只迁 D2、整体关闭正确性规则、静默扩大 ignore 或无关业务改写替代已有 lint 质量门。

#### Scenario: 现有未使用符号检查仍实际执行

- WHEN 在原 lint 覆盖范围放入违反已采用未使用符号策略的代表性 TS fixture
- THEN Oxlint 的对应配置规则使 lint 与 verify 失败；类型位置引用、参数忽略等语义差异有逐项记录与正反证据，不用 spike 的全局规则关闭配置掩盖差异（映射 D2 lint 执行门完整性）

#### Scenario: 迁移不借机改变展示与治理业务

- WHEN Oxlint 原生规则与旧推荐规则的行为存在差异
- THEN 实现说明该差异及采用的规则映射，保留展示投影和治理断言，不通过宽泛 disable、删除测试或改写业务来制造全绿（映射 D2/D10 的既有回归保护）

### Requirement: bun:test 保留测试集合与隔离

全部现有 27 个测试文件 SHALL 迁移至 bun:test，保留断言、文件级状态隔离、时钟/spy 恢复、单元与真实数据库分组以及进程内/HTTP 契约双跑；并行优化不得改变用例间共享状态语义或静默漏测。

#### Scenario: 非数据库测试集合完整运行

- WHEN 运行新 test:unit 入口
- THEN 现有非数据库测试文件实际执行，integration 不因删除 Vitest include/exclude 配置而误入默认单元发现；空包许可不能令应存在的测试集合静默为空（映射 D1/D2/D10 的单元门）

#### Scenario: 反向时钟与文件级并行仍隔离

- WHEN 时间内核测试通过 Bun jest API 设置反向系统时间并 spy Date.now，同时启用文件级并行
- THEN 原时间归一化断言通过、Date.now 的禁调用断言保留，mock/clock 按原生命周期恢复，不用文件内 concurrent 取代文件隔离（映射 D1 时间唯一权威）

#### Scenario: 契约入口真实包含两种传输

- WHEN 执行根 `bun run test:contracts` 或完整范围的 integration job
- THEN API contracts.test.ts 中进程内与 HTTP 两组测试以及既有契约包测试均实际运行；任一组失败即该入口失败，不因 API 缺少旧 test:contracts 脚本而漏掉 HTTP（映射 D8 契约双跑）

#### Scenario: 数据库与故障测试仍使用真实约束

- WHEN 执行 integration 与 scheduler 故障集合
- THEN 数据库集成文件在真实 PostgreSQL 16、原迁移和明确测试环境下执行；唯一性/只追加/取消窗口断言不跳过，重复注册的 case 与独立声明数明确区分（映射 D3–D6/D9）

### Requirement: D1 出边断言保留 Bun 执行路径

dependency-cruiser SHALL 在 Bun 下继续执行现有出边配置，保留 time-core 外部出边禁止、契约依赖限制和环检测，而非仅检查命令存在。

#### Scenario: 外部与内置模块依赖必红

- WHEN packages/time-core/src 新增对 agent-runtime 或 node:fs 的依赖，包括配置已覆盖的类型依赖
- THEN Bun 执行的 dependency-cruiser 报 time-core-zero-egress 并返回非零，verify 不继续（映射 D1 依赖边界）

#### Scenario: 现有允许依赖不扩大限制

- WHEN time-core 仅含现有合法源码与配置允许的内部模块依赖
- THEN 同一配置通过，不将工具迁移变成新的依赖规则设计（映射 D1 正向边界）

### Requirement: Docker 实际使用 Bun 工具链

Docker/Compose SHALL 使用固定 Bun 的冻结安装、工作区构建与服务运行路径，保持角色和 D7 健康/就绪行为。实际镜像内冻结安装和依赖优先构建不可因宿主依赖而省略。

#### Scenario: 从无旧产物的上下文构建服务镜像

- WHEN Compose 从干净源码、package manifests 与 bun.lock 构建实际 Dockerfile
- THEN 镜像完成 Bun 冻结安装和依赖优先构建，以 Bun 启动服务，不依赖宿主 node_modules/dist 或其他 job 产物

#### Scenario: Bun 镜像保持空环境冒烟语义

- WHEN 对新卷服务分别不给和显式给 TZDB_VERSION 执行 compose-smoke
- THEN /healthz 为 200，未登录 /api/v1/me 与 /api/v1/brief 为 401；缺 TZDB 的 /readyz 为 503 且带 TZDB_UNAVAILABLE，有 TZDB 时为 200，不通过部署或修改业务绕过

### Requirement: 门清单随执行证据同步

工具链迁移 SHALL 同步 ci/gates.json 的实际配置/插件/测试证据及当前贡献说明，保持既有缺 job/缺证据即红的机读检查；不得让旧 ESLint 文件名成为已删除的假证据。

#### Scenario: D2 新证据真实存在

- WHEN 读取迁移后 D2 的 enforced_by
- THEN job 指向 checks，evidence 指向存在的 Oxlint 配置、D2 插件及展示测试；可执行检查通过且原 ESLint 配置不再作为活动证据（映射 D2 执行指向）

#### Scenario: 删迁移后的执行证据仍红

- WHEN 在演练中移除受影响 gate 的 job、Oxlint 配置/插件或其他任一必需 evidence
- THEN gates-executable 报对应门与缺项并非零退出，恢复后通过，当前文档/模板的 Bun 命令与该执行链一致（映射 D1–D10 的证据完整性）

### Requirement: CI 按变更范围验证

CI SHALL 保留 checks 和 integration 两个 required checks；两个 job 均须成功。PR 按 base 与 checkout 的实际 diff 决定检查范围，main push 和无法确定的变更执行完整集合。被跳过的测试不作为本次执行证据。

#### Scenario: 文档与 Web 变更

- WHEN PR 仅修改允许的文档路径
- THEN 运行文案、OpenSpec 和格式检查，不构建应用或启动数据库、native 与 Compose
- WHEN PR 仅修改 Web 源码或测试及允许的文档
- THEN 运行完整 verify 和 Web 构建，不运行无关的重集成

#### Scenario: 未知或完整范围

- WHEN PR 涉及其他路径、删除或重命名、无效或不可用 base、空 diff，或运行不是 PR
- THEN 运行完整 verify、构建、真实数据库与调度、正式 native 消费者及 Compose 全新卷检查

#### Scenario: 完整范围任一检查失败

- WHEN 完整范围的数据库、调度、契约、Compose 或静态检查中任一失败或取消
- THEN 对应 job 不成功，两个 required checks 的合并条件不满足；并行运行不共享可变数据库，不用退出码吞并放行
