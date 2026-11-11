# 本机初始化、启停与升级

> 状态：Required；本机生命周期使用指南。
> 范围：Windows Web、Docker Linux x64 的 PG16/API/native/MCP、私有安装配置。
> 包含：正式账户、有限工作区、会话历史、本人委托与原 Run 的有限恢复；不含任意崩溃自动恢复或自动恢复备份。
> 阶段：R1 与本人目标内委托；生命周期见 [design/15](../design/15-r1-local-lifecycle.md)，账户见 [design/16](../design/16-r1-account-access.md)，历史见 [design/17](../design/17-r1-conversation-history.md)，上下文见 [design/18](../design/18-r2a-harness-context.md)，目标委托边界见 [design/20](../design/20-goal-scoped-delegation.md)。

## 环境与安装身份

使用 Bun **1.4.2**、Docker Desktop 的 **Linux x64** 引擎及 Docker Compose **2.24.4+**。首次准备需要联网安装锁定依赖、下载镜像并构建正式仓颉与 Web。Windows 执行 Web；API、worker、native 和 MCP 在同一正式 Linux 镜像内运行，不使用开发 server 替代。

在仓库根目录运行命令。默认私有配置为 `%LOCALAPPDATA%/Along-agent/local.json`；它及所在专用目录仅当前 Windows 用户可访问。可以用 `--config <绝对路径>` 选择 checkout 外的另一个专用私有目录；此后所有入口必须选同一文件。不要把配置放在仓库、共享目录或 `.env` 中，不要将其内容贴进日志、issue 或聊天。

配置保存固定项目、原卷引用、数据库身份、认证密钥、Web origin、三个 loopback 端口、时间资源版本、模型配置及登记文件位置。环境中偶然存在的 `DATABASE_URL`、`BETTER_AUTH_SECRET` 或模型变量不能覆盖它。重命名 checkout 不会生成新安装身份。私有目录中的 `installations/` 保存成套构建、运行记录、升级记录与备份；不要在服务运行期间删除这些文件。

## 首次新安装

**只有确认不存在需要保留的原安装时，才选 `--new`。** 在交互终端执行：

```powershell
bun --no-env-file run local:init --new
bun --no-env-file run local:start
```

首次按提示选择三个固定端口，默认 PG `55432`、API `3000`、Web `3100`。时间版本必须与本版本内置资源相符，使用提示中的默认值；不要凭日历年份填写。模型可以明确暂不配置；需要配置时输入已获授权的原 provider、模型、key 和预算，不提供替代模型默认值。原服务明确无认证时 key 留空，不额外生成认证材料。敏感输入不回显，也不通过命令行参数传入。

配置模型还必须显式设置独立单次输出上限 `model.completionCap`（正安全整数），不能把 `model.maxTokens` 的 Run 余额填作单次额度。可选 `model.modelWindowTokens` 只有明确模型依据时填写正安全整数，省略/null 表示未知；`model.reserveTokens` 为非负安全整数，省略按0传递。旧私有模型配置缺 completionCap 时明确报 CONFIG_INVALID：停写后在原私有文件补该字段，保留原身份、密钥、卷和其余设置；不重新初始化安装，也不由工具静默猜值。对应容器变量为 `HARNESS_COMPLETION_CAP/HARNESS_MODEL_WINDOW_TOKENS/HARNESS_CONTEXT_RESERVE_TOKENS`。累计预算仍为原 `maxIterations/maxTokens`。

`init` 建立一次配置、准备专用持久卷和成套产物，只有核实为空的新应用库才执行全套迁移。它不启动业务写者。已有配置再次 `init` 只复用，不重新生成密钥或覆盖登记；除下述首次接入原部署的准备阶段外，数据库仍须完整核验为当前目标版本，旧库应显式 `local:upgrade`。

