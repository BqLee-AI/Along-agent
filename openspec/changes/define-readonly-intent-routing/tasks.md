# #88 实施与验收任务

勾选只表示该项实际完成；唯一详细设计为 [design/19](../../../docs/design/19-r2b-readonly-intent-routing.md)。正式合同经PR #89交付并合并；用户另行授权默认off实现、隔离Linux实验、合成数据验证与独立真实Web验收，随后授权独立安装shadow供真实自用。授权不包括原安装升级、生产enforce、registry发布或archive/关闭#88。文档校验、合成质量、正式消费者、真实Web、自然shadow与发布分别取证，不互相替代。

本轮交付为默认 `off` 的有限只读路由实施 PR，使用 `Refs #88`，不是完整上线或最终收口 PR。实施、迁移、来源/展示保护、正式消费者与真实 Web 按受影响范围提供有效证据；自然 shadow、逐意图受控接管和最终 archive 保留独立验收及授权，不要求第 6 节全部完成才可交付实施 PR，也不能以实施交付替它们勾选。原安装不升级，不启用 enforce、不自动重启 shadow、不发布、不归档或关闭 issue。

## 1. 正式合同与实现授权

- [x] 1.1 核对 #88、现有 agent-runtime/tool-gateway/conversations 与 R2-A 归档惯例，确认三只读白名单、唯一 native、旧 Run/off/恢复、v5/snapshot2 和证据边界；识别需要完整 MODIFIED 的连续会话场景。
- [x] 1.2 编写正式 design19、PRD/索引、脱敏实验入口及本 change 的 proposal/design/tasks/三能力 delta；只写 Proposed 行为，不将离线或静态审阅记作服务验收。
- [x] 1.3 由主线程执行 `openspec validate define-readonly-intent-routing --strict` 与相关文档引用核对，记录实际结果后勾选；不运行构建、测试或应用。
- [x] 1.4 用户在规范合并后另行授权默认关闭实现、目标Linux隔离实验、既有及新合成材料验证、独立安装真实Web；不授权原安装升级、自然流量、发布或归档，后续验收只按实际证据勾选。
- [x] 1.5 用户在下一轮另行授权补齐模型许可材料、以最终源码升级独立安装并复验、开启独立安装shadow供真实自用及私密人工审阅；只启动观察窗口，不把受控请求当自然样本，不自动启用或发布。

## 2. 目标部署最小实验（编码服务负责人）

- [x] 2.1 在独立目标 Linux CPU 环境验证固定 BGEINT8 资产与 ORT/tokenizer 路径、双端原句/CLS/归一化和 token 精确计数；验证 design19 §5 HTTP 合同、同批输入/输出绑定、边界256/257、禁截断、非有限/零/错维/错 binding 拒绝，不下载或切换请求指定资产。
- [x] 2.2 实测正式 HTTP 服务冷/热启动、并发与 API/PG 共存 CPU/RSS/峰值、完整路由和端到端延迟、取消释放、deadline/满载/无重试；锁定实际 Linux 镜像身份、版本与资源证据。不把 Windows 离线 batch1 代为服务验收；本地 image ID 不冒称 registry digest，预算不是 SLA。
  - 真实Linux服务：256/257分别成功/零forward拒绝；三个参考case的token与512维向量逐项相同，12请求高水位2，断连后真实CPU结束才释放容量。容器就绪4837.25ms，60次热HTTP p50/p95=16.63/31.38ms，峰值189976576bytes；不是冷宿主页缓存或代表性负载结论。本地镜像身份已在外部受控证据锁定，无RepoDigest，不公开机器产物digest。
  - 六条本地/签名HTTP真实L2的完整调用加同键重放为299.74–359.09ms，每条一次编码、一次原网关只读、零provider。独立真实Web同宿主共存观测：API RSS109940736bytes、cgroup峰值93986816bytes、累计CPU17.431943s；同一PG cgroup峰值110428160bytes、累计CPU62.436784s；编码器峰值189976576bytes、累计CPU109.177208266s。采样不同时，RSS不等于cgroup，累计CPU不是瞬时占用；外部证据私密保留，不据此承诺容量或SLA。

