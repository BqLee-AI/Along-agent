# 仓颉默认生产入口切换验收

## 安装交接

- 独立本地安装通过 Bun 1.4.2、生产 Next 和 Docker Compose 启动 TS 基线 `sha256:dd5fa9f2daeb242398ef58bc9c2d113898d0a59bba2b8c1adf61cc74eaee8891`，经正式安装流程升级到仓颉候选 `sha256:69ccf9f5e764f008f86b891bd968628b2f357307a4ddc403306c1e2f38f98197`。升级保留 PostgreSQL 16，API 就绪返回 200，Web 未登录请求返回 401。Compose 仅有一个 API 容器运行，PID 1 为 `along-host`。
- 在升级后的安装中通过公开 API 确认提醒。仓颉 Worker 写入排程回执、一条通知和一条 `fired` 事件。停止安装再启动原 TS 镜像，同一公开 API 读回相同任务状态和排程回执。回滚使用已验兼容的相同 schema，升级前后等待检查结果都是空数组。
- 生产镜像 `sha256:851d9293c9e3e7e31a00ce1824e8ef2bb45cf2e0acd858b996941459c2c39daf` 上另行变更进程版本。旧 TS HTTP 入口创建待批准 Run 并退出。仓颉读回同一 checkpoint，未批准的恢复返回 409，确认后继续到 `thread.completed`。重试返回相同事件，原提醒提议只发生一次。

## 门禁与真实接口

- 同一生产候选通过 D7 的两轮空卷 Compose。无时间规则时 `/healthz` 200、`/api/v1/me` 与 `/api/v1/brief` 均 401、`/readyz` 为 503 `TZDB_UNAVAILABLE`。加载规则后 `/readyz` 200。
- D8 由候选镜像在独立 PostgreSQL 上执行，441 通过、1 跳过、0 失败、5,718 断言。报告检查确认所有指定公共用例、HTTP、native、wire 和 unknown 消费者通过。调度指定集 33 通过、265 断言。D9 在正向对照确实投递的同次运行中验证取消提交后 provider 调用数为零。审批、修订、历史时区和只追加相关六套独立数据库测试共 71 通过、404 断言。
- 移除旧 TS 编译启动文件后的生产镜像 `sha256:f7dfcc146acbadd178cf47e5f278728a0801d7cd2160535d58cecf3a6dab9712` 通过 `host-smoke.sh`。明文、TLS、未完成上传、账户、产品、Run、聊天提醒、Worker 竞争和重启、依赖故障及 SIGTERM 均按真实连接和隔离数据库验证。生产模型适配器连接本地确定性 SSE 端点，邮件和投递观察使用受控服务。
