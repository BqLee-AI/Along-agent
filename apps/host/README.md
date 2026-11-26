# 仓颉宿主运行验证

`host-runtime` 由仓颉直接监听 HTTP，提供 `/healthz`、`/readyz` 和用于观测就绪结果的 `/readyz/events`。仓颉通过私有 Unix socket 调用常驻 Bun 进程。Bun 复用现有 TS 就绪用例核对 PostgreSQL 与时间规则包。仓颉将结果写入 HTTP 或 SSE，并传递请求 ID。SIGTERM 和 SIGINT 触发 HTTP 服务和能力进程退出。

`ROLE=api` 提供聊天消息、提醒审批确认和任务取消入口。仓颉推进提醒快捷路径的业务步骤，并启动委托聊天的原生 Harness。TS 能力进程负责请求身份、模型调用和 PostgreSQL 事务。委托聊天的订阅可以断开，Run 通过数据库中的事件继续重放。

`ROLE=worker` 按顺序推进撤销、排程、认领、投递、回执和超时处理。`ROLE=all` 同时运行 HTTP 服务与 Worker。重启后按 PostgreSQL 中的任务和回执继续推进。

需要直接监听 TLS 时，设置 `ALONG_HOST_TLS_CERT` 和 `ALONG_HOST_TLS_KEY`，分别指向 PEM 证书链与 RSA 私钥。

```bash
docker build --target release -f infra/docker/Dockerfile -t along-host-baseline .
docker build --target host-runtime -f infra/docker/Dockerfile -t along-host-test .
bash scripts/ci/host-smoke.sh along-host-test along-host-baseline
```

验证脚本为两个镜像提供同一个独立 PostgreSQL，比较 HTTP 探针和四路并发就绪结果，使用临时证书验证 TLS，并观察 SSE、请求关联和断开连接后的可用性。脚本分别停止 PostgreSQL 和暂停能力进程，核对 503，再观察仓颉进程收到 SIGTERM 后的退出状态。

聊天验收使用真实会话、公开 HTTP/SSE、原生 Harness、模型流式接口和 PostgreSQL。它覆盖审批重放、重复确认、投递前取消、委托执行断线和重放，以及在排程后重启 Worker。