## 3. 新 bundle、校准与独立评估（路由资产负责人）

- [x] 3.1 以完整目标、可靠参数和能力/输出边界标注新材料，按故事/来源/改写族/对比关系连通分组，独立审阅争议；保留所有竞争目标、四族/top2、排除 veto 与两个独立阈值的冻结算法，不用白名单第二名补位。
- [x] 3.2 将原92与已暴露两轮 test 全部作为回归；保留 BGEINT8 时区误派提醒、Dmeta 漏掉追加写目标的不同来源，以及过去添加/动词“到”/否定更长列表/场景时间共同误挡。修通用规则，不改单句 gold、不删失败、不设逐句白名单。
- [x] 3.3 新分组 calibration 搜索并完整保存候选，冻结资产/规则/parser/handler/renderer/阈值和预算 binding，再用新未见留出评估；变更后生成新 bundle，旧 test 降为回归。E5 仅独立离线对照，不复用阈值或在线切换。
- [x] 3.4 按意图/风险族报告误接、误拒识、全目标/参数/来源/输出正确性、真实 L1 miss 增量与不确定性；不把合成非盲零错当自然保证，不把299统计示例当开发前置或自动发布许可。

## 4. 默认 off 的实现与迁移（TS/native 集成负责人）

- [x] 4.1 同批切换 shared contracts/TS/native/消费者至 v5；保留 snapshot2、原流式/预算/批准恢复和公开七词，落实 facts/embedding probe、唯一 decision、受控 renderer 来源；收紧首次模型前任意 answer 宽口，不伪造 provider 调用或 usage。
- [x] 4.2 新迁移扩充0015封闭 checkpoint kind，加入 routing policy/decision/render 的首 attempt、同 kind 唯一及 owner/来源关联约束，复用只追加保护与外部过滤；不改旧迁移、不新增路由表/Run JSON、不动 frozen_context。覆盖事务回滚、并发、历史兼容与旧 Run 不补 routing policy。
- [x] 4.3 实现首步完整目标/上下文/参数来源与全竞争判断，原网关唯一目标/参数绑定、真实 accepted_result＋snapshot、纯 renderer 与 delta/render 同事务；direct 后 reserve/invoke/render 的任何失败不切 LLM/换 slot，finish 依真实成功、render 和零模型资格。
- [x] 4.4 实现锁外单次编码、前后资格检查与 abort/取消释放；off 无编码依赖，shadow 零旁路工具且原模型答复，拒识完整回 LLM；协议/事实/权限/DB 错误不伪拒识，核心依赖错误保留原类型化失败，core readyz 不降级。

## 5. 正式消费者与真实 Web（端到端负责人）

- [x] 5.1 D1/D6/D8：正式 native＋PG 经原本地公共用例/签名 HTTP 双入口，验证首 attempt 唯一策略/决议、真实唯一只读调用与 snapshot/render、owner/参数来源、旧 Run/重放/恢复零分类；必要步骤单项省略须令同一根消费者因行为错误变红，不用静态声明替代。
- [x] 5.2 D8/D9/D10：覆盖完整多目标/否定/承接/不支持参数回原 LLM，shadow 零旁路，编码超时/满载/不兼容和 direct 前后失败分界，取消竞态/迟到候选/迟到展示、socket丢失与崩溃不补执行；真实计数不得因换 slot 或 fallback 翻倍。
- [x] 5.3 D1/D6/D8/D10：覆盖来源伪造/损坏、provider 任意正文拒绝、错误绑定/版本、delta/render 原子失败、render后重放不重查、只读为空/部分/上限/时区null，以及任务状态不承诺必达、简报不宣称查全或重新生成。
- [x] 5.4 在独立正式安装由真实 Web 建号/登录、显式普通 Harness 发送，经本次构建 native→原 TS gateway→PG，分别验证三只读 direct 和 fallback；刷新/历史/同键重放/显式批准继续不路由。fallback 用既有真实 provider/model，不以受控响应、seed session 或 HTTP200 代替真实 Web 证据，不升级原安装。首轮镜像版本边界及下一轮最终代码复验分别见下文。

