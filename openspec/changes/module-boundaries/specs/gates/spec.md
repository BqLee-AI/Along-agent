## ADDED Requirements

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
