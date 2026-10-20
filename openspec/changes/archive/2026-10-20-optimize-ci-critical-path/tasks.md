# CI 关键路径优化 tasks（Issue #21）

## 1. 契约

- [x] 独立 OpenSpec-only PR #22 经 ReviewCi21Spec approve、严格校验及五 checks 全绿后合并（952b397）。

## 2. 实现

- [x] 同次 verify 复用成功构建的 packages，单元测试命令单一定义；独立及 skip-typecheck 入口保留前置，失败不继续。
- [x] Compose 仅依赖 static，四条下游独立运行；五检查名称、真实 SQL/并发/故障/契约/格式门不变。
- [x] 删除 Compose 无消费者的宿主 setup，保留实际镜像冻结安装、构建、两轮新卷 D7。
- [x] 同步 design/PRD/索引、贡献说明与受影响的治理引用，不改历史归档事实；ADR 0007 局部修订 0006 的 CI 编排。

## 3. 验收

- [x] 8 项隔离行为回归以真实 Bun 构建、TypeScript 检查及三个发现根的消费者验收同次复用、独立/skip-typecheck、旧 dist 不可信和准备/类型失败阻断。
- [x] 完整 verify、本地实际 CLI 冒烟，以及实现提交 a831572 的 CI 契约、全部 9 文件真实 PG、SQL/并发/故障检查通过。
- [x] 实现提交 a831572 的五 checks 全绿；Compose 与三条中间链同时启动，首次镜像冻结安装/构建和两轮新卷 D7 均有实际日志。
- [x] 对照 run39366377536 的 206 秒，run39371573382 首 job 至末 job 148 秒，缩短 28.2%；版本与各 job 时间戳见下。

## 4. 收口

- [x] 独立 review approve、archive 与全量 strict 通过；收口 PR #23 写 Closes #21，合并入口要求最新五检查成功、CLEAN 和精确 head squash。

## 5. 验证记录（2026-10-20）

- 契约 PR #22：ReviewCi21Spec approve；run39370391718 五 checks 全绿，CLEAN 后按精确 head 合并。
- Windows/Bun 1.4.2 完整 `bun run verify` 10 步成功；21 个非 DB 文件 140 pass / 0 fail、623 expects，其中新增行为回归 8 项。OpenSpec 3 passed，格式门阻塞不变。
- 初次定向回归 4 pass / 4 fail 揭示 cmd 将单引号留在 glob 中；执行器采用 cmd/POSIX 兼容的固定双引号命令，完整门禁已覆盖修正。不是忽略失败或放宽 integration 排除。
- Node 24.21.0 实际调用 verify 的定向 unit 路径（显式跳过其他 9 步）成功：先准备 packages，再运行相同 140 项/21 文件单元；不冒充 Node 完整门禁运行。
- ReviewCi21Impl 对完整实现 approve、无 findings；归档实际应用 3 个修改与 1 个重命名，随后全量严格校验 2 passed。归档后 verify 按原逻辑跳过无 active change 的 OpenSpec 步，CI 实际运行其余 9 步。
- 实现提交 `a831572` 的 [run39371573382](https://github.com/BqLee-AI/Along-agent/actions/runs/39371573382)：首 job `04:49:05Z` 至末 job `04:51:33Z` 为 148 秒；对照 [run39366377536](https://github.com/BqLee-AI/Along-agent/actions/runs/39366377536) 的 206 秒，减少 58 秒（28.2%），达到 180 秒目标。static 73 秒、migration 58 秒、scheduler 45 秒、contracts 26 秒、Compose 73 秒。
- 四条下游均在 `04:50:20Z` 启动；migration 至 `04:51:18Z`、Compose 至 `04:51:33Z`，证明实际重叠而非仅改配置。static 日志只有一次 packages 构建，unit 140 pass/21 文件；PG integration 62 pass/9 文件、scheduler 12 pass/3 文件、contracts 14 pass/4 文件，各集合存在重复执行，不累加为独立覆盖。
- Compose 无宿主 Bun 安装，首次镜像 `RUN bun install --frozen-lockfile` 和 `RUN bun run build:api` 实际执行；缺 TZDB 的 health/me/brief/ready 探测及第二轮新卷 ready 200 后 smoke PASS。原 SQL/并发断言与完整 API/Next 生产构建仍通过。
- 本轮 static 73 秒并未快于基线 69 秒；新增 8 项真实回归和 runner 差异使单步收益不能从两次总耗时单独归因。墙钟主要收益是 Compose 与中间链重叠，不宣称 runner 分钟同比下降。