## 6. 自然 shadow、受控启用与收口（发布负责人）

本节区分实施验收汇总（6.3）与后续自然观察（6.1）、受控启用（6.2）、最终归档（6.4），不作为实施 PR 必须整体完成的清单。自然质量与收益未过门时允许专项暂停；暂停不等于验收通过。6.3 由主 Agent 按最终源码/原生产物与消费者、既有门禁的有效证据决定，不能沿用旧产物结果自动勾选。

- [ ] 6.1 在已授权的独立安装运行零旁路shadow，逐条审阅真实自用中的全部拟接管候选，按意图报告真实 L1 miss 非零增量、全链误接、拒识增量尾延迟、实际请求数/可得usage及共存成本；shadow 不报真实省费，缺费用依据如实 unknown。开启观察不代表完成自然验收。
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

## Verification：默认关闭实现分段记录（2026-10-31—2026-11-01）

- 实现分支`feat/88-readonly-intent-routing`基于规范合并后的`62b5abc`；源码、受控行为和真实用户路径分别记录，未部署原安装。
- TS/API/Web实际`bun run typecheck`与`bun run build`退出0；guard5统一`bun run verify`十步全部通过。guard4完整`test:unit`为474pass/2skip/0fail、2338断言。guard5正文/历史要求用例先7pass/2fail→两文件21pass；guard6标记筛选/共享出站用例先9pass/2fail→两文件23pass/0fail、124断言；不把目标用例Green替代最终全套。
- 0020使用PG16实测0019显式升级、canary保留、禁止DDL后的重复只读重启，以及删除索引/禁用trigger/删除CHECK时拒绝未知基线；仅放行精确0020迁移名，0019/0021同名和0020非批准名仍拒绝。首次模型前任意answer缺口在隔离基线真实Red，权威层两个集成文件修后22pass/99断言。
- 第一版质量为新留出39/72正确、0误接，378回归147/226正确、3实质误接；guard2新留出52/72正确、2误接，468回归0误接；guard3新留出46/72正确、0误接，558回归0误接；guard4新留出47/72正确、2误接，648回归0误接；guard5新留出46/72正确、2误接，738回归0误接。每轮旧留出降回归，原报告/失败/gold/资产保存在仓库外，不改不重跑，不能挑最好轮作自然安全声明。
- guard6重新校准90条，118条index与67条可编码cal全部真实HTTP成功、无重试，59正确/0误接/13误拒；bundle为`8ca0f4474ec30cbd9f8ff2f58e8e1799a7f26eb6ddee068c4733648bdc1b9020`，全候选搜索阈值同旧，不复用旧bundle。冻结后的第六新90为48/72正确、0误接、24误拒，三意图15/9/24；828回归为371/586正确、0误接、215误拒，三意图145/87/139。真实HTTP各67/67与550/550；受控材料L1 miss正确增量48与365，不能计作真实工具执行或已省请求/费用。
- guard6完整918候选与goal/args/source审阅保留在`r2b-guard6-evaluation-classifications.json`，SHA`fefce1f598831494d101ba4ad051530aecc364a1ce0c251293fdd6c793cf8cbb`；`r2b-guard6-quality-report.json` SHA`e50f6ecdd21de9c2f39bff789c064191792b20b0f48e0b37a4d8d5482a155693`。这是五轮已暴露结果后同作者生成的第六组合成材料，每意图6族×4相关句不等于24个独立自然样本，仍`KEEP_OFF`，不声称自然/统计安全或净收益。
- 编码服务binding为`3c530946a7e1bfbd53f5f9e027fd36d9cd5d58247e282d7b4fe770e3d9782868`。量化发行许可为`not_declared`、生产分发未清算；依赖/镜像来源及启动破坏实验保存在独立外部证据。默认off，不自动启用或发布资产。
- 完整Windows集成遭Bun1.4.2 worker原生崩溃并超时，保留失败日志；非法取消入参不写入断言改为请求前后完整事实不变，不假定新Run尚无合法off策略记录。相同只读源码/包/测试/迁移在既有Linux运行时实测318pass；另15项因旧v4产物失败，该历史结果不改写为全套通过。
- 官方SDK1.0.5/stdx1.0.5.1在WSL实际编译本次Cangjie源码，本地/签名HTTP六条L1与既有native行为共22pass。随后正式`build:harness` Docker构建退出0，四项源码/依赖锁字节指纹经独立哈希器全部吻合，产物指纹留在外部受控证据。该正式产物补验16项native集成以及真实Linux编码器→native→原网关→PG/SSE链，共26pass/239断言：六条三意图本地/HTTP L2 direct、off/影子/共享拒识原路径、编码迟到取消；direct真实provider调用0、唯一原始slot，无伪造usage，历史/同键重放不重查。另补真实编码拒识和禁用胜者不可候补晋升2pass/8断言。原路径使用明确受控provider，不冒称真实模型或Web证据。
- 既有私有origin检查错误接受`127.example.com`等公网域名前缀：实际Red后改为先确认真正IPv4，再判断私网范围，9项客户端边界Green；真实私网HTTP冒烟得到512维、11token、14.45ms，四种伪私网域名均拒绝。此修改仅修正配置URL分类，不改变语义guard/parser/handler/renderer或编码资产。
- 正式原生产物来源、真实编码链、拒识/意图子集与共存观测保留外部受控证据；不公开本机目录或机器产物digest。单次低负载冒烟不等于代表性吞吐、自然净收益或SLA。

