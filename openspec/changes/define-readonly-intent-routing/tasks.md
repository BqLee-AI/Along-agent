# #88 实施与验收任务

勾选只表示该项实际完成；唯一详细设计为 [design/19](../../../docs/design/19-r2b-readonly-intent-routing.md)。正式合同通过独立 spec-only PR 交付：独立 reviewer 无阻断意见后可以提交、推送并创建 PR，既有五项必需 CI 全部通过后再 squash 合并，使用 Refs #88。规范合并不授权业务实现、目标宿主实验、部署、自然流量、原安装升级或 archive/关闭 #88；后续范围需另行授权。文档校验、离线合成、正式消费者、真实 Web、自然 shadow 与发布分别取证，不互相替代。

## 1. 正式合同（本轮）

- [x] 1.1 核对 #88、现有 agent-runtime/tool-gateway/conversations 与 R2-A 归档惯例，确认三只读白名单、唯一 native、旧 Run/off/恢复、v5/snapshot2 和证据边界；识别需要完整 MODIFIED 的连续会话场景。
- [x] 1.2 编写正式 design19、PRD/索引、脱敏实验入口及本 change 的 proposal/design/tasks/三能力 delta；只写 Proposed 行为，不将离线或静态审阅记作服务验收。
- [x] 1.3 由主线程执行 `openspec validate define-readonly-intent-routing --strict` 与相关文档引用核对，记录实际结果后勾选；不运行构建、测试或应用。
- [ ] 1.4 用户审阅合同并另行授权后续实现、目标宿主最小实验和相应数据使用；未授权前以下全部保持未勾选，设计通过不等于部署/自然流量授权。

## 2. 目标部署最小实验（编码服务负责人，后续）

- [ ] 2.1 在独立目标 Linux CPU 环境验证固定 BGEINT8 资产与 ORT/tokenizer 路径、双端原句/CLS/归一化和 token 精确计数；验证 design19 §5 HTTP 合同、同批输入/输出绑定、边界256/257、禁截断、非有限/零/错维/错 binding 拒绝，不下载或切换请求指定资产。
- [ ] 2.2 实测正式 HTTP 服务冷/热启动、并发与 API/PG 共存 CPU/RSS/峰值、完整路由和端到端延迟、取消释放、deadline/满载/无重试；锁定实际 Linux 镜像 digest、版本与资源证据。不把 Windows 离线 batch1 代为服务验收，Proposed 预算失败则保持 off。

## 3. 新 bundle、校准与独立评估（路由资产负责人，后续）

- [ ] 3.1 以完整目标、可靠参数和能力/输出边界标注新材料，按故事/来源/改写族/对比关系连通分组，独立审阅争议；保留所有竞争目标、四族/top2、排除 veto 与两个独立阈值的冻结算法，不用白名单第二名补位。
- [ ] 3.2 将原92与已暴露两轮 test 全部作为回归；保留 BGEINT8 时区误派提醒、Dmeta 漏掉追加写目标的不同来源，以及过去添加/动词“到”/否定更长列表/场景时间共同误挡。修通用规则，不改单句 gold、不删失败、不设逐句白名单。
- [ ] 3.3 新分组 calibration 搜索并完整保存候选，冻结资产/规则/parser/handler/renderer/阈值和预算 binding，再用新未见留出评估；变更后生成新 bundle，旧 test 降为回归。E5 仅独立离线对照，不复用阈值或在线切换。
- [ ] 3.4 按意图/风险族报告误接、误拒识、全目标/参数/来源/输出正确性、真实 L1 miss 增量与不确定性；不把合成非盲零错当自然保证，不把299统计示例当开发前置或自动发布许可。

## 4. 默认 off 的实现与迁移（TS/native 集成负责人，后续）

- [ ] 4.1 同批切换 shared contracts/TS/native/消费者至 v5；保留 snapshot2、原流式/预算/批准恢复和公开七词，落实 facts/embedding probe、唯一 decision、受控 renderer 来源；收紧首次模型前任意 answer 宽口，不伪造 provider 调用或 usage。
- [ ] 4.2 新迁移扩充0015封闭 checkpoint kind，加入 routing policy/decision/render 的首 attempt、同 kind 唯一及 owner/来源关联约束，复用只追加保护与外部过滤；不改旧迁移、不新增路由表/Run JSON、不动 frozen_context。覆盖事务回滚、并发、历史兼容与旧 Run 不补 routing policy。
- [ ] 4.3 实现首步完整目标/上下文/参数来源与全竞争判断，原网关唯一目标/参数绑定、真实 accepted_result＋snapshot、纯 renderer 与 delta/render 同事务；direct 后 reserve/invoke/render 的任何失败不切 LLM/换 slot，finish 依真实成功、render 和零模型资格。
- [ ] 4.4 实现锁外单次编码、前后资格检查与 abort/取消释放；off 无编码依赖，shadow 零旁路工具且原模型答复，拒识完整回 LLM；协议/事实/权限/DB 错误不伪拒识，核心依赖错误保留原类型化失败，core readyz 不降级。

