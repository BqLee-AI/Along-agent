## RENAMED Requirements

- FROM: `### Requirement: CI 沿用既有门禁 DAG`
- TO: `### Requirement: CI 静态门后独立验证`

## MODIFIED Requirements

### Requirement: verify 主链覆盖

一键 verify SHALL 以 `bun run verify` 为本地与 CI 的共同入口，按既有顺序执行 lint、typecheck、depcruise、gate-manifest、gates-executable、frozen-names、copy-claims、unit、OpenSpec 严格校验与阻塞式 format:check；构建前置不得省略门，任一步失败即停并报告步名及非零退出码。同次执行中成功 typecheck 准备的 packages SHALL 被 unit 复用；独立入口及未执行 typecheck 的路径仍自行完成真实构建，不依据旧 dist、跨 job 产物或持久完成标记判定已准备。

#### Scenario: 本地与 CI 同一阻塞主链

- WHEN 在干净安装后运行 `bun run verify`，或 static job 调用该入口
- THEN 相同门以相同顺序执行，gates-executable 位于 gate-manifest 之后；成功 typecheck 完成的 packages 前置不在 unit 重复执行，全部门成功才返回 0（映射 D1/D2/D10）

#### Scenario: 格式错误不是非阻塞警告

- WHEN 被检查文件存在 oxfmt 格式错误
- THEN format:check、verify 与 static 返回失败，不使用 continue-on-error 或退出码吞并放行

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

### Requirement: CI 静态门后独立验证

CI SHALL 保留 static、migration-scan、scheduler-fault、contracts-dual、compose-smoke 五个 required checks。static 运行统一 verify；其余四 job 只依赖 static 并各自独立运行，使用独立数据库/镜像与所需构建前置。合并 SHALL 要求五项全部成功；任一失败、取消、跳过或仅 Compose 成功都不能视为合并门通过。

#### Scenario: static 失败阻止下游

- WHEN lint、typecheck、依赖边界、治理、单元、OpenSpec 或格式检查令 static 失败
- THEN 四条下游不能作为成功验证放行，合并条件不满足

#### Scenario: 四条验证链独立执行

- WHEN static 成功且有可用 runner
- THEN migration-scan、scheduler-fault、contracts-dual、compose-smoke 可独立启动；Compose 不等待前三者完成，也不消费其产物；不共享可变数据库状态

#### Scenario: 独立完成不替代其他必过检查

- WHEN 四条下游中任一失败、取消或跳过，即使 Compose 成功
- THEN 五检查成功的合并条件仍不满足，不使用 always、continue-on-error 或退出码吞并把未通过验证包装为成功

### Requirement: Docker 实际使用 Bun 工具链

Docker/Compose SHALL 使用固定 Bun 的冻结安装、工作区构建与服务运行路径，保持角色和 D7 健康/就绪行为。Compose 宿主只准备 shell/Docker/HTTP 探测所需环境，不安装无消费者的 Bun 依赖；实际镜像内冻结安装和依赖优先构建不可因此省略。

#### Scenario: 从无旧产物的上下文构建服务镜像

- WHEN Compose 从干净源码、package manifests 与 bun.lock 构建实际 Dockerfile
- THEN 镜像完成 Bun 冻结安装和依赖优先构建，以 Bun 启动服务，不依赖宿主 node_modules/dist 或其他 job 产物

#### Scenario: Bun 镜像保持空环境冒烟语义

- WHEN 对新卷服务分别不给和显式给 TZDB_VERSION 执行 compose-smoke
- THEN /healthz 为 200，未登录 /api/v1/me 与 /api/v1/brief 为 401；缺 TZDB 的 /readyz 为 503 且带 TZDB_UNAVAILABLE，有 TZDB 时为 200，不通过部署或修改业务绕过
