# 本机生命周期实现验证记录（2026-10-27）

## 对象与边界

- 对象：`feat/67-local-lifecycle` 的本次实现，基于 `bb9e04b`；对应 [design/15](design/15-r1-local-lifecycle.md) 和 [OpenSpec tasks](../openspec/changes/close-r1-local-lifecycle/tasks.md)。
- 环境：Windows、Bun 1.4.2、Docker Desktop Linux x64、Compose 2.35.1、PostgreSQL 16；正式 API/native/MCP 镜像与 Windows 生产 Web 成套准备。
- 材料：checkout 外的隔离新安装及模拟原部署；历史、owner、登记、资料文件、卷及密钥都是本轮测试材料。没有接入用户原部署。故障迁移只存在于隔离发布副本，不进入本仓库迁移目录。
- 证据层级：进程与生命周期、受控合同、真实模型分开记录。以下结果不是 #68 正式开户或真实资料任务验收。

## 策略与目标缺失

- 登记诊断：先增加有效、无效及部分拒绝的行为断言，观察旧接口缺少诊断状态的 Red，再实现报告并 Green。
- 构建摘要：先观察 `.tsbuildinfo` 改变导致摘要变化的 Red，再排除生成缓存；回归保护可复用产物，不断言文件布局。
- 无认证模型：先观察原有合法无 key 配置被拒绝的 Red，再允许明确的空 key；保留其他字段及 NUL 校验。
- 原部署接管：真正无新安装标签的停止态旧 API 容器，原实现首次启动出现 `UNKNOWN_PROCESS`；修复后仅在核实基线后用 `--no-start` 重建容器归属，原卷和数据不变。
- Docker/Windows 进程、数据库目录核验及升级中断先做隔离实验。安装、权限、测试夹具和端口释放问题不冒充业务 Red。容器接管和 launcher 强杀用真实烟测取证，没有增加依赖整机 Docker 状态的常驻单测。

## 生命周期真实路径

| 范围           | 执行与观察                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次准备       | 真实 Windows ConPTY 中运行 `bun --no-env-file run local:init --new --config <私有配置>`，交互选择端口并明确不配置模型；成功准备，输入不回显生成密钥，未启动业务写者。              |
| 正式启动       | 同一配置 `local:start`，API/PG ready，Chromium 打开生产 Web，页面标题 Along，出现今日、对话、确认、任务、活动导航。未把未认证页面当作登录或模型验收。                              |
| 重复启停       | 两次启停、重复 start，配置字节与安装身份不变，没有第二组业务进程。日常 start 不构建；移去 Web 构建标记时报 `PREPARATION_REQUIRED`。                                                |
| 偶然环境       | 重启时注入错误的数据库、认证、origin、时间和模型环境变量；实际 API 仍使用私有配置的认证、时间和 origin，模型仍未配置，未落入注入的模型路径。                                       |
| 配置与重载     | 配置更新在安装锁内完成；保存失败保留旧字节。保存登记位置后安装范围重载成功，不选择管理员、不绑定新 owner。                                                                         |
| 原部署接入     | 采用原卷、数据库、认证密钥、origin 和登记；PG event trigger 禁止生命周期连接执行 DDL，init 及两次 start 均成功。历史、连续账本、owner、root 设备/inode、文件 hash 和配置字节保留。 |
| 缺失或未知材料 | 缺原卷返回 `ORIGINAL_VOLUME_MISSING`，不创建替代卷；未知端口监听返回拒绝且原监听者仍存活；缺 Docker PATH 准确报告 `DOCKER_UNAVAILABLE`。                                           |
| 未知账本       | 在隔离运行安装移去一条账本后普通 start 被拒，已有 API/Web 写者停止；原样恢复该测试行后才允许再次启动，入口未自动补账。                                                             |
| 登记失效       | 坏 JSON 为 invalid，缺文件为 unreadable，根失效为 invalid；失效项 accepted 为零。恢复原登记后 loaded；各次 `/readyz` 仍为 200，不混淆登记与数据库健康。                            |
| 选定产物       | 完成隔离后续版本后，从原 checkout 普通 start 仍复用选定的成套 API/Web 及其版本核验，不错误使用 checkout 的旧核验文件。                                                             |