## Verification：最终集成与独立真实Web（2026-11-01）

- 必需记录省略回归：真实PG用owner定向trigger吞掉policy/decision/snapshot/render插入，本地/HTTP共8例。修前4pass/4fail，暴露两入口缺policy仍调用provider、缺render仍泄露文本；`appendRoutingRecord`要求实际插入一行后8pass/0fail、38断言。decision/snapshot省略原已闭合。原始Red与Green分别保存在`check-routing-persistence-red-1793464430978`、`check-routing-persistence-green-1793464512464`，不把其他环境失败冒充TDD Red。
- 最终正式Docker D8消费者139pass，37个必需consumer ID全部执行；包括三只读本地/HTTP、八项记录省略及既有消费者，未削弱ID校验。记录为`check-contracts-persistence-fix-37-consumers-1793465086988`。两份独立源码审阅无新增发现，范围与非运行时性质见`r2b-independent-review.json`。
- 统一verify十步通过，单元478pass/2skip/0fail、2354断言，严格OpenSpec九项通过；见`verify-final-persistence-fix`记录。此前失效DB连接的四项`ECONNRESET`保留，发布专用PG端口后生命周期四例4pass/26断言。后续仅根测试预算和文档变化，复用未受影响验证，另补入口元数据及文档门禁。
- 完整Linux集成保留默认5秒下的326pass/7fail、正式镜像286pass/21fail与新PG322pass/5fail，均为测试/钩子超时。四并行真实迁移夹具的初始化加清理约3.9秒，0020仅35.02–49.61ms；根`test:integration`/`test:scheduler`改为与D8一致的30秒测试预算，不改应用deadline或行为断言。最新生产Docker镜像内运行原根入口：333pass/0fail、3583断言、36文件，148.90秒；见`check-integration-current-root-fixture-budget-1793466797243`。临时镜像已移除。
- 独立正式安装通过真实Web建号、退出/登录、普通Harness选择和表单发送；原DeepSeek真实fallback成功。三类只读L2全部done、原`harness/1`唯一成功调用、完整policy/decision/snapshot/render，可信usage均0迭代/0token。该独立Web镜像早于最终IPv4与INSERT行数修复；两修复由最终工作树的真实HTTP及正式双消费者另证，不冒称该Web镜像包含它们，镜像身份仅保留在外部证据。
- 真实Web刷新、旧off/direct历史及同键原POST重放，14张owner业务表的完整行数与SHA256均不变、零新增编码。2035提醒超fixture覆盖返回原`TZDB_UNAVAILABLE`503；改用覆盖内2027日期后，实际按钮批准只保持suspended，显式“继续此运行”才完成第二attempt，仍仅一份policy/decision、零重新编码。测试提醒随后通过真实任务页取消，重载确认已取消及撤销回执，未删除业务记录。另一次真实“停止回复”得到cancelled和唯一终态，无迟到文本。
- 独立Web shadow真实编码一次、原模型两迭代/2491token、原只读调用，决议SHADOW且无render旁路。随后恢复off并停止编码容器，新的同措辞请求仍由原模型完成，两迭代/2558token、仅off策略；旧direct同键重放解析出`thread.started`/`message.delta`/`thread.completed`，再读旧direct与原off历史，14张完整事实表仍完全不变。结果、镜像边界与原安装未改动的证据私密保留。
- 该分段授权范围的实现与隔离验收完成；原安装未升级，工作树未commit/push/开实施PR。合成材料、受控provider、独立真实Web与自然流量证据不混用。该分段结束时仍KEEP_OFF，量化分发许可未清算，自然shadow、受控启用、发布和第6节归档/关闭未获授权；后续许可证据与独立shadow授权见下一轮记录。