`start` 复用准备好的 API/native/Web，不安装、不构建、不执行 DDL。打开命令输出的 Web 地址；固定地址是认证 origin，不要自行把 `localhost` 与 `127.0.0.1` 混用。在 Web 按“首次建号”创建唯一管理员，再运行下文 `local:account` 完成工作区登记。账户、模型、工作区是三个独立状态；账户成功不意味着资料任务已可用。本入口不 seed 用户。

## 接入原部署

先备份原配置与数据，并按原部署方式停止 **API/worker/Web 及它们的 native/MCP 子进程**。不接管未知进程，不从端口号猜归属。确认原数据库是完整的 `0016` 基线或后续受支持版本；只知道最后一条版本行不足以接入。

旧 `0016`/`0017`/`0018` 原部署在交互终端执行：

```powershell
bun --no-env-file run local:init --adopt
bun --no-env-file run local:upgrade
```

首次 `init --adopt` 只对完整核验为受支持、且不高于目标版本的原库完成准备和安装归属确认；不会向旧库应用 DDL，也不启动 API/worker/Web。输出列出原库版本、目标版本及是否必须升级。需要升级时必须显式 `local:upgrade`，由该流程停写、备份、应用前向迁移、核验并启动；成功后无需再 `start`。已完整核验为目标版本时，准备后执行 `local:start`。日常 `start`、重载及常规 `init` 只接受完整目标版本，未知/部分库与高于目标的库均拒绝。

准备并按提示准确提供：

- 原 Compose 项目、原 PG 卷和资料卷、原资料容器挂载位置，以及明确的 loopback 端口；
- 原数据库用户、密码和库名，**同一个** `BETTER_AUTH_SECRET`；
- 原 Web `APP_ORIGIN`，必须为与所选 Web 端口匹配的 HTTP localhost 或 127.0.0.1 origin；
- 原时间资源版本、原模型配置和预算；
- 原登记 JSON 的绝对路径；只有原本没有登记时才留空。

已存在默认配置时，先核实是否就是原安装，不要覆盖或另建一套来掩盖缺失材料。要使用明确恢复的配置，可以给本节所有命令都加相同的 `--config`。原部署对外监听时，先由部署者明确处理监听与 origin，不能原样作为本机受支持安装接入。

缺原密钥、卷或登记来源时，恢复原材料再试。不要生成替代认证密钥、复制新 root、创建同名空卷、修改 owner 或补写账本。空库不能作为“原部署”被自动初始化；部分初始化库也不自动清空或重放。

## 正式账户、原身份转正与重登

所有命令使用同一私有配置；以下用 `C:\AlongPrivate\local.json` 举例，不要把真实文件内容或口令贴到终端输出、issue 或聊天。命令不接受密码或 owner ID 参数：

```powershell
bun --no-env-file run local:account --help
bun --no-env-file run local:start --config C:\AlongPrivate\local.json
bun --no-env-file run local:account --config C:\AlongPrivate\local.json
```