## 5. 正式消费者与真实 Web（端到端负责人，后续）

- [ ] 5.1 D1/D6/D8：正式 native＋PG 经原本地公共用例/签名 HTTP 双入口，验证首 attempt 唯一策略/决议、真实唯一只读调用与 snapshot/render、owner/参数来源、旧 Run/重放/恢复零分类；必要步骤单项省略须令同一根消费者因行为错误变红，不用静态声明替代。
- [ ] 5.2 D8/D9/D10：覆盖完整多目标/否定/承接/不支持参数回原 LLM，shadow 零旁路，编码超时/满载/不兼容和 direct 前后失败分界，取消竞态/迟到候选/迟到展示、socket丢失与崩溃不补执行；真实计数不得因换 slot 或 fallback 翻倍。
- [ ] 5.3 D1/D6/D8/D10：覆盖来源伪造/损坏、provider 任意正文拒绝、错误绑定/版本、delta/render 原子失败、render后重放不重查、只读为空/部分/上限/时区null，以及任务状态不承诺必达、简报不宣称查全或重新生成。
- [ ] 5.4 在独立正式安装由真实 Web 建号/登录、显式普通 Harness 发送，经本次构建 native→原 TS gateway→PG，分别验证三只读 direct 和 fallback；刷新/历史/同键重放/显式批准继续不路由。fallback 用既有真实 provider/model，不以受控响应、seed session 或 HTTP200 代替真实 Web 证据，不升级原安装。

## 6. 自然 shadow、受控启用与收口（发布负责人，后续另行授权）

- [ ] 6.1 获自然流量实验授权后运行零旁路 shadow，逐条审阅全部拟接管候选，按意图报告真实 L1 miss 非零增量、全链误接、拒识增量尾延迟、实际请求数/可得usage及共存成本；shadow 不报真实省费，缺费用依据如实 unknown。
- [ ] 6.2 逐意图确认无已知实质误接、目标宿主/消费者/真实 Web 边界通过、保守净收益为正和立即停用手段后另行获限量授权；顺序为时区/提醒/单日简报，5%仅提议上限，单租户可明确小批，不自动放量。未过门不得 enforce，可继续 shadow 或保留 L1＋L3/L2off；严重误接立即停受影响意图并保留原版本与事实。
- [ ] 6.3 D1/D6/D8/D9/D10 对应行为变红/恢复证据与既有五门全部有效；保留 A1–A4 原保证，不因只读优化缩小旧消费者。记录实际 Verification、未跑项、版本/迁移/停用边界与证据等级。
- [ ] 6.4 全部验收及授权齐备后执行 `openspec archive define-readonly-intent-routing`，不跳过 delta 合并/严格校验，同步设计/PRD/索引并核对归档相对引用；仅收口交付可 Closes #88，不把本轮文档完成记为实现/上线/归档完成。

## Verification：正式合同编写时记录（2026-10-31）

- 编写时状态：`docs/88-spec-readonly-intent-routing` 的文档工作树；当时仅完成 Proposed 设计与 active change，未修改业务实现或主 spec，未归档、commit/push/开 PR。这是初稿交付时的历史记录，不限制后续获授权的独立规范 PR；1.4 及全部实现/服务/自然验证任务仍未勾选。
- 策略：纯文档不适用运行时 TDD；通过现有 OpenSpec CLI、格式入口与一次性内容检查验证可读取的规范，不将它们当成真实应用行为证据。
- `openspec validate define-readonly-intent-routing --strict`：输出 `Change 'define-readonly-intent-routing' is valid`，退出0。三能力 delta 共14项 Requirement、50个 Scenario，每项2–4个场景；仅完整MODIFIED连续会话中实际模型输入的前提，保持63＋1冻结和原其余场景。
- 14份相关Markdown的190个本地引用及20个标题锚点全部存在，错误0；临时检查结果存任务独立归档，不新增永久测试或检查脚本。`bun run format:check` 输出全部匹配文件格式正确（640 files）。
- 未运行构建、lint、单元/契约/数据库测试、服务/模型或真实业务调用：本轮无应用行为实现，不能报告其Red/Green、Web闭环或部署通过。既有候选实验仅作为带日期的历史证据引用。
- Lorelum语义检索返回`embedding.failed`，未取得可引用Practice；未以空结果或关键词检索冒充语义实践，也未为规范写作更改其模型/缓存配置。
