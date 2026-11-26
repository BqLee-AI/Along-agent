# 仓颉宿主运行验证

`host-runtime` 由仓颉直接监听 HTTP，提供 `/healthz`、`/readyz` 和用于观测就绪结果的 `/readyz/events`。仓颉通过私有 Unix socket 调用常驻 Bun 进程。Bun 复用现有 TS 就绪用例核对 PostgreSQL 与时间规则包。仓颉将结果写入 HTTP 或 SSE，并传递请求 ID。SIGTERM 和 SIGINT 触发 HTTP 服务和能力进程退出。

需要直接监听 TLS 时，设置 `ALONG_HOST_TLS_CERT` 和 `ALONG_HOST_TLS_KEY`，分别指向 PEM 证书链与 RSA 私钥。

```bash
docker build --target release -f infra/docker/Dockerfile -t along-host-baseline .
docker build --target host-runtime -f infra/docker/Dockerfile -t along-host-test .
bash scripts/ci/host-smoke.sh along-host-test along-host-baseline
```

验证脚本为两个镜像提供同一个独立 PostgreSQL，比较 HTTP 探针和四路并发就绪结果，使用临时证书验证 TLS，并观察 SSE、请求关联和断开连接后的可用性。脚本分别停止 PostgreSQL 和暂停能力进程，核对 503，再观察仓颉进程收到 SIGTERM 后的退出状态。
