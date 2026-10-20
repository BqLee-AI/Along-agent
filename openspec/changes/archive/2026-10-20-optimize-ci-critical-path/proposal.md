Issue: #21

# CI 关键路径优化

## Why

同工作量基线 [run 39366377536](https://github.com/BqLee-AI/Along-agent/actions/runs/39366377536) 首 job 至末 job 为 206 秒。typecheck 与 unit 在同次 verify 重复准备 packages；Compose 宿主 setup 无消费者，且独立镜像/数据库冒烟等待三条不提供输入的验证链。

## What Changes

- 保持 verify 门顺序，在同次执行中复用成功 typecheck 准备的 packages；独立 unit 和跳过 typecheck 的路径仍真实构建，构建失败不能继续测试。不持久化完成标记，不信任旧 dist。
- 保留 static、migration-scan、scheduler-fault、contracts-dual、compose-smoke 五个必过检查；static 成功后四条下游独立启动。任一失败/取消/跳过都不能代替五项成功的合并条件。接受中间门失败时 Compose 可能已消耗运行成本的权衡，不增加全投机并行。
- Compose 宿主不装无消费者的 Bun/依赖；镜像内仍真实冻结安装、依赖优先构建、Bun 启动，两轮新卷与健康/就绪/未登录断言不变。
- 更新治理引用和验收记录；同环境比较关键路径，不把理论模型作为实测，不以减少检查换时长。

## Spec

`docs/design/13-p0-bootstrap-and-ci-rules.md` §3–§4、`CONTRIBUTING.md` §1/§6/§8；行为增量归属 gates 的 verify、CI 编排及 Docker requirements。

## 验收

无 dist 的独立 unit、完整 verify、跳过 typecheck 后的 unit 都可运行；正常 verify 的 unit 不重复准备。构建失败阻止消费者。最新五 checks 全绿，时间戳证明 Compose 与中间验证重叠；首次镜像安装和构建、两轮新卷 D7 通过。对照 206 秒记录实际墙钟；180 秒为目标，不跳门达标。最终独立 approve、最新全绿、CLEAN 后合并。

## 非目标

不改业务、SQL迁移、缓存策略、typecheck/用例并发、格式阻塞、真实 PG/故障/契约覆盖。不部署，不读写 .env/真实凭据；LLM、市场、推送、计费不在范围。构建与类型依赖仍先准备，禁止跨 job 共享可变产物或数据库。