## Verification：模型许可交付、最终安装复验与shadow自用入口（2026-11-01，下一轮）

- 授权只扩展到模型许可材料、最终工作树的独立安装升级与shadow真实自用，不包含原安装升级、生产enforce、发布、归档或关闭#88。产品默认仍off，第6.1项需真实样本与人工审阅后才能完成。
- [模型许可材料](../../../apps/embedding/third-party/bge-small-zh-v1.5/NOTICE.md)随编码镜像交付原始MIT全文和七项公开来源指纹。BAAI固定revision原模型明确MIT；Xenova发行者在另一模型讨论中声明其全部量化沿用原模型许可，应用于本固定小模型文件的依据明确标为[INFERENCE]。本地INT8与固定revision远端LFS的23903394bytes及SHA256完全一致。未改原冻结manifest的`not_declared`/`production_distribution_cleared:false`，模型MIT使用依据不等于完整镜像/依赖分发审计。
- 实际重建携带声明的编码镜像；离线容器核对MIT原字节、NOTICE/provenance、镜像内无权重副本以及原encoding binding不变。实际服务ready且双并发上限仍2，未重算历史质量结果。机器镜像身份仅保留在外部受控证据。
- 正式`local:upgrade`从最终工作树升级独立安装，来源与运行镜像身份在私密证据核对。升级前后14张完整业务事实表行数及SHA全部不变，原安装未改动；最终Web镜像包含IPv4分类和必需INSERT行数两项修复，关闭上一分段的镜像版本缺口。
- 在该最终Web临时受控enforce复验列表/时区/单日简报，三条全部done、唯一原网关只读、0模型迭代/0token、完整展示回执。真实PG定向吞掉render INSERT后，Web失败且零回答delta、无回执、不切LLM；移除注入后相同`/timezone`恢复done。该故障注入已清除，测试不充自然样本。
- 随后恢复shadow，两条受控Web请求分别验证潜在时区命中仍由原模型答复，以及复合解释请求原路径拒识；可信快照分别2519/2974token、各2迭代，合计只编码一次，真实direct和路由展示回执均0。它们与之前全部验收共19个Run均排除在真实自用窗口之外。
- 固定自然观察切点在私密安装记录中保留，不因启动重置。交付启动、停止和审阅导出入口及本地使用说明，实际完成停止→正式启动→恢复shadow；14张完整事实表不变，受控运行数量不变。该分段交付时曾保留服务供用户使用，须显式选择普通对话Harness；后续专项暂停状态见末节，不公开本机地址。
- 审阅导出走owner限定的单个repeatable-read/read-only事务，不写DB、不调用编码器或模型，区分离线重建的潜在命中与真实direct、逻辑工具调用与审计记录、累计usage与未知值。含原话的报告仅留私密存储，实际验证Windows文件/目录ACL和不可覆盖，已有报告字节SHA不变。每条均待人工审阅，不自动认定自然来源或正确性。固定切点后的首次真实导出为0条，自然质量、净收益及生产许可不宣称已通过。
- 许可、最终安装版本、真实Web与shadow交付证据均保留仓库外；含原话、账户、配置的文件及其私密路径不入库。新Dockerfile已真实build及容器冒烟；未受影响的TS/native、D8与完整数据库集成沿用上一分段最终绿色证据，不冒称本轮重跑。
- 本轮补跑`bun run verify --skip lint typecheck depcruise unit`六步全部通过：门清单、10门可执行、冻结名、口径、严格OpenSpec九项及666文件格式；无变化的四步复用上述完整verify证据。外部记录为`check-next-round-final-metadata-1793515980227`。许可镜像与最终独立API/PG在交付时仍实际运行，未commit/push/开实施PR。

