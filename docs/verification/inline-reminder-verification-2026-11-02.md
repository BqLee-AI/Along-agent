# #91 对话内提醒确认验收记录（2026-11-02）

> 状态：Observed；分版本验收记录。
> 范围：#91 历史证据与当前隔离 Web/API/native/PG 补验。
> 不包含：原安装升级、通知必达、免批准或 R2-B 接管证明。
> 阶段：R1 对话内提醒确认。

## 对象与证据层级

- 代码基线：实施合并提交 `32411ce84c784abce0242d916d7569761a032448`。对应 [#91](https://github.com/BqLee-AI/Along-agent/issues/91)、[实施 PR #99](https://github.com/BqLee-AI/Along-agent/pull/99) 与[收口计划](../plans/inline-reminder-closeout-plan.md)。
- 历史结果来自 #99 及本机仓库外原始验收记录；下面明确标为历史，不冒充本次新运行。原始记录含源码指纹、API 镜像、Next BUILD_ID 与截图定位。
- 本次只使用专用隔离安装、测试账户、合成资料和授权模型连接；不修改原安装、不操作真实用户任务或资料，不改变 R2-B 默认 off。

## 可复用历史证据

首次真实 UI 的源码为 `2d7cdcbd9149f0ce4c80853a1e49f45086eaa127`；冻结源码摘要为 `61bbdad10504c58602ef5e7df2256bbe11456c2672d8ed4d760fc6784e781e09`，Next BUILD_ID 为 `MASivswNQpY2f5ER3ANfF`，API 镜像摘要为 `sha256:9583d61a00cf43d5d3ef6134587433abaabb3ea396fcb5a9b08af59c07067de7`。

| 行为                     | 历史实际观察                                                                                                              | 适用边界                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 创建、双击、确认回执未知 | 真实模型生成提醒 A，完整冻结审阅；双击确认，后端 200 后丢响应。显示未知结果，没有自动继续                                 | 隔离正式 Web/API/native/PG，非合成 consumed 响应 |
| 未知先读、恢复失败       | 明确核对 GET 读到 consumed；首次 resume 请求被阻断，再 Enter 重试至原 Run done，无第二次 confirm；冻结 snapshot/hash 不变 | 网络故障注入，不冒充后端恢复故障                 |
| 取消、375px 与键盘       | 真实取消提议经 Tab/Enter 确认；原 Run done，同 task 最终 cancelled；页面宽度 375px、焦点可见                              | 没有声称移动软键盘或屏幕阅读器验收               |
| 停止/切换期间迟到确认    | 暂扣真实 confirm 200，分别停止原 Run、切换历史；每分支一次 confirm，resume 均零；停止分支一次 cancel                      | 不等于撤销已经创建的提醒                         |
| 刷新、历史、重登         | 已消费等待点刷新、正式退出/登录返回均零业务 POST，仍需明确继续                                                            | 不计合法认证请求                                 |
| business 入口            | 真实 business SSE 为 done，无就地按钮，独立批准页链接存在                                                                 | 不伪造 business 挂起 checkpoint                  |

最终集成提交 `e1f2448908fbabb2919ec874a394f8bd6d14f07d` 的[CI 41408519245](https://github.com/BqLee-AI/Along-agent/actions/runs/41408519245) 五门全部成功。历史记录核对七个 Web 源码/测试文件与首次 UI 版本逐字节一致；新的后端组合由最终 CI 的正式消费者/Compose 补证，不声称首次 UI 使用了之后合并的后端。合并后的代码树相同这一结论来自历史验收记录。

本地历史检查是分段结果：两 Web 文件 15 pass、0 fail、97 assertions；随后补 superseded 后继负例的定向结果为 1 pass、7 filtered、10 assertions。全仓类型、lint 和格式通过。不是 TDD，最初缺少构建包的导入错误不算行为 Red。

## 本次执行记录

先查阅 issue、#99、CONTRIBUTING、OpenSpec 流程及现有 spec，补齐收口计划和索引后才启动补验准备。发现 checkout 缺 `pg`/`zod` 依赖导致生命周期入口报 `PREPARATION_REQUIRED`；通过冻结锁文件安装补齐，未改生命周期代码或私有配置绕过前置。

### 当前版本真实安装

- 使用正式 `local:upgrade` 升级原专用验收安装，未接管用户原安装。冻结源码摘要为 `3ad3bc27c128181790ff0c986b00cdf785d9cc3cbdbffbfb64021fcfcb87a954`；API/native 镜像摘要为 `sha256:13061750a9d6b1cd1e41e391271e74d412f600e20b57e8c070dcd50f454094ca`。
- 对照当前 checkout 与冻结构建，五个相关 Web 运行文件、工具 catalog、conversation service、工具 gateway、native main 共九个文件逐字节一致。正式生产 Web、Linux API/native/MCP 和 PG16 共同运行，不是 dev server 或伪造状态样本。
- 在该安装受管卷中新建 `notes.md` 合成资料，经正式 `maintainAccount` 公共入口登记单文件读写范围；只注入维护问答，不替换数据库、登记校验或重载实现。账户、配置、模型连接与文件保存在仓库外。

### 提醒之后的文档仍需独立授权

1. 在真实 Web 选择有限资料范围，明确要求先提出单条 2027 年提醒，再于提醒确认恢复后提出文件修改。真实模型/native 生成提醒等待点，attempt 为 1。
2. 对话内完整审阅并明确确认提醒，仅一次提醒 confirm 和一次原 Run resume；同一 Run 到达新的文档 checkpoint，attempt 为 2。提醒 consumed 且指向真实 task，文档仍为 `pending / not_started`，就地提醒按钮为零，没有 document confirm 或第二次 resume。
3. 打开 375px 独立文档校样页，完整 before/after、目标正文和冻结批准正文可读，页面宽度为 375px。仅浏览、刷新、正式退出/登录后重新打开原 Run，零业务 POST；退出入口返回首页后显式打开原深链，不冒称退出页自动保留返回目标。前后 15 张业务表的行数/完整排序行 SHA-256 及文件 SHA-256 全部一致。
4. 在独立文档页用键盘 Enter 明确批准，只有一次 document confirm。文档为 `approved / not_started`，Run 仍 suspended、attempt 2、checkpoint 未变、can_resume=true；文件摘要仍为完整基线 `9464591ebfb7d3356c6f5896963ec0cf68b87026c7444d148ec5b393b2dfa621`。
5. 返回原 Run 只读刷新资格，再明确点击继续。仅一次原 Run resume，最终同一 Run done、attempt 3；文档效果为 `verified`，具有不同的 apply 与其后新 read invocation 引用。实际文件摘要等于冻结目标 `7bf67f7588807eb359199326da4c4ada96509678b149ece06da4ade4890ada88`，不是只相信助手文字。

### 并发修订不使旧动作授权后继

1. 通过真实模型/native 另建提醒等待点，完整审阅原冻结内容。浏览器仅暂缓旧 confirm 的实际发送，保留原生产请求内容；同账户经正式 revise API 提交新的完整时间/原话，200 回执产生真实后继。
2. 修订提交后释放旧 confirm，后端返回 `409 APPROVAL_SUPERSEDED`。没有 resume，也没有 confirm 后继；界面保留原冻结内容并报告领域错误。
3. 明确点击原动作的同键核对，只 GET 原事实，无新增 POST；刷新批准后旧项为 superseded、无就地按钮，可沿真实后继链接查看完整新冻结正文。后继仍 pending、task_id 为 null。
4. 原 Run 保持 suspended、attempt 1、原 checkpoint 未变。此时服务端 can_resume=true 并不表示原提议仍 pending；客户端没有自动调用 resume，更没有跟随后继批准。新提议仍需独立审阅与明确授权。
5. 375px 查看旧冻结正文及独立后继页，无横向越界。后继预览、刷新旧等待点、打开并刷新已完成文档 Run、历史返回，均无业务 POST。前后 19 张业务表（上述执行/批准事实及 tasks、task_events、outbox、notifications）与文件摘要全部相同。

第一次尝试使用浏览器 raw request interception 暂扣请求时，工具未按预期保持请求，原确认先成功并恢复，不能作为修订获胜证据；已记录工具问题。该合成提醒保留于隔离库，不删除事实。正式有效并发结果来自后一次生产 fetch 发送前屏障与真实 revise 提交，不伪造确认或决议响应，也没有改产品代码迁就夹具。

### 保证边界与收尾

- 本次补齐 #99 明确缺失的真实文档、后继并发和对应只读边界；未发现需改动运行代码的缺陷。复用不受影响的历史双击、未知回执、取消、停止/切换和 business 入口证据，不宣称本次逐项重跑。
- 不把网络故障注入称为真实后端故障；不承诺通知必达，不扩展免批准、日期锚、自然 shadow/enforce、原安装升级或 #66 全路径验收。
- `bun --no-env-file run verify` 十步全部通过：unit 639 pass、7 skip、0 fail、2740 assertions、61 文件；OpenSpec strict 10 pass、0 fail，679 文件格式检查通过。保留既有 lint warning，未为文档收口改运行代码或测试。最后仅补入本条结果记录，不改变受测代码。
- `openspec archive confirm-reminders-inline --yes` 成功，将三项增量要求写入 conversations 主规格并归档。执行时唯一未勾项是包含归档动作本身的 3.3，随后按成功结果更新；未跳过行为验收或使用 `--no-validate`。
- 新增及归档文档的本地链接均可解析。契约、PG/调度及 Compose 门由独立收口 PR 的同提交 CI 执行，不把历史 CI 当成本次结果；合并及 issue 关闭以 GitHub 结果为准。
- 补验使用沿用的 `deepseek-v4.1-flash`，未更换模型或连接；桌面 1440px、文档/后继页与终态历史 375px 实测。专用安装已通过正式 `local:stop` 停止，数据卷/合成事实保留；两个验证标签及临时脚本已清理。
