# 仓颉聊天提醒验收

## 生产镜像与数据

同源 Linux `host-runtime` 镜像 `sha256:7af17a5353627cf79fc6bdb4c4cfc3d3457201ed35697a3b8e9fcc41a6a45cb5`，`release` 对照镜像 `sha256:3a3cabca585d9401c694cc05510d12cef0c91b86978a0ee1194adc5786a5f55d`。`scripts/ci/host-smoke.sh` 验证 HTTP、TLS、SSE、依赖异常、超时和 SIGTERM。`scripts/ci/host-chat-smoke.ts` 启动真实 `ROLE=all`，使用独立 PostgreSQL 16、真实会话、生产模型适配器和确定性的本地 SSE 模型服务。

- 提醒快捷路径返回完整审批事件流。幂等重放逐字节一致，重复确认返回同一个任务 ID，投递前取消的任务进入 `cancelled`，通知和 `fired` 事件均为零。
- 委托路径在模型应答前断开 SSE，Run 随后进入 `done`。用原幂等键重放得到原 Run 和 `thread.completed`，模型仅请求两次，创建回执对应唯一已完成的工具调用。
- 仓颉 Worker 排程后收到 SIGTERM 并退出。重启后同一提醒进入 `fired`，保留排程回执，只有一条通知和一条 `fired` 事件。

## 覆盖边界

此记录覆盖两条聊天提醒生产 HTTP 路径及 Worker 恢复。浏览器验收、续传游标、撤权与慢读竞争、历史暂停和审批恢复仍需独立证据。
