## 1. 合同设计

- [x] 1.1 整合 docs/design/14 §1–§11，明确 Observed/Proposed/未验证，确定受管 workspace 与官方 SDK 薄只读 Server 方案。
- [x] 1.2 同步 design/02 模块所有权、04 invocation、06 文档授权、09/11 typed bootstrap/unknown、13 D8 证据边界及 API/schema 引用真源。
- [x] 1.3 同步 PRD 与文档索引；新增 workspaces delta，修改 agent-runtime/tool-gateway，不复制完整 design.md。
- [x] 1.4 完成独立方案审查、本地严格 OpenSpec、文档及仓库验证；PR 如实记录 CI，保留五门全成功的合并要求。Refs #62；不勾实现/真实验收/archive。

## 2. 可信 workspace 与只读工具

- [x] 2.1 落地受管登记、root/路径/链接/权限与冻结授权；全量登记跨实例一致，拒绝相同身份/相同或嵌套 root 进入不同互斥域，不新增任意路径 API。
- [x] 2.2 落地 GET workspaces、消息 workspace 选择/hash/Run 冻结与安全查询；保留 business/旧请求/GET 补读合同。
- [x] 2.3 先做 SDK/Bun/stdio/生产打包最小真实实验，再锁定发布版本与许可；实现实际只读 TS MCP Server 及 gateway Client，无直接读 fallback。
- [x] 2.4 实现有界真实 list/字面量 grep/全文 read、版本/失败观察；read_only 走短事务检查→事务外 MCP→短事务首次接受，取消不等 IO，接受后重交不重复读取。

## 3. 文档批准与唯一写动作

- [x] 3.1 新增 document 批准/决议迁移及约束；精确基线、完整目标/预览/hash；仅可信零写 conflict 允许不可变唯一 replaces 前驱，旧 task 规则不变。
- [x] 3.2 同事务接受本地文档提议与审计；实现批准后唯一 apply_invocation_id 绑定及 coordinator dispatch 校验，拒绝新 slot 绕过。
- [x] 3.3 实现受控锁下的基线核验、临时文件/fsync/rename/父目录 fsync/实际回读、确定 conflict 和 unknown；不假称 PG savepoint 回滚文件。
- [x] 3.4 实现新 read 与 done 守卫：真实 applied/回读或明确零写 conflict 的成功批准后继；unknown/未尝试不能被替代，不把相同 hash 当回执。

## 4. native/Run/Web 贯通

- [x] 4.1 全量切换 harness/v2 及所有 TS/native/wire 消费者；typed task/document 决议，旧历史快照只读兼容、不增历史授权。
- [x] 4.2 文档批准同 Run snapshot/suspend/显式 resume/唯一新 attempt；早确认、拒绝、重复/丢回答与取消竞争。
- [x] 4.3 unknown 直接 TOOL_EFFECT_UNKNOWN 正常失败，无 unknown 可恢复 checkpoint；可恢复读失败/冲突观察真正进入后续模型请求。
- [x] 4.4 简短计划可见并随观察变化、预算跨 resume 累计；参考任务预算由真实轮数校准，不开放用户自报预算/provider。
- [x] 4.5 Web workspace 选择、完整冻结预览/按钮、原会话等待/继续、实际产物/未知展示；不伪造 task 卡片、不新增事件词。
- [x] 4.6 生产镜像打包 MCP Server，部署登记/持久文件、模型稳定配置及不可用说明；不写 .env，不混跑旧 writer。

## 5. 验收（D 项与既有 A 项回归）

- [x] 5.1 D1/D8：真实 owner/CSRF/Run/路径边界、symlink/相邻前缀目录/硬链接/跨 owner/旧 attempt 均拒绝；核查 SQL 所有权，不以静态绿色替代。
- [x] 5.2 D6/D8/D10：原 read→精确批准→唯一 apply→新 read 闭环；审批丢回答/不同 invocation/版本冲突/无关内容/确定未写/unknown 各有真实结果断言。
- [x] 5.3 D8：原根 test:contracts 的本地公共用例/签名 HTTP 新产品消费者实际经过正式 native、PG、SDK Client/TS Server、真实文件；报告唯一通过，必要边界省略会变红，保留 #47 原15消费者。
- [x] 5.4 D8/D9/D10：小预算与取消先提交不产生新动作，许可先提交保留已知/未知效果；unknown 正常失败且重交不增加实际写，文件恰好相同也不伪造回执。
- [x] 5.5 D8/D10：真实 Web＋获授权真模型执行参考任务及位置/冲突日期/读失败变体；展示短计划和选择变化，实际文档回读/未改区段核验；受控模型不冒充此证据。
- [ ] 5.6 D2–D7、D9/D10及 A1–A4：既有冻结展示/time-core/重复 task 确认/只追加/唯一约束/到点取消回执/旧恢复/空环境与五门不回归；R1 检查不能改写 A1–A4 原定义或宣称未跑项通过。
- [x] 5.7 D6/D8/D9：真实 MCP 等待期间 cancel 先提交；同引用不同源版本只首接受；确定冲突 A→新批准 B→写入/新读可成功，B 未决/拒绝/未执行/unknown 不能完成，A unknown/未尝试不可被覆盖，并发后继唯一。

## 6. 收口

- [x] 6.1 汇总真实运行/Red-Green或变异证据、已证明范围与未证明项；Parent 统一验证并独立审查，按本次结果更新 D8 精确范围。
- [ ] 6.2 所有 R1 用户标准完成后 archive define-r1-document-task-loop、同步主 spec/PRD/索引；收口 PR Closes #62，确认实际合并/归档/issue 状态，不预写完成。

## 验证记录（PR #64 并发夹具）

- 远端 CI `40334694912` 的 migration-scan 在“工具先提交、取消后拒绝迟到回答”用例失败：工具回答已成功返回，测试却要求它必定晚于取消提交。原 PostgreSQL 屏障只证明取消请求正在等锁，不保证工具回答与取消提交的先后顺序。
- 修正仅涉及测试同步：真实工具照常提交，在网关返回边界暂停回答；取消事务提交后才释放回答。保留迟到回答拒绝、原批准与调用记录存续、仅有取消事件的全部断言，不改生产取消规则。
- 修正后以 Bun 1.4.2、PostgreSQL 16 和当前生产镜像执行完整 harness-authority 文件，28 项通过、215 次断言；根 typecheck 与 format:check 通过。本地结果不替代最终 PR HEAD 的五门，5.6 仍须由实际远端结果收口。