## Verification：多轮“哪些”查询误挡修复（2026-11-01）

- 范围：修复已有对话历史时遗漏“哪些”自主问句的通用读取线索，不增加逐句白名单，不改变候选对象、参数、否定/指代/筛选/多目标拒识或实际执行权限。guard 升至 `r2b-guard/7`，旧 bundle 与原始失败不覆盖。
- 测试策略为行为先行：新增多轮查询回归，在未改实现时实际得到 `eligible=false`，目标测试 0pass/1fail；改后四份路由专项 37pass/0fail、206断言。正常提醒列表的三种语序和明确日期简报均保留正确参数，六类否定、指代、筛选、查全和多目标负例仍拒识。
- 最终代码 `bun run verify --skip format:check` 九步通过：类型检查、lint、依赖边界和其他门禁通过，单元512pass/7skip/0fail、2442断言，严格OpenSpec九项通过；格式在质量文件和验证记录落盘后单独检查。不将历史D8或全量数据库集成冒充本轮重跑。
- 独立安装执行正式 `local:upgrade`，升级前后14张完整业务事实表的行数及SHA全部一致，核对证据私密保留。原安装未改动，不新建或补齐用户此前失败的提醒。
- 两阶段新资产校准与留出均保留全部失败；第二阶段校准纳入历史及新校准材料，不把已暴露留出改作校准。新留出、回归均仍有实质误接，不宣称自然验收或接管准入通过。按主spec及design/19 §12.2只允许关闭或零旁路shadow，不开启enforce；§15.3对齐这一既有边界。
- 第二阶段bundle为 `c43888639c7a730829f874cf997162c831fa76a80dbc4731007e9cd6aa6fbc95`，编码binding不变。180条校准含144条支持请求，112正确/0误接/32误拒；全新54条合成留出含36条支持，27正确/3误接/9误拒；1011条旧回归含731条支持，484正确/4误接/247误拒，编码失败均0。误接涵盖停用/标星筛选遗漏及新增、外发等完整目标遗漏；完整失败与首轮报告保存在仓库外，不隐瞒、不改gold、不据留出继续调参。
- 本轮Lorelum语义检索仍返回 `embedding.failed`，未取得Practice；不更改其模型配置或以关键词结果冒充语义结果。
- 真实Web验证已有历史中的自足活动列表查询：guard7下`eligible=true`，真实编码一次、正确默认活动列表候选，不再出现`CONTEXT_UNKNOWN`；仍fallback由原模型完成，两轮/3588token、一次原`list_tasks`成功调用。另验证否定读取得到`ACTION_DECLINED`、零编码/零工具。三条运行全部done、direct/render均0，私密证据保留，全部排除自然样本，原观察切点不重置。
- 查询验收期间批准及任务数量不变，后台另有既存提醒正常触发，所以task_events/outbox和状态哈希发生变化，不能声称整个验收窗口全部业务事实不变。原模型另有无依据承诺后续提醒的回答缺陷，私密保留；不把本次规则修复记成整体回答正确或自然验收通过。
- 交付文件最后执行 `bun run format` 与 `bun run format:check`，670个文件格式检查通过。代码九步验证与最终格式检查分开取证，未重跑未受影响的D8/数据库全套；未commit、push、开PR、开启enforce或关闭#88。

