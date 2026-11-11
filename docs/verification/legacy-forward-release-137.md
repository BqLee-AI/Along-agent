# #137 历史等待与前向发布验证

## 范围与责任

本阶段集成负责人验证旧协议、隔离 PostgreSQL 数据、目标 Linux 制品、受管升级及隔离 Web 历史读取。真实原安装、真实 provider 和其真实资料效果仍未覆盖；本记录不是发布批准。

## 协议与恢复

- 旧源码 `76f8b78bd334e025fc98b6c75cf4d9c7bb7b19ed` 经其 Dockerfile 的 `harness-artifact` 阶段重建 v5 native，二进制 SHA-256 `ce580258c3f9985e8c876903972fda497a7d5fefc05c3939e6817a734219a320`。隔离无网络运行时，当前 schema 接受的 v6 start 令其退出 2，返回 `HARNESS_PROTOCOL_ERROR`，没有请求。相同二进制的 v5 正向控制在受控模型帧下完成 measure_context、model、answer、model_next、snapshot、finish，退出 0。重建制品不证明原安装当时的二进制身份。
- 未知冻结工具先观察到错误恢复，修复后拒绝而不裁剪 allowlist；迭代或 token 预算耗尽时先观察到 `can_resume` 错误为 true，修复后不分配 attempt。损坏的历史 snapshot 保持只读可见，不具恢复资格。这些是隔离 PG 行为测试；环境配置或缺失导出错误不算行为 Red。
- 使用旧源码在任务自有 PG16 中创建正式账户及真实旧写者产生的待批准 Run。目标 Linux x64/Bun 1.4.2 制品在迁移前报告兼容；受管数据库组件取得部署许可后将 0020 前向迁移至 0027。迁移前后比较 Run（排除新加空列）、attempt、checkpoint、工具调用和批准的完整行摘要，全部相同，恢复记录为零；目标制品迁移后仍报告兼容。
- 仅在隔离测试账户，通过真实批准用例确认该测试批准，再经目标 TS 和生产 native、受控模型继续原 Run：最终 `done`，两个 attempt、一个恢复记录，原 allowlist 和冻结上下文不变。另一次隔离拒绝旅程保持原 allowlist 和上下文，并按 `APPROVAL_rejected` 终结为 failed。它们均不是原账户操作，也不证明真实 provider 的结果。
- 另一隔离旧库没有将两位测试 owner 绑定为原管理员；清点按 0024 身份迁移后资格将两个等待标为 `FORBIDDEN`，不将缺失的身份准入当兼容。首次用旧数据库验证时发现目标读取器依赖新身份表；修复后使用仅本数据库连接可见的临时视图预测原管理员准入，连接结束即销毁，不改变存储事实。实际迁移后再次清点，不用预测替代迁移结果。
- 使用与受管入口相同的 Compose 配置和目标镜像运行一次性清点容器，隔离旧库的两个不可适配等待均被识别。容器样本不等于完整 `local:upgrade` 运行，也不证明停写、备份和失败后的处理已端到端验证。
- 在另一隔离旧写者数据库完成同一迁移后，使用实际 Next Web、目标 API 和测试账户登录并打开历史会话；页面展示原提醒、冻结时间与确认正文、待确认状态，禁止另发消息绕过等待。只读验证未点击确认，也不证明 Web 恢复或实际通知。
- 在另一隔离 PG16，旧 TS/native 基于单 grant 和真实文件生成文档批准等待；0020→0027 前后原 Run、attempt、checkpoint、工具调用、批准和策略事实相同。对隔离合成用户以正式本机维护显式准入后，目标制品清点兼容；使用原展示 hash 明确批准，经目标 native 应用并通过 MCP 回读验证，最终 `done`、效果 `verified`，原冻结上下文、allowlist 和等待 snapshot 不变。受控模型并非真实 provider。另一隔离目录的旧 grant 使用超出安全整数范围的舍入 inode，目标精确身份不匹配，清点返回 `PERMISSION_DENIED`，没有批准或写入；不将成功推广为所有旧 grant 可恢复。
- 独立受管安装复用真实旧写者产生的两个旧等待：首次 `local:upgrade` 在 0020 清点均为 `FORBIDDEN`，阻断并停写。第一次经 TTY 明确选择和确认一个 Run 后备份、迁移到 0027，产生真实 `thread.cancelled` 和取消账回执；另一 Run 的行摘要不变，仍阻断升级且只运行 PostgreSQL。第二次独立确认另一个等待后，产生其停止事件和回执，清点为空，受管升级完成并启动配套目标 API/Web。两份原批准始终为 pending、行摘要不变，恢复记录为零。首次和第二次使用不同目标源码摘要，最终目标摘要 `0f0440a4cf8cbf2970bdc6098a5b3bfb7316b83e1f32fe7d7b980ee9337e61a1` 与验证时工作区相同；这是隔离安装，不是原安装。备份包含数据库 dump、资料归档及完整标记。停止私有回执文件只保留最近一次，之前的停止仍有数据库事件和取消账。
- 逐项停止使用探索既有公开取消事务的策略，而非测试先行；定向 PG 回归验证等待引用不匹配时拒绝、只停止所选 Run、另一等待不变、两份批准仍 pending、保存取消事件和幂等账。实际受管旅程另验证 CLI、备份和部署流程，不以该测试代替用户路径。
- head `e1791eb75476863ba4d1b4ccc42501b3892e19b1` 的 Linux x64、Bun 1.4.2 目标容器执行 `bun run verify`，十步全部通过；隔离 PG16 的 `bun run test:integration` 为 610 pass、`bun run test:scheduler` 为 32 pass，均零失败。WSL Linux `bun run test:contracts` 重建生产 native，277 pass、0 fail，D8 和 10 项可执行门通过。后续维护入口改动须另行验证。
- 后续停止入口代码的 Linux x64/Bun 1.4.2 验证：`bun run verify` 十步通过（unit 813 pass、85 skip、0 fail）；隔离 PG16 `bun run test:integration` 611 pass、0 fail，`bun run test:scheduler` 32 pass、0 fail；WSL Linux `bun run test:contracts` 重建生产 native，277 pass、0 fail，D8 与十项可执行门通过。首次在受管构建快照内运行完整 `verify` 因快照不含 `.gitignore` 而扫描依赖失败；干净源码构建的首次完整验证因文档尚未格式化在最后一步失败，格式化后完整重跑通过。

## 仍未覆盖

- 真实安装的原等待清点、配套制品身份和受管升级；原安装启动可能推进旧提醒，不能把隔离 PG 升级当成无副作用证明。
- 不兼容等待的逐项受管停止与前向升级已在隔离安装验证；原安装中的等待只能由有权用户明确选择处置，本次没有替用户确认或停止。
- 旧版文档批准、单一 grant、真实文件与 snapshot 1 的完整升级恢复组合仍缺；上面的隔离旅程使用 snapshot 2。
- 原账户真实 provider 的独立执行层全写工具护栏尚未建立及正反验证，不发送可能写入原账户的请求；自然通知、Web 和文件的本次真实混合目标仍缺。
- 原安装护栏评估：过滤 native 的工具集合可约束模型工具调用，但不覆盖后台 scheduler 和 API 启动时的 run-driver 恢复写入。要安全运行原账户真实目标，仍须独立限制数据库业务写、工作区文件和后台服务，并对实际派发与效果做正反验证；当前未建立该完整护栏，也未启动原安装进行此项测试。
- 不以本记录勾选 2.8 或 #104 第 3 节。既有切片证据与本次缺口见 [证据矩阵](assistant-delegation-104-evidence-matrix.md)。
