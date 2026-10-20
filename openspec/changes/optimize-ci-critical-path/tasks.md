# CI 关键路径优化 tasks（Issue #21）

## 1. 契约

- [ ] 独立 OpenSpec-only PR 经 review、严格校验及 CI 后合并。

## 2. 实现

- [ ] 同次 verify 复用成功构建的 packages，单元测试命令单一定义；独立及 skip-typecheck 入口保留前置，失败不继续。
- [ ] Compose 仅依赖 static，四条下游独立运行；五检查名称、真实 SQL/并发/故障/契约/格式门不变。
- [ ] 删除 Compose 无消费者的宿主 setup，保留实际镜像冻结安装、构建、两轮新卷 D7。
- [ ] 同步 design/PRD/索引、贡献说明与受影响的治理引用，不改历史归档事实。

## 3. 验收

- [ ] 行为回归保护：完整 verify 的同次复用、无 dist 的独立 unit、skip-typecheck 的构建与准备失败，均以真实构建/消费者结果验收。
- [ ] 完整 verify、契约与相关真实数据库检查通过，实际本地 CLI 路径冒烟。
- [ ] 最新 CI 五 checks 全绿；job 时间戳证明 Compose 与中间链重叠，首次镜像安装/构建及两轮新卷 D7 真实执行。
- [ ] 与 run39366377536 的 206 秒对比，记录版本、各 job/关键步骤及首 job 至末 job 墙钟，区分模型和实测。

## 4. 收口

- [ ] 独立 review approve，archive 与全量 strict 校验；收口 PR Closes #21，最新提交全 checks 绿且 CLEAN 后精确 head squash。