## Verification：完整目标误接与批量部分完成事实边界（2026-11-01）

- 修复范围：停用/禁用/暂停、标星筛选不能退化为默认活动列表；方向性放入/记入/加入是写动作，发给/寄到/推送不是读取；他人账户或设备/操作系统时区不能替换为本人保存偏好。保护普通“哪些”问句、本人系统记录、明确日期简报及过去加入列表的只读描述，不增加逐句白名单、不修改按钮批准合同。
- 路由采用行为先行：首批新增116个用例（38个拒绝文本、20个保护文本，各跑无历史/有历史），实际Red为63pass/64fail；Green后冻结guard8。其90条新合成留出暴露“读列表后加进去”遗漏，保留1次误接，不调阈值、不改gold；新增6个行为用例实际得到3pass/3fail后，补齐“加进”动词族并升guard9。最终四份路由测试159pass/0fail、492断言。
- guard8失败资产、guard9最终逐条报告及已暴露留出保存在仓库外，业务仓库不包含实验数据目录。两版校准使用完全相同的234条冻结材料（180支持），134正确/0误接/46误拒；guard8留出仅降为guard9回归，不进入校准。未改原校准算法或阈值选择规则。
- guard9新合成留出45条（36支持）：23正确/0误接/13误拒；1155条完整已暴露回归（839支持）：537正确/0误接/302误拒，编码失败均0。全部候选及所有阈值组合已按完整目标、工具、参数、来源范围/值与覆盖审计，最终接受结果与CLI逐条一致。材料为同作者、适应已知问题的合成验证，声明分组和原文隔离不证明语义/自然独立；误拒与自然质量、收益和共存成本验收仍未通过，保持shadow/off。
- 原生唯一系统约束明确请求N条、标题k/N或历史助手承诺不代表创建或后续计划；创建和执行分开按实际回执陈述，部分完成/未知不承诺自动续做、不擅自补建或重跑。真实Web首轮回放仍有历史事实判断错误，失败私密保留；补充“当前上下文未携带回执不证明原回执不存在”的通用事实边界。未增加TS输出过滤、新工具或业务持久状态。
- 首次正式升级前后14张完整业务事实表的行数及SHA全部一致；未更改原安装。独立启动脚本绑定guard9 bundle `94b02a1f02c27da434d6139e0732c1ed2389043b9c4d8090b81f2603b5fd1d8b`，真实输出shadow、原安装未动，固定自然观察起点不重置。
- 代码统一九步验证通过（格式另跑）：单元634pass/7skip/0fail、2728断言，严格OpenSpec9项通过；lint有非阻断警告。该验证覆盖TS最终实现，随后原生提示事实边界补充由正式重建与真实Web验证，不把未重跑的完整D8/数据库集成记作本轮结果。
- 第二轮真实回放仍有历史事实判断错误，即使原生产物源码指纹匹配，也不能把提示修改当作行为修复通过。该失败同样私密保留；最终原生约束进一步限定普通列表只回答本次匹配与过滤，不主动评判旧回答，批量完成问题则须核实实际记录或说明未知。
- 最终正式重建并升级独立安装，容器内`src/main.cj`与工作树字节指纹一致。真实Web四类验证全部done：普通列表正确候选、编码1次并由原模型按当前活动范围答复；批量核实经原只读查询核对实际创建事实、未找到/未知边界及既有错误承诺；停用筛选以`UNSUPPORTED_FILTER`零编码回原模型；否定读取以`ACTION_DECLINED`零编码/零工具。四条均实际direct=0、render=0、无异常；原始请求与回答、机器指纹仅留私密证据。
- 三次正式升级各自前后14张完整事实表行数与SHA全部一致；整个验证窗口任务、批准、任务事件及outbox事实均不变，没有补建、取消或重跑用户提醒。新增受控运行（含失败及中间核实）全部排除自然验收，原观察起点保持不变。私密证据保留原始回答帧及最终路由、工具和usage，不将含原话、账户数据的报告或其路径入库。
- 收尾执行 `bun run format`，覆盖670个文件；合成材料生成与完整目标审计程序保存在仓库外实验产物中用于复现，临时目录不留这些程序。未commit、push、开PR、开启enforce或关闭#88。