## 数据库与停写升级

数据库烟测入口为 `scripts/local/database-smoke.mjs`，通过 stdin JSON 或导出的 `runDatabaseSmoke` 显式注入一次性 PG16 管理连接；不从环境取连接、不把连接串放进 argv。每个场景新建随机数据库，只清理本次成功创建的数据库。

已观察到 26 个真实 PG 场景通过：空库初始化、0016 重复零 DDL、伪造末行和伪造连续账、早期部分库、列/约束/CHECK 布尔括号/索引方向与 NULL 排序/触发器/默认值/可空性/表损坏、账本缺口及更高版本、许可竞争及断线 fencing、失败/中断/强杀后已提交步骤不重放，以及连接失败不当空库。

整机演练还覆盖：

- 安装锁阻止第二个 start/upgrade；真实迁移执行中另一个操作返回 `LOCK_BUSY`，没有业务写者。
- 未知数据库客户端使升级返回 `UNMANAGED_DATABASE_CLIENTS`；原客户端仍存活，不强杀。
- 目标 Web 被占用，新版本启动失败后所有业务写者保持停止；普通 start 返回 `UPGRADE_INCOMPLETE`。移除本轮占用者后显式 upgrade 前滚，API image 与 Web 摘要同代，原历史和资料不变。
- 实际数据库 dump 恢复到另一个随机库、资料 tar 恢复到另一个临时目录；恢复后的数据库内容及两个文件 hash 与原测试材料一致。
- 隔离发布增加测试用 0017/0018：0017 已提交，0018 失败，停写；修复后在 PG 语句执行中强杀 launcher，原 PG 会话仍持许可，显式重试准确返回 `DEPLOYMENT_BUSY`。
- 等待原 PG 会话自然结束后核账，实际已提交到 0018。随后显式 upgrade 成功启动配对目标；0017 canary 仍执行一次，没有将“launcher 已退出”误认为“事务已回滚”，没有重放已提交迁移。

## 回归命令与结果

| 命令/入口                      | 实际结果与环境                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun --no-env-file run verify` | Windows，10 步通过；unit 259 pass、2 skip、0 fail，1263 expects；6 个 OpenSpec strict 全通过；格式检查通过。原有 12 条 lint warning 无新增 error。 |
| `bun run test:contracts`       | WSL 中隔离 Linux Bun 1.4.2、正式 native 镜像和私有 PG；52 pass、0 fail、736 expects，进程内/HTTP 双跑及 D8 报告通过。                              |
| `bun run test:integration`     | 正式准备镜像、独立 PG/网络；233 pass、0 fail、28 文件，包含原认证、owner、批准、取消及 unknown 相关覆盖。                                          |
| `runDatabaseSmoke`             | 一次性 PG16 上 26 个场景通过；不会对现有应用库全量重放迁移。                                                                                       |

Next 构建在 checkout 外进行；不把 `next-env.d.ts`、本机配置、备份、运行记录、日志、生成媒体或临时夹具纳入提交。现有五个 required checks 保留；远端 CI 结果以实现 PR 的检查链接为准，不用本地结果冒充远端门禁。

## 未完成验收

获授权默认真实模型的私有配置材料未提供，未执行真实 provider 调用。没有替换 provider、模型或路由，也没有自动付费探测。健康响应、模型未配置诊断、受控合同和 native/MCP 测试不能补齐这项证据。

因此本次仅 `Refs #67 / #66`：OpenSpec 5.6、5.8 不标完成，不 archive、不关闭 #67，不进入 #68–#70 或 R2。完成真实模型材料路径验收后，才能判断是否具备收口条件。
