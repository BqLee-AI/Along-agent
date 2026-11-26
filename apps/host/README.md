# 仓颉宿主运行验证

`host-runtime` 由仓颉直接监听 HTTP，提供 `/healthz`、`/readyz` 和用于观测就绪结果的 `/readyz/events`。仓颉通过私有 Unix socket 调用常驻 Bun 进程。Bun 复用现有 TS 就绪用例核对 PostgreSQL 与时间规则包。仓颉将结果写入 HTTP 或 SSE，并传递请求 ID。SIGTERM 和 SIGINT 触发 HTTP 服务和能力进程退出。

`ROLE=api` 提供会话与 Run 的 HTTP/SSE 入口，以及提醒审批确认和任务取消。仓颉启动请求绑定和服务端持有的原生 Harness，管理事件订阅游标、断开连接与终态补读，并启动 compact 的原生处理。TS 能力进程核验请求身份、执行权、模型调用和 PostgreSQL 事务。请求绑定 Run 的连接中断触发取消，服务端持有的 Run 可在订阅断开后继续执行。

`ROLE=worker` 按顺序推进撤销、排程、认领、投递、回执和过窗处理，并在独立循环推进身份邮件。两个循环分别等待正在处理的阶段结束。`ROLE=all` 同时运行 HTTP 服务与 Worker。重启后按 PostgreSQL 中的任务、投递回执和邮件状态继续推进。

需要直接监听 TLS 时，设置 `ALONG_HOST_TLS_CERT` 和 `ALONG_HOST_TLS_KEY`，分别指向 PEM 证书链与 RSA 私钥。

```bash
docker build --target release -f infra/docker/Dockerfile -t along-host-baseline .
docker build --target host-runtime -f infra/docker/Dockerfile -t along-host-test .
bash scripts/ci/host-smoke.sh along-host-test along-host-baseline
```

验证脚本为两个镜像提供同一个独立 PostgreSQL，比较 HTTP 探针和四路并发就绪结果，使用临时证书验证 TLS，并观察 SSE、请求关联和断开连接后的可用性。脚本分别停止 PostgreSQL 和暂停能力进程，核对 503，再观察仓颉进程收到 SIGTERM 后的退出状态。

聊天验收使用真实会话、公开 HTTP/SSE、原生 Harness、模型流式接口和 PostgreSQL。它覆盖审批重放、重复确认、投递前取消、委托执行断线和重放，以及在排程后重启 Worker。Run 验收还覆盖按游标补读、请求绑定断线后的取消、取消后拒绝迟到的模型结果、批准恢复、暂停继续，以及活动和空闲 Run 的手动压缩。

Worker 冒烟在同一个独立 PostgreSQL 数据库中运行两个仓颉进程，验证正常提醒只投递一次，过窗和已取消的提醒不投递。遗留的 `submitting` 邮件归档为 `unknown`，清除载荷且保留原尝试次数。邮件提交及异常响应由 `identity-mail.test.ts` 使用独立数据库和本地 HTTP 邮件服务验证。