## Verification：专项暂停与默认 off 实施 PR 边界（2026-11-01）

- 用户授权暂停专项；自然 shadow（6.1）与逐意图受控接管（6.2）均未通过，保持未勾选，不将 guard9 合成零误接或真实 Web 受控成功当作自然质量、净收益或上线许可。最终 archive/关闭（6.4）未执行且未获本轮授权。
- 独立 API 的有效环境为 `HARNESS_ROUTING_MODE=off`，专用编码器已停止，API 与 PG 保持运行；API `/readyz` 与 Web 首页均为 HTTP 200。未启用 enforce、未重启 shadow，未更改原安装。
- 暂停操作前后14张业务事实表的完整行数与SHA全部一致；原始证据仅留私密存储，不公开请求、回答、用户/账户标识、本机地址、私密证据路径或机器digest。该记录只证明本次停用、应用健康及数据不变，不覆盖自然验收。
- 模型 `NOTICE`、完整 `LICENSE` 与 `provenance.json` 已交付，包含量化作者声明应用于固定文件的推断边界；完整镜像/依赖分发清算尚未完成，历史冻结许可字段不回写。不把模型声明已完成记作镜像可发布。
- 本轮实施 PR 仅 `Refs #88`，不 archive、不关闭 issue。6.3 的本地执行证据见下节，五门 CI 结果在实施 PR 核对后记录；自然观察和接管准入不随实施 PR 勾选。
- API workspace 的 `test:integration` 补齐 `--timeout 30000`，与根入口及既有测试预算一致，覆盖 CI migration-scan 调用该入口时的夹具预算缺口；不改变应用deadline或行为断言。既有5秒夹具超时失败保留，不为确认已知失败而重跑。

## Verification：默认 off 实施分支验收（2026-11-02）

- 仅导出 #88 暂存内容独立验收，排除时间解析、日期锚和 Web 就地批准改动；不恢复实验数据目录、向量或逐条报告。校准示例改为外部材料路径，完整实验及失败保存在仓库外。
- 七项静态门通过：lint（24条非阻断警告）、typecheck、depcruise、gate-manifest、gates-executable、frozen-names、copy-claims。分段补齐的 unit/OpenSpec/format 门通过，单元为599pass/5skip/0fail、2616断言；未将分段执行称为单次完整 `verify`。
- 正式 native/私有 PG 的 D8 本地及 HTTP 双入口139pass/0fail、1695断言；必需消费者执行报告和10条门证据校验通过。API、仓颉、契约及正式消费者源码与该次运行快照字节相同，复用有效结果，不因移除实验材料而重复执行。
- PG16 workspace 全套首跑325pass/9fail：9项失败均为文档批准夹具把临时工作区建在当前目录，在容器目录权限下被正常鉴权拒绝。夹具改用系统临时目录并保留收尾删除，不放宽生产检查；该文件修后10pass/0fail、65断言，其余文件未重复运行。最终全套结果由实施 PR 的 migration-scan 门核实，不把分段结果冒称修后整套重跑。
- 真实 PG16 升级/只读重启/拒绝索引、trigger、CHECK 漂移4pass/0fail、26断言。临时 PG、网络和验收镜像清理完成；未触碰独立业务安装。
- 本轮不重新进行自然观察、模型质量刷样、接管放量、用户提醒补建或完整分发许可清算；相关边界保持本文件6.1、6.2、6.4及上节记录。