- **全新空安装**：先在 Web 首次建号，填写登录名、展示名和口令；不通过 seed、临时 Cookie 或本机默认用户绕过初始化。Web 成功后账户已经提交且可登录，工作区仍可能待配置。
- **保留原会话**：Web 可以在真实旧签名会话下明确确认转正当前用户；开发桥不是凭证，页面不能指定其他用户。
- **原会话失效或没有会话**：在交互终端运行 `local:account`。命令显示有限候选摘要，必须明确输入序号，再输入对应的 `CONFIRM <序号>`；没有默认选择，不按唯一或最新 seed 认领，不让你复制/手填 owner ID。已有口令必须输入原口令验证，本流程不重置口令（遗忘口令见下面的 `--reset-password`）；无口令才设置并重复新口令。disabled、deleted_requested、credential 冲突或孤立历史 owner 不会被激活、合并或自动修复。候选只有相同展示名时请停止并先核对原材料，不猜选。
- **原普通用户保留身份准入**：管理员已绑定后运行 `bun --no-env-file run local:account --admit --config C:\AlongPrivate\local.json`。从公共维护候选中明确选择原用户序号并输入 `CONFIRM <序号>`，填写原登录名和原口令；已有非空密码必须真实验证且哈希保持不变，无密码合法seed才显式设密。只建立该原owner的准入，不绑定/替换管理员、不激活disabled用户、不修改业务owner或资料登记；准入成功不等于工作区已配置。
- **已准入账户遗忘口令（本机重置）**：邮箱找回不可用（无已验证联系邮箱或无邮件配置）时，先用同一配置 `local:start`，再在交互终端运行 `bun --no-env-file run local:account --reset-password --config C:\AlongPrivate\local.json`。与上面相同的 TTY/隐藏输入规则，不接受 argv 口令；命令要求原 PG 已由 `local:start` 启动并通过完整目标基线，不执行 DDL。显示有限候选摘要（展示名、状态、管理员/普通账户、是否可重置），必须明确输入序号，再输入 `CONFIRM <序号>`；没有默认选择，不显示也不接受 owner ID。只有 active、已准入且恰有一个 credential 的账户可选（绑定管理员和已准入普通用户）；disabled、deleted_requested、未准入或 credential 冲突一律拒绝并保持原状。新口令 8–128 字符、不 trim、隐藏输入两次，经与其他本机/Web 设置口令相同的 Better Auth 哈希与 credential 写路径写入。同一 PG 事务内还会撤销该用户全部会话、递增 credential revision、作废其未消费的找回/验证挑战并抑制排队邮件；用户 ID、登录名、管理员绑定、联系邮箱、业务 owner 数据、资料登记和私有配置都不变，不重载服务。任何一步失败整体回滚，旧口令继续有效；成功后用原登录名和新口令在 Web 重新登录。登录名本身无法由本命令找回，且本命令不新增审计表或事件（identity 没有账户维护审计约定）。

登录名服务端 trim/lowercase，规范化后 1–128 字符；展示名 trim 后 1–128 字符。口令 8–128 字符，**不 trim**；本机口令输入隐藏，不放 argv、普通输出或日志。使用密码管理器妥善保存。受邀接受、联系方式验证及邮箱找回依赖独立显式密钥/邮件配置。本机维护只在上条 `--reset-password` 下重置已准入账户的已有口令；不提供改登录名、重新绑定管理员或第二管理员入口。

正式 Cookie 会话创建后固定 **7 天**，浏览/GET 不续期。退出或过期后在 Web 使用原正式账户重新登录，不重新建号或换 user ID。只有受保护请求的 HTTP 401 才引导登录；403 权限/CSRF 与 503 依赖故障应按原错误处理。重登仅 GET 恢复原任务、批准或 Run；原发送、确认、取消或继续等 POST 不会自动重放，必须重新读取事实再明确操作。

## 工作区本机收尾

`local:account` 是一次性维护，不运行常驻宿主服务。默认从公共绑定事实派生管理员owner；`--workspace` 从公共服务列出的active且已准入候选中明确选择并复核owner。浏览器、模型和维护参数都不能指定owner或root；root仅在受信本机交互维护中填写。命令要求原PG已由同一配置的 `local:start` 启动，并通过完整0023目标基线；旧受支持基线须先显式 `local:upgrade`，维护不会执行DDL。

