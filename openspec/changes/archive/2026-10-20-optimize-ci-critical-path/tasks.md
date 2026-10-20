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
- [ ] 完整 verify、契约与相关真实数据库检查通过，实际本地 CLI 路径冒烟。
- [ ] 最新 CI 五 checks 全绿；job 时间戳证明 Compose 与中间链重叠，首次镜像安装/构建及两轮新卷 D7 真实执行。
- [ ] 与 run39366377536 的 206 秒对比，记录版本、各 job/关键步骤及首 job 至末 job 墙钟，区分模型和实测。

## 4. 收口

- [ ] 独立 review approve，archive 与全量 strict 校验；收口 PR Closes #21，最新提交全 checks 绿且 CLEAN 后精确 head squash。

## 5. 验证记录（2026-10-20）

- 契约 PR #22：ReviewCi21Spec approve；run39370391718 五 checks 全绿，CLEAN 后按精确 head 合并。
- Windows/Bun 1.4.2 完整 `bun run verify` 10 步成功；21 个非 DB 文件 140 pass / 0 fail、623 expects，其中新增行为回归 8 项。OpenSpec 3 passed，格式门阻塞不变。
- 初次定向回归 4 pass / 4 fail 揭示 cmd 将单引号留在 glob 中；执行器采用 cmd/POSIX 兼容的固定双引号命令，完整门禁已覆盖修正。不是忽略失败或放宽 integration 排除。
- Node 24.21.0 实际调用 verify 的定向 unit 路径（显式跳过其他 9 步）成功：先准备 packages，再运行相同 140 项/21 文件单元；不冒充 Node 完整门禁运行。
- ReviewCi21Impl 对完整实现 approve、无 findings；归档实际应用 3 个修改与 1 个重命名，随后全量严格校验 2 passed。CI、重叠时间戳与最终合并条件仍按后续实测记录。
- 性能对照使用 run39366377536 的 206 秒；新 CI 的墙钟和重叠证据在取得后补录，不把模型值记为实测。
