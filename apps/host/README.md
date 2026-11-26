# 仓颉宿主

生产 `release` 镜像由仓颉监听公开 HTTP 和 SSE，管理 Run 执行与 Worker 阶段。TS 能力进程通过私有 Unix socket 提供 PostgreSQL 就绪检查、身份与授权、领域事务、模型和外部服务调用。

`ROLE=api` 提供会话、Run、账户与模型设置、审批、提醒、简报、工作区、记忆及办公入口。仓颉启动原生 Harness，维护事件订阅游标，处理断连、终态补读和原生压缩。请求绑定 Run 的连接中断触发取消，服务端持有的 Run 可在订阅断开后继续执行。SIGTERM 和 SIGINT 触发 HTTP 服务和能力进程退出。

`ROLE=worker` 按顺序推进撤销、排程、认领、投递、回执和过窗处理，并在独立循环推进身份邮件。两个循环分别等待正在处理的阶段结束。`ROLE=all` 同时运行 HTTP 服务与 Worker。重启后按 PostgreSQL 中的任务、投递回执和邮件状态继续推进。

需要直接监听 TLS 时，设置 `ALONG_HOST_TLS_CERT` 和 `ALONG_HOST_TLS_KEY`，分别指向 PEM 证书链与 RSA 私钥。

```bash
docker build --target api-runtime -f infra/docker/Dockerfile -t along-host-baseline .
docker build --target release -f infra/docker/Dockerfile -t along-host-test .
bash scripts/ci/host-smoke.sh along-host-test along-host-baseline
```

验证脚本为两个镜像提供同一个独立 PostgreSQL，比较 HTTP 探针和四路并发就绪结果，使用临时证书验证 TLS，并观察 SSE、请求关联和断开连接后的可用性。脚本分别停止 PostgreSQL 和暂停能力进程，核对 503，再观察仓颉进程收到 SIGTERM 后的退出状态。

聊天验收使用真实会话、公开 HTTP/SSE、原生 Harness、模型流式接口和 PostgreSQL。它覆盖审批重放、重复确认、投递前取消、委托执行断线和重放，以及在排程后重启 Worker。Run 验收还覆盖按游标补读、请求绑定断线后的取消、取消后拒绝迟到的模型结果、批准恢复、暂停继续，以及活动和空闲 Run 的手动压缩。

Worker 冒烟在同一个独立 PostgreSQL 数据库中运行两个仓颉进程，验证正常提醒只投递一次，过窗和已取消的提醒不投递。遗留的 `submitting` 邮件归档为 `unknown`，清除载荷且保留原尝试次数。邮件提交及异常响应由 `identity-mail.test.ts` 使用独立数据库和本地 HTTP 邮件服务验证。