1. **已有正确登记**：核验管理员的原 workspace_id、root、有限权限及物理根身份，保留登记文件字节，不归并或修改其他 owner。配置已经指向同一登记时不重写配置。原登记无效、不可读或只有其他 owner 时停止，修复原来源再重试，不把坏文件当空白覆盖。
2. **没有登记**：先由部署者在**原受管资料卷内**准备明确子目录及获授权资料；命令不创建/复制 root，也不默认授权整个卷。仅限刚刚通过本安装 `start` 核验的新安装，可在 PowerShell 使用原私有配置定位本安装容器并准备全新子目录，例如：

   ```powershell
   $local = Get-Content -Raw C:\AlongPrivate\local.json | ConvertFrom-Json
   docker exec "$($local.project)-api-1" mkdir -p "$($local.workspaceMount)/documents"
   # 将你有权授权的本机文件复制到刚准备的全新目录；不要替换原部署 root。
   docker cp C:\YourDocuments\notes.txt "$($local.project)-api-1:$($local.workspaceMount)/documents/notes.txt"
   Remove-Variable local
   bun --no-env-file run local:account --config C:\AlongPrivate\local.json
   ```

   在维护提示输入 `CONFIGURE`，明确填写容器内子目录（默认挂载示例 `/var/lib/along/workspaces/documents`）、显示名、可读相对文件路径 JSON 数组、可写数组及可创建产物的已有输出目录数组，最后输入 `REGISTER`。输出专用工作区可以将读写文件数组均设为 `[]`；输出目录允许读取其中获授权的普通文件并创建新文件，不授予覆盖已有文件或创建目录的权限。没有默认路径授权；写路径必须也在读路径中，不允许绝对路径、`..` 或整个卷授权。工具复用正式工作区 schema/物理 root 校验器；目录权限不符应由部署者修复刚准备的目录，不更换原 root。

   系统使用 `.along-<UUIDv4>.tmp` 格式的内部临时文件名，避免读取尚未发布的内容；不要将此格式用作产物名称。其他名称不因此被保留。

   物理身份采用无精度损失的设备号和文件号。旧记录若使用超出安全整数范围的近似身份，不能证明仍是同一对象，升级后会拒绝使用；需要重新登记相应文件并启动新 Run。安全整数范围内的旧身份保持兼容。

3. **发布与加载**：私有原子发布到配置同目录的 `workspace-registry.json`，不覆盖已存在文件；经 `updateConfig` 保存 registryFile。释放安装锁和本次数据库连接后，单独 `reloadInstallation` 停本安装写者并核对加载结果。不会停未知服务、自动循环重试、发模型请求或执行 Agent。
4. **普通owner有限新增**：运行 `bun --no-env-file run local:account --workspace --config C:\AlongPrivate\local.json`，明确选择已准入owner序号及 `CONFIRM <序号>`，再输入 `ADD`。root、读写路径和 `REGISTER` 的规则与上文相同；复用正式物理root/重叠冲突校验器，不能重新授权原root或重叠目录。现有全部owner、workspace_id、root、权限和物理身份都保留；只追加新条目，先发布新的私有 `workspace-registry.<uuid>.json`，原来源文件字节永不覆盖，再比较原配置/来源字节版本并原子切换registryFile。并发编辑、root更换或配置版本变化均停止，不覆盖来源。已选owner已有登记时输入 `LOAD` 只核验并重载，不创建新workspace；输入 `ADD` 才明确另增。无效/不可读原登记必须修复，不能当空文件覆盖。

账户 PG 提交、宿主文件/配置发布、安装重载**不是同一事务**。请按明确阶段恢复，不重新开户：

