# 仓颉 Run 编排验收

## 对话入口与压缩

`host-runtime` 镜像 `sha256:822c38cf9b5dcaae9c4435560c050c97ae4c79cee87ce5b542f61b900f56d6ee` 使用独立 PostgreSQL 16、真实会话和生产模型适配器连接本地确定性 SSE 模型服务。镜像包含 `2cbd84d` 和 `89d0fbd` 的原生管道修复。运行时挂载 `89d0fbd` 的 `scripts/ci/host-run-smoke.ts`。

- 公共 HTTP 接纳普通对话。SSE 从指定游标补读，重复游标参数返回 `VALIDATION_ERROR`。请求绑定的 Run 随客户端断连进入 `cancelled`。取消后，晚到的模型结果不能改变已提交的终态。
- 提醒审批未确认时恢复返回 409。确认后恢复完成，同一请求重放原事件，原提醒工具只调用一次。用户暂停后可继续至完成。
- 空闲和活动 Run 的手动压缩都有 `continued` 回执，重复请求返回相同暂停 ID。长历史通过真实适配器的输入量估算触发自动压缩，一次用量记录和一次压缩发布后恢复执行，终态可经公开 SSE 补读。

同一 `822c38` 镜像在独立 PostgreSQL 16 运行 `pause-http`、`tool-invocations-nontransactional` 和 `tool-invocations-workspace`，共 27 项通过、207 个断言。覆盖历史暂停配置、暂停与取消的次序、外部效果变为 `unknown` 后拒绝确认暂停，以及工作区效果的查证。

较早的 #193 镜像 `sha256:d1985499b619186879cd5673c95ab451a0d80f160b484adcae14acbb696e4bde` 通过 `host-chat-smoke.ts`，覆盖服务端持有的 Run 在客户端断开后完成、以及会话撤销后停止向原订阅披露事件。压缩恢复测试两项通过。该候选与旧 TS `along-192-release` 的 `run-ownership` 各有八项通过和三项连接中断注入失败，失败分别为连接提前断开、未拦截到扫描查询和 `scan not dispatched`。

## 文档审批恢复

组合镜像 `sha256:70952bc833b2c618317935a3e162f72d55c712b528516c5a3dd57f63a5c832cc` 包含 `2cbd84d` 与 #195 产品入口候选。`host-product-smoke.ts` 经公开 HTTP 读取冻结预览，验证改动预览被拒绝、重复确认返回原决定、确认后文件仍是原文。恢复后，真实工作区只执行一次写入，持久工具结果记录独立读取的新内容，原预览保持原样。
