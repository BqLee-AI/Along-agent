# 个人 Bot 验证记录

实现由 [PR #211](https://github.com/BqLee-AI/Along-agent/pull/211) 合并为 `eea56d7d54228515f0c1566c4d0aa0d6dc91ad7f`。源码树与测试提交 `a956924c1160f984c439ac4b197b17d80cb40968` 一致。[CI 45861218153](https://github.com/BqLee-AI/Along-agent/actions/runs/45861218153) 的 `checks`、`database` 和 `integration` 均通过。

- Next Web、TS API、隔离 PG16。创建两个 Bot 和三个空对话，验证列表隔离、重载、只读深链和设置持久化。
- PG16 切换和恢复。`local-personal-bot-database.test.ts` 通过，10 个断言。未处理历史阻止升级，保留来源阻止清理。用 `pg_dump` 和 `pg_restore` 恢复到 `0041` 及原对话。
- 发布镜像及 TS 比较入口。`scripts/ci/contracts.sh` 通过，441 项通过、1 项跳过、5,726 个断言。`scripts/ci/host-smoke.sh` 通过，覆盖仓颉公开 Bot 路径、SSE、冻结指令与编辑后新 Run 的指令。
- Windows 本地单测。对同一单测集合使用 `--timeout 30000`，1,100 项通过、104 项跳过。默认 5 秒上限触发 Git 子进程测试超时。

本地发布镜像为 `sha256:9a3858543055467a0963ccdb5b19bc2e99cddd2ae1bee95fde3782e8fa15ff15`。构建使用下载镜像，Debian 摘要、Bun 版本及仓颉工具链锁保持一致。模型调用使用受控传输验证。