| 状态输出                                                         | 含义与恢复                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account_unconfigured`                                           | 尚无绑定且没有可用原用户；空安装先 Web 首次建号，原安装恢复原材料。                                                                                                                |
| `account_committed` / `account_committed_workspace_unconfigured` | 账户已提交，工作区未完成；可以正式登录，继续本机有限路径收尾。                                                                                                                     |
| `registry_absent`                                                | 未指定登记时可以明确准备新有限登记；原配置已指定文件却缺失时停止，恢复原文件，不在原位置重建。                                                                                     |
| `registry_invalid` / `registry_unreadable`                       | 原登记坏/不可读；保留文件、root 和 owner，修复来源或私有权限后重试。                                                                                                               |
| `registry_published` 后保存失败                                  | 已发布登记、原配置保留。默认新登记可核验复用；`--workspace` 输出的新版本必须保留并核对后显式选用，不能盲重跑ADD制造另一工作区。配置切换后用同一owner的LOAD只做收尾，不覆盖原来源。 |
| `config_saved_reload_failed`                                     | 配置已保存但重载/加载确认失败；账户和原资料保留。修复依赖或归属后默认管理员命令或已选普通owner的 `--workspace` + `LOAD` 仅重做加载。                                               |
| `registry_loaded`                                                | 登记已成功加载；访问仍受原 owner 和有限路径限制，不表示模型调用已验证。                                                                                                            |
| `CONFIG_VERSION_CONFLICT` / `WORKSPACE_IDENTITY_CHANGED`         | 私有配置/登记字节版本或物理root已变化；新发布版本不等于已切换。保留全部来源，重新核对后显式维护，不覆盖并发变更。                                                                  |

账户写入/COMMIT 结果不确定时，先再次运行同一维护入口读取真实绑定；已绑定便只做收尾，不覆盖原口令。期间若发生其他生命周期操作、配置/登记或物理 root 变化，命令停止并要求重新读取事实；不要删除文件或反复自动重试来掩盖变化。

## 日常操作

```powershell
bun --no-env-file run local:start
bun --no-env-file run local:stop
bun --no-env-file run local:start
```

重复启动不会增加第二组服务；重复停止保留配置、数据库、资料卷、原登记和文件。`stop` 只停止核实属于本安装的进程，不按端口杀进程，也不删卷。先结束或明确停止活动任务：停止会断开 request-bound/legacy 执行连接，不回滚已接受的时区设置、提醒或文件效果。重新启动不会提交消息、批准、自动继续 Agent 或重写 unknown。

端口被他人占用时，不自动换端口或抢占。先核对占用者，按其原流程处理；若明确调整本安装的固定端口，应停服务并同步修改私有配置中的端口与 origin，不能只改其中一个。

## 找回会话、Run 和真实结果

正式登录后打开“对话”，从服务端会话列表选择原会话，再选择指定 Run；不需要保留旧 URL、浏览器临时状态或手工填写 ID。列表按建立时间排列，不按最近活跃排序。“继续读取”会追加下一页，显式刷新重新读取最新范围；分页不是跨请求快照，较晚提交的事实可能需要刷新才能看到。

指定 Run 分别读取可信关联的原话、跨全部 attempt 的已存回复、全部批准及真实结果。原话保留空白和换行；历史缺少可信关联时明确说明，不猜测关联。消息档案可独立展开，最终 assistant 档案不会重复拼入 Run 回复。提醒批准可沿实际后继提议进入真实任务；文档批准与文件已保存、已回读验证是不同事实，以已存效果证据为准。

某一部分读取失败时保留其他成功部分，并显示 HTTP 类别与只读 GET 重试；未读取完整不等于空历史。只有真实 401 才要求重新登录。403、404、503 不是会话过期；请按原错误处理，不通过重新发送原话修复读取失败。

本人委托的运行详情显示接纳时冻结的生命周期：`server-owned` 可在断开订阅后按原预算继续；较早的 `request-bound` 和 legacy 保持原连接语义。目标结果来自持久 `GoalResult`，分别显示 completed/partial/blocked/cancelled/unknown、逐项状态和接受回执，最终答复来自其 `answer`；Run done 仅表示执行结束。直接创建提醒显示冻结时间、任务详情链接和创建回执，排期/触发/站内通知各自核对任务真实记录。中断后仍能读取已接受的设置、提醒或文件效果，不因重连自动执行第二次。legacy/v1 历史仍按原字段和批准合同读取。

列表、翻页、刷新、回退和重登恢复不会发送业务 POST、调用模型、自动继续或重放批准。原 Run、批准和任务深链仍可使用；工作区撤权后可读冻结历史，不代表仍可确认、拒绝、继续或执行工具。只有明确选择发送新消息或原 Run 的显式操作时才进入执行路径；离开正在使用的主动连接仍遵守原断连合同。

当前选中的 Harness 提醒等待点会在对话内展示完整冻结正文、时间和时区。审阅后可明确点击“确认创建并继续”或“确认取消并继续”；系统核实原批准 consumed 和真实任务引用后，仅继续原等待点。确认回执未知时先读取原提议，已确认后的恢复失败只重试原恢复，不重新确认。后继提醒与文档仍需各自授权；business 提醒快捷入口保留独立批准页，浏览历史、刷新或重登不会自动执行。[验收范围](../verification/inline-reminder-verification-2026-11-02.md)区分历史证据与隔离安装实测。

## 开始任务与审阅文档

1. 打开“对话”可直接与真实 Agent 交流，输入可沿同一会话明确追问。普通 Agent 采用本人委托，可保存或清除本人默认时区、创建或取消明确提醒，并在冻结的本人登记范围内检索、编辑资料和创建文件。经过时长从本次请求的可信接纳时间起算，超窗不会自动顺延；日历时间仍按实际时区规则处理。本人时区只支持已有有限别名/规则，单次指定不会自动保存。legacy“创建提醒”或“处理资料”快捷入口保持原批准合同。
2. 处理资料时检查本人登记及其完整可读/可写相对范围。普通委托省略选择时冻结本人当时可用的登记集合；显式选择只收窄范围。legacy 资料入口选择单个工作区。页面只操作登记的受管文件；登记若指向副本，不会直接修改未登记的原件。没有登记时使用原安装的本机维护入口，不在 Web 输入任意宿主路径。
3. 明确发送后，在原会话阅读连续消息与逐项结果。模型使用接纳时冻结的最新63条同会话可见消息和本轮输入，不是永久记忆；旧消息仍可从档案读取。执行中、等待批准或效果未知时不能发送新消息绕过原运行。助手文本不是写入或核对回执；本人设置依真实目标结果和接受收据核实。以下文档审阅步骤只适用于 legacy 资料流程：文档批准链接在新标签页打开，保留原连接。
4. 在完整校样页检查 before/after、完整目标正文和冻结确认正文，再明确批准或拒绝。批准只记录授权，不保存文件，也不自动继续；提醒批准与文档授权不是同一类结果。
5. 返回原 Run，读取最新状态与资格，再明确继续。当前不可继续不自动说明原因；`unknown` 可能已有文件效果，不盲目重做。写入接受与随后新读取核对分开显示，取消不撤回已发生效果。
6. 离开或刷新只对冻结为 `server-owned` 的 Run 停止订阅；早期 `request-bound` 和 legacy 仍按原连接合同处理。显式停止不撤销已接受的提醒或文件效果；未知效果不得盲目重做。

本版本配套使用 `harness/v6` API/native/Web：新委托冻结可信上下文，legacy 明确传 `trusted_context:null`；新委托 SSE v2 与旧 v1 历史同读，snapshot仍为2。数据库须按迁移账本前向升级并核验实际结构；旧 Run 和批准不因部署扩权。新授权或其他新语义事实产生后，不能交回不理解这些事实的旧写者；按原安装显式升级，不另建安装或替换原认证密钥。

顶部「助理」进入对话，「事项」收纳今日安排、提醒、待确认和活动记录，账户设置在独立菜单；桌面与窄屏保持同一层级。各页恢复方式见 [Web 使用说明](../../apps/web/README.md)。提醒任务与活动页不充当资料任务历史，文档批准从原 Run 的修改与结果进入。

## 显式升级与失败维护

取得目标源码后，使用同一配置：

```powershell
bun --no-env-file run local:upgrade
```

升级准备同批产物，取得安装锁及数据库部署许可，停旧写者并禁止其自动重启，确认没有未知数据库客户端。目标制品在迁移前只读清点全部等待批准的 Run，使用原冻结范围与候选部署配置检查能否适配；不可适配则停写，不更改或消费等待。随后备份数据库和资料卷，应用新增迁移并再次清点，通过后才启动新版本。清点结果位于私有安装目录的 `waiting-inspection-before-migration.json` 和 `waiting-inspection-after-migration.json`，含 Run 标识及状态，应作为私有资料保管；`compatible` 不是批准，也不表示已恢复，`blocked` 需要在原合同下处理后重新清点。备份位于 `backups/` 下；数据库 dump 和资料归档均完成后才写完整标记。它们含用户资料，不能上传仓库。

若迁移前清点报告 `blocked`，当前受管入口没有已验证的方式启动旧版本处理等待；保持停写并保留清点、升级记录与原数据，不要删除未完成标记或手动启动旧写者。需先核对处置方案后才能继续升级。

**R2-A 配置与原安装升级：**

保留原安装，不清库、不删卷、不重新建号。先在原版本、原配置仍有效时执行 `local:stop --config <原私有配置>` 停稳；私下备份原配置与登记，再取得目标源码，在原私有配置的既有 `model` 对象中显式补 `completionCap`。旧CLI不认识该新字段，新CLI也不会替缺字段的旧配置猜值，因此不要先改配置再用旧CLI停机。

隔离真实验收使用 completionCap=4096，只是已验证的选择依据，不是工具自动补写的默认值。保留原 provider、model、key、maxIterations/maxTokens、认证密钥、身份、卷、origin和登记；没有可信依据时不填写模型窗口或精确输入meter。400万累计额度仅获授权用于隔离验收，不迁入原安装；原64000额度不能保证完成同规模的六份大资料任务。

随后从目标源码运行 `bun --no-env-file run local:upgrade --config <原私有配置>`；该入口自己备份数据库和资料卷、按原账本应用尚缺的前向迁移、完整核验并启动，不需另做 `init --new`、`init --adopt` 或重复 `start`。尚未由生命周期入口接管的旧部署才沿“接入原部署”执行 adopt 准备。

升级后核对目标版本/就绪、原正式账户、原历史与资料登记。读取历史不授权或继续旧等待；如需继续，先审阅原冻结内容并明确执行原 Run 的操作。隔离验收不代替原安装核验；失败保持停写，按本节维护合同处理，不删除升级记录或换新卷绕过。

升级期间不要手工启动另一套 API/worker，也不要直接调用全量迁移脚本。`0012` 之前没有版本账，不给 `0001–0011` 补行。无新增迁移时不重放已有步骤；后续迁移配套显式版本核验，而不是用任意最大版本行推断兼容。

升级失败或中断后保持停写。`upgrade.json` 标明阶段，下一次普通 `start` 不绕过未完成记录。先核对私有构建日志、备份完整标记及真实账本，修复失败原因，再显式重试 `local:upgrade`。已提交步骤不重放，提交结果不确定先重新连接核账。不要删账本、伪造完成标记、清库、恢复旧写者或重做 unknown；接受新事实后只能停写前滚。备份不是自动回滚新事实的许可。

launcher 退出不代表 PG 中的语句或事务已经结束。若仍提示部署许可忙，保持停写并等待原会话结束，再重新核账；不要抢占许可或把“客户端已退出”当作回滚证明。服务器可能已经完成提交，显式重试必须接受该账本事实并跳过已提交步骤。

| 提示                                  | 处理                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| 缺依赖/产物                           | 首次用 `init` 准备；已有安装用显式 `upgrade` 修复，不靠日常 `start` 临时构建。 |
| 配置缺失/权限不符                     | 恢复同一私有配置及专用目录权限；不要新建密钥代替。                             |
| 连接失败                              | 检查原连接材料和 Docker/PG；失败不是空库。                                     |
| 未知/部分库、账本缺项、结构或版本不符 | 保持停写、备份并人工核对；不 stamp、不降级。                                   |
| 未知进程/卷使用者/数据库客户端        | 核实原部署并人工停稳；入口不强杀。                                             |
| 安装锁忙/部署许可忙                   | 等待另一操作结束，不删除记录或凭 PID 终止未知进程。                            |
| 升级未完成/许可丢失/新程序失败        | 保持停写，按失败阶段修复并显式重试。                                           |

## 登记与诊断

新安装只准备专用资料存储，不自动授权任何路径或选择管理员。原登记在 API 启动时加载，仍须满足 [工作区与文档批准合同](../design/14-r1-document-task-loop.md)。缺登记文件、无效 JSON、无效 root/权限和未配置分别诊断；失效项不开放，不能把坏登记当作空白安装覆盖。原 root 的设备/inode 等物理身份、owner 和有限路径权限必须保留。

进程存活、`/healthz`、`/readyz`、模型配置存在和真实模型调用成功是不同证据。日常启动不主动发模型请求，也不修改资料。配置了模型只报告未核验；缺模型不会偷偷使用其他 provider。

### 受邀账户密钥与邮件的显式配置

原私有JSON允许可选 `identityKeyringFile`（checkout外私有JSON的绝对路径）及 `identityMail: { provider: "resend", from: string, apiKey: string }`。不配置时保持缺依赖503，不从环境、原BETTER_AUTH_SECRET或数据库密码派生新密钥，也不自动生成生产keyfile。配置的keyfile启动写者前必须私有可读且通过严格keyring解析，只读单文件挂载到 `/run/along-identity-keyring-source.json`，不挂载整个私有目录；容器用私有权限复制为 `/run/along-identity-keyring.json`（0600）后启动 API。这样兼容 Windows ACL 私有文件的 Linux bind 权限呈现，不放宽 loader 校验；每次容器启动重新复制，轮换后须正式 reload。

keyfile形状为 `{ version: 1, lookup: { id, key }, challenge: { active, keys }, encryption: { active, keys }, rateLimit: { id, key } }`；各key是独立32字节密钥的标准base64，keys是有限key-id到密钥的对象，active必须存在。由获授权部署者在独立私有存储准备，勿粘贴真实内容到文档、日志或仓库。lookup轮换需停相关写入、全量唯一核验后切换，不把不同key-id当地址唯一性的分区；密钥材料变化必须使用新key-id，不得用相同ID替换密钥。当前地址、待处理邀请或未终结有效凭证的lookup版本与配置不一致时，相关邮箱操作返回503，恢复原密钥或按已批准流程完成迁写后再试；不会自动生成替代密钥。

生命周期只从私有配置映射 `IDENTITY_KEYRING_FILE`、`IDENTITY_MAIL_PROVIDER`、`IDENTITY_MAIL_FROM`、`IDENTITY_MAIL_API_KEY`，`APP_ORIGIN`沿用config.origin；ambient同名环境不透传，API key不进argv/诊断。`provider: "resend"` 只是已实现transport的显式选择能力，不代表已批准外部供应商、发信/DNS/采购或生产开关。配置保存、私有文件发布、PG提交及reload相互独立；本命令不外发邮件测试、探测模型或创建 `.env`。

## 配置保存与安装范围重载（#68 集成）

`scripts/local/config.mjs` 提供 `loadConfig`、原子 `saveConfig` 和带安装锁的 `updateConfig`；更新失败保留旧值，安装身份、卷、数据库身份与认证密钥不可被更新接口替换。调用方在 checkout 外私有配置上操作，不新建第二份 owner/授权事实。

`local:account` 完成明确授权的账户操作、有效登记私有发布后，经同一配置保存registryFile，再调用 `reloadInstallation(file, { expectedConfig, expectedConfigVersion })`。配置与来源均比较实际JSON文件字节版本，同JSON但空白变化也不能覆盖；原登记仅追加发布到全新版本，不原位改写。reload在自身锁内核对配置、归属、基线与部署许可，停止本安装写者后重新加载；不会恢复Agent，也不决定管理员。`updateConfig` 与reload分别加锁，调用方先释放维护锁和数据库连接，不嵌套；`--admit` 只做原owner准入，不伪称完成文件/config/reload。`loadPrivateJsonSnapshot` / `savePrivateJson` 复用私有文件权限、字节版本及原子发布约定。

## 实现验证记录

隔离安装、故障演练、回归结果及真实模型路径补验见[2026-10-27 验证记录](../verification/local-lifecycle-verification-2026-10-27.md)。该记录不替代本机实际配置核验，也不是正式账户验收。
