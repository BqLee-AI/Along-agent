# 仓颉宿主运行验证

`host-runtime` 是用于验证仓颉服务宿主的镜像目标。它由仓颉直接监听 HTTP，提供 `/healthz`、`/readyz` 和用于观测就绪结果的 `/readyz/events`。仓颉启动 Bun 调用现有 TS 就绪用例，从标准输出读取结果。该用例核对 PostgreSQL 与时间规则包，仓颉根据结果返回 HTTP 状态或 SSE 数据。SIGTERM 和 SIGINT 触发 HTTP 服务退出。

```bash
docker build --target release -f infra/docker/Dockerfile -t along-host-baseline .
docker build --target host-runtime -f infra/docker/Dockerfile -t along-host-test .
bash scripts/ci/host-smoke.sh along-host-test along-host-baseline
```

验证脚本为两个镜像提供同一个独立 PostgreSQL，比较 HTTP 探针和四路并发就绪结果，读取 SSE 后断开并检查宿主继续服务。停止 PostgreSQL 后核对 503，再观察仓颉进程收到 SIGTERM 后的退出状态。业务 HTTPS/SSE 的长流、逐条取消和多操作能力进程由后续迁移切片验证。
