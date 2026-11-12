# 19. R2-B 有限只读意图路由

> 状态：受控实现合同；默认关闭，实现、质量、真实 Web 与自然流量分层验收，不自动授权接管。
> 范围：Issue #88，完整规则、轻量语义匹配与原聊天模型之间的路由，限三类现成只读用例。
> 不包含：写动作、批准或恢复接管、工作区任务、多目标执行、记忆、额外聊天分类器、自动上线或原安装升级。
> 阶段标签：R2-B；行为增量见 [OpenSpec change](../../openspec/changes/define-readonly-intent-routing/proposal.md)，既有职责见 [09](09-agent-runtime-and-checkpoint.md) 与 [R2-A](18-r2a-harness-context.md)。

## 1. 范围与不变项

[Required] 在仓颉 Harness 首次调用模型前增加一次有界判断：完整规则能处理则直接走原只读工具；规则未命中时，可由 BGE INT8 判断是否适合直读；其余完整交回原聊天模型路径。原路径在既有验证中使用 DeepSeek，本方案不另选应用 provider，不将实验工具的角色配置当作应用配置。

目标是减少实际发生的聊天模型请求，而不是给所有输入强塞三个标签。提醒创建/取消、资料分析、普通交流和能力外问题仍有原处理路径。候选模型是 BGE-small 中文 INT8；multilingual E5-small FP32 仅作离线对照，不双模型常驻、轮询或自动切换。

[Required，沿用] 仓颉唯一组织模型/工具循环及停止；TS 拥有可信身份、事实、时间、批准、ToolGateway 与存储。`execution=business|harness`、缺省 business、原入站 hash/幂等、取消裁决、批准后同 Run 显式继续、snapshot2 和外部七种 SSE 事件不变。没有 `execution=auto`，也不通过扩大 business 的关键词匹配实现路由。

[Required] 功能默认 `off`。实现及隔离验证不构成自然流量或接管授权；真实服务、质量评估、正式消费者、真实 Web、自然影子和实际接管分别取证。不需要先满足大样本统计声明才开始开发，但任何离线“零错”都不能自动打开开关。

[Required · 实施交付边界] 默认 `off` 的实施 PR 可独立交付三类只读路由、v5/迁移、来源与原子展示保护及其有效验证，使用 `Refs #88`；不以自然 shadow、受控接管或最终归档全部完成为前置，也不因此标记这些验收通过。实施相关消费者与既有门禁须有覆盖最终变更的有效证据；自然质量、保守净收益、逐意图授权与完整镜像/依赖分发清算仍各自保留门槛，不自动部署、发布、archive 或关闭 #88。

[Required · 本人委托兼容] `harness/v6` 的 legacy 与本人委托均可使用冻结的路由策略；委托 direct 以唯一已接受只读回执及经过哈希核对的完整渲染构造 `GoalResult`。澄清续接不分类，off、原授权与旧数据保持不变。本机启用方式见[本地指南](../guides/local-lifecycle.md)，默认不启用。

## 2. 现状与证据

[Observed，规范编写时的基线] HTTP 接纳冻结输入、execution、allowlist 和预算；基线 native 在首轮构造/计量上下文后请求模型，内部 wire 为 `harness/v4`、快照为 version 2。R2-B 的后继 v5 与路由分支见 §7。TS 的模型 transport 不决定下一工具；三个现成只读工具是 `list_tasks`、`get_user_prefs`、`read_brief_cards`。源码入口见 §14；历史静态核对不充当运行验收。

[Observed，离线实验] [2026-10-31 实验记录](../verification/r2b-embedding-evidence-2026-10-31.md)保留模型版本、材料哈希、成绩和错误。BGE INT8 新材料正确接管 66/72、旧回归 62/72，旧回归仍有一次时区→提醒误接；E5 为 61/72、55/72，两主集及控制组未见误接。BGE 的离线 batch1 p95 为 2.21ms、进程峰值 145.72MiB，E5 为 15.49ms、676.61MiB。这是 Windows CPU 短输入实验，不含 HTTP、队列、工具、仓颉或自然流量。

因此选择 BGE 是资源与候选覆盖的取舍，不是质量全面领先的结论。已有规则误挡与跨意图误接说明只换编码器不够。正式 Linux 服务、部署资源、完整请求延迟、自然正确率和净收益必须另证。

## 3. 一次请求与职责

```text
原 HTTP 鉴权/接纳/冻结 Run 与首 attempt
  → 正式仓颉启动
  → 仅 fresh 首模型前检查一次路由资格
      → 完整规则命中且上下文/参数合格
          → 接纳 direct → 原网关只读 → 接受结果/snapshot → 固定展示 → 终结
      → 规则未命中
          → 不适用直接走原模型
          → 或一次编码/全类打分
              → 满足全部门且已开启该意图：同一 direct 路径
              → 其余：完整原话/原冻结上下文走原模型
```

| 所有者            | 责任                                                             | 不承担                                                 |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| 仓颉              | 首轮阶段、最终 direct/fallback 决议、目标工具选择、原循环和停止  | 不自报 owner/权限，不从向量取得执行许可                |
| TS 路由辅助       | 冻结原话、上下文事实、完整命令匹配事实、参数来源、编码及精确得分 | 不调用业务工具、不递归决策、不调用聊天模型补分类       |
| TS authority/网关 | 当前资格、来源绑定、原预约/执行/接受、展示和持久化               | 不伪造 provider 函数调用，不复制一套 native 阈值决策器 |
| 独立编码服务      | 固定 tokenizer/模型下的文本→向量                                 | 不读业务库/批准/工作区，不返回操作指令                 |
| 原模型 transport  | 原 HTTP/stream/usage/abort                                       | 不增加 TS agent loop                                   |

TS 中的命令、中文参数与模板只有一份；仓颉使用可信事实和冻结数值作决议。接管必须覆盖用户完整目标，语义相似、参数合法、执行资格及真实结果是四个不同条件。

## 4. 白名单与规则

| 候选                  | 唯一工具与参数范围                                                           | 不接管                                                                      | 展示边界                                                                           |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `task_list_bounded`   | `list_tasks`，原默认活动集合；无数量要求用合同默认 20；明确十进制数量仅 1–50 | 按日期/名称/关键词筛选、其他状态/排序、查全、全文、排期或送达核实、查完再改 | 返回条数、原状态、冻结时间/时区、原标题预览、上限及 `has_more`；不是全部或必达证明 |
| `prefs_timezone_read` | `get_user_prefs`，空参数，当前 owner 来自服务端                              | 改时区、历史时区、服务器时区解释、补偏好、顺便写入                          | 只说本人系统记录的 `timezone_id`；null 表示未设置，不推断位置或写偏好              |
| `brief_cards_read`    | `read_brief_cards`，单个真实合法 `YYYY-MM-DD`，无 `card_ids`                 | 相对/跨日期、查全、任意资料/全文、重新生成、比较/总结/分析                  | 原日期、现成卡片与来源；接口最多 50 张且没有查全证明                               |

活动集合沿原工具的 `saved/pending_schedule/scheduled/cancel_pending`，不新增状态。空结果是一次成功的有限读取，不外推从未存在。标题沿用工具预览，不二次声称全文；不换算冻结时间。简报卡片或任务标题含指令时仅当数据展示，沿现有安全渲染，不交给另一个模型执行。

第一层只匹配覆盖整个输入的有限命令，例如 `/reminders`、`/timezone`、`/brief YYYY-MM-DD`；空白与结尾标点处理版本化。按钮确认、Run 取消与批准恢复保留专用端点，不当作普通文本再分类。追加“然后取消”、条件、引用或承接信息不能只执行前半句。

非 LLM 参数解析仅提取明确数量/日期、约束和来源，不再造完整动作语法来重复第一层。过去“添加的提醒”不等于现在创建；“读到”不等于日期范围；“不用更长”不等于取消本次读取；场景词“今天想读”不覆盖后文明示的唯一查询日期。无法可靠区分时仍回原模型，不通过逐句白名单或删词提高覆盖。

完整目标检查须区分动作、对象和约束：将事项放进/记入待办、把内容加入简报或把卡片发给收件人，都不是普通读取；停用状态与标星要求也不能丢弃后返回默认活动集合。时区只读限本人账户保存值，其他人的账户、手机或操作系统时区不能替换为本人偏好。历史叙述“先前放进列表的提醒”本身不是新增动作；明确读取已有对象仍按后续语义阈值判断。

## 5. 模型、编码与服务合同

### 5.1 固定资产，而不是只固定名字

| 项目           | BGE INT8 主候选                            | E5 离线对照                                |
| -------------- | ------------------------------------------ | ------------------------------------------ |
| 实际发布来源   | `Xenova/bge-small-zh-v1.5`                 | `intfloat/multilingual-e5-small`           |
| commit         | `75c43b069aac4d136ba6bc1122f995fedcfd2781` | `614241f622f53c4eeff9890bdc4f31cfecc418b3` |
| 编码资产       | `onnx/model_int8.onnx`，23,903,394 bytes   | `model.safetensors`，470,641,600 bytes     |
| pooling / 维数 | CLS / 512                                  | attention-mask mean / 384                  |
| 两端文本       | 原句，无前缀                               | index/query 都只加一次 `query: `           |
| 已实测后端     | ONNX Runtime 1.24.2，CPUExecutionProvider  | Torch 2.10.0 CPU，FP32                     |

BGE INT8 的逻辑架构来自 BGE-small，但量化文件是社区发布，不能写成 BAAI 原 FP32 文件或官方自制导出。模型 SHA256、tokenizer 与实测依赖见实验记录；构建产物必须带逐文件 manifest 并复核许可。不能借原始模型 MIT 名称跳过量化发行物及镜像的许可核对。

量化仓库缺少独立许可声明，不等于已经确认禁止使用，也不能仅凭基础模型 MIT 自动宣称全部发行物已清算。[模型第三方声明](../../apps/embedding/third-party/bge-small-zh-v1.5/NOTICE.md)及同目录 `LICENSE`、`provenance.json` 记录原模型 MIT、量化作者“所有量化沿用原许可”的公开声明、固定版本与实物哈希；作者声明位于其他型号讨论，应用到当前固定文件的推断边界须保留。模型的 MIT 使用依据与完整镜像/依赖分发清算分开。

历史冻结 manifest 的 `quantized_distribution: not_declared` 与 `production_distribution_cleared: false` 保持原样，新增许可核验记录不回写旧实验或改变编码 binding。编码服务镜像携带上述声明，但模型权重始终作为外部只读资产，不装入应用或编码服务镜像；分发权重时同时保留相应版权及完整 MIT 文本。

### 5.2 编码路径

起步保留已实测的 AutoTokenizer/ONNX Runtime CPU 计算路径：tokenizer 来自同一固定目录，`local_files_only=true`、`trust_remote_code=false`；含特殊 token 的实际长度上限 256，禁止截断。模型使用顺序执行、intra-op 4、inter-op 1；重用预热 session/tokenizer，不逐请求装模型、不导入 Torch。提取已锁定图输出的 CLS，转 float32，检查 512 维、有限且非零，再做 L2 归一化。

原话不变。编码副本仅做 NFC、CRLF→LF、首尾空白整理；不删否定/实体/尾句，不拼历史、工具正文或答案。参数来源仍指向原话，不指向规范化副本。

### 5.3 内网服务边界

[Required] 独立 Python CPU sidecar 包装固定计算路径，API 通过内网 HTTP 请求；HTTP 薄壳使用 FastAPI/Uvicorn，不自写服务器。它不是应用业务层或第二个 agent，也不在 Bun API 内安装 Torch。服务只拥有编码资产与缓存，无 DB、业务密钥或工作区挂载；不另建 tokenizer 服务或模型调度平台。Linux 依赖版本及 wheel 哈希见 `apps/embedding/requirements.txt`；运行清单绑定依赖及许可来源，镜像身份按实际构建记录，不把本地 image ID 冒称 registry digest。

私有 `POST /encode` 严格单文本合同：

```ts
// binding_sha256 是编码 manifest 的 hash，不是用户可选择的模型。
type EncodeRequest = {
  binding_sha256: string;
  text: string;
  max_tokens: 256;
  truncate: false;
};
type EncodeResponse = {
  binding_sha256: string;
  token_count: number;
  dimension: 512;
  vector: number[];
};
```

编码 manifest 固定模型/tokenizer 文件哈希、图输入输出、运行时/CPU provider、pooling、维数、归一化及长度规则；哈希由不含自身哈希字段的规范化构建清单产生。路由 bundle 再绑定该编码 hash 和 §6 的业务资产，sidecar 不需要业务目录、阈值或参数规则。

token_count 是对本次完整字符串含特殊 token 的精确计数，不按字符估算。超长返回可区分的受控拒识，零 forward、无向量；binding 不符、未就绪或编码异常不得返回伪向量。TS 核对 binding、token_count、维数、有限值和非零范数，并统一 L2 归一化；有证据表明响应不属于本次完整输入时不接纳。服务不能接受任意仓库/revision、临时下载或换模型字段。

离线脚本不能证明 HTTP 服务或 Linux 镜像验收。固定资产须验证 token IDs、special tokens、图输入、pooling/归一化与参考路径一致，并完成超限零 forward、异常/取消及真实 HTTP 资源实验，才锁定镜像身份和依赖清单。没有可验证运行产物时保持 off，不编造 digest，也不静默退到 FP32、E5 或 TEI。

## 6. 目录、打分与参数

目录、连续 float32 原型矩阵和反例矩阵是可重建静态资产，归 conversations 的路由辅助所有；不建向量数据库或 ANN。目录同时包含三类白名单及提醒写/其他查询、资料分析/修改、结果核实、控制/承接、普通交流/引用、能力外等相邻目标。多目标作为拒识材料，不强塞进一个可接管类。

起步固定每竞争类四个表达族，每族最多四条去重正例，均值后再次单位化。对单位查询 q，计算所有竞争类四个族的点积，以该类最佳两族均值为 `S(i)`。同分拒识；先选全空间第一、第二类，不从白名单中捞第二名。第一名须为白名单，并满足本意图的 `S(i) >= tauIntent(i)`、`S(i)-S(j) >= tauGap(i)`。对明确排除该类的反例取最高分 `R(i)`，`R(i) >= S(i)` 时否决。反例不进正例投票。

线上打分和新校准必须使用同一实现、矩阵、累加精度及并列规则，并纳入 scorer revision。TS Number 累加和 NumPy float32 点积不能未经验证视作相同分数；TS 再归一化等数值差异也不能靠照搬旧阈值忽略。

参数、上下文与资格门均优先于高分：

1. 仅 fresh 首 attempt、首次模型前；无当前执行资格直接停止，不编码。
2. 当前输入处于确认/继续/撤回/改动流程，或有指代、纠正、条件、顺序、多目标、引文测试、写动作、分析/查全要求，不能截取只读部分。
3. 使用已有真实 Run/批准状态及冻结历史判断承接；不发明 `pending_clarification` 字段。无法可靠确认独立时以 `CONTEXT_UNKNOWN` 回原模型；存在历史本身不永久禁用自足新问题。有历史时，明确的读取动词和“哪些”等自主疑问表达均可进入后续判断，不要求用户把自然问句改写成命令。此处仅解除上下文误挡，不直接认定意图；指代、否定、多目标、筛选等拒识门和全竞争语义阈值仍须通过。
4. 不完整/重复/冲突日期或数量、不支持的数量写法/筛选、无效 Gregorian 日期、handler/规则版本不符均拒识。明确有数量要求但解析不了时不能擅用默认 20；日期不能从时钟、样例或历史补。
5. 槽位值必须带本轮 message 引用、原文 raw 和 Unicode 标量半开范围、parser revision，或标明合同默认来源。JS UTF-16 下标不能直接当跨语言标量下标；owner、权限和 Run 身份不是用户槽位。
6. 所有前提满足仍仅为候选；实际 direct 还要满足冻结 mode/逐意图开关及 TS authority 当前资格。

负向 guard 没发现问题不证明不存在；parser 合法不证明语义完整。剩余风险由独立材料、真实 shadow 和逐意图准入约束，不写成“相似度足够高就安全”。

bundle manifest 绑定目录/矩阵哈希、模型与 tokenizer、编码 binding、完整规范化/前缀、族分组/打分/veto、各意图两阈值、guard/parser/handler/renderer revision、split/校准记录。运行中只读；任何改变产生新 bundle，不能混新向量与旧阈值。

## 7. harness/v5 内部合同

[Required] TS/shared contracts/native/消费者/镜像同批使用 `harness/v5`，无 v4 偷加字段、双写或兼容 shim；snapshot 保持 version 2。旧 Run 在新软件中可沿原路径读取/有效恢复，不因此获得路由。

`start` 增加 `routing_policy` 和 `eligible_phase=fresh_first_step|disabled`。旧缺记录的策略为 null 并等价禁用；新关闭策略最小为 `{revision:'r2b/1',mode:'off'}`，不要求编码资产。shadow/enforce 策略须有完整 bundle、候选/可直读意图、阈值与预算。shadow 可计算潜在命中，但 direct 意图集合为空；enforce 只有通过审阅的逐意图子集可执行。

| 请求                          | 输入及 TS 回复职责                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `route_probe`，facts 分支     | 只取当前冻结输入的完整命令匹配、可信上下文、槽位/来源；不给 native 传替代 query/owner 的入口；返回当前 policy/input 绑定的事实引用 |
| `route_probe`，embedding 分支 | 同一输入与 bundle 下最多一次编码，返回完整竞争得分及固定反例证据，或有界拒识原因；不直接决定工具                                   |
| `route_decide`                | 仓颉提交唯一 direct/fallback；direct 仅引用已返回候选和参数来源；TS 原子校验/接纳并返回 `decision_ref`                             |
| `render_route_result`         | 仅 `decision_ref`、`invocation_ref`、`template_revision`；TS 从已接受的原结果生成和接纳展示，不接受任意正文                        |

各帧为严格判别 union，沿唯一 request_ref/reply_to、顺序 ack、UTF-8/EOF、1MiB 和原背压。当前 Run/attempt/取消/输入/bundle 绑定由 TS 权威确定。错版、额外字段、重复错序 probe、伪参数引用或 decision 冲突按原协议/资格错误拒绝，不能装作低置信回原模型。

off/旧 Run/resume 不发 probe；probe 不插入在途模型 stream。shadow 保存潜在候选后终局仍 fallback；原冻结上下文原样走现有计量/模型循环，不注入猜测标签锚定回答。

## 8. 不可变策略与执行记录

复用 append-only `run_checkpoints`，不建路由表、不加 Run JSON 列、不改 `frozen_context` 或 snapshot2：

| 内部 kind                  | 写入与内容                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness_routing_policy`   | 新 harness Run 原接纳事务、首 attempt 后写一次；off 也记；冻结 mode、规则/bundle/编码绑定、逐意图阈值/开关、handler/renderer 与预算，无密钥/endpoint          |
| `harness_routing_decision` | 同首 attempt 唯一终局 direct/fallback；引用 policy、冻结输入摘要、有限候选/分数/原因、参数值及来源；其 UUID 为 `decision_ref`；shadow 的潜在命中不等于 direct |
| `harness_routing_render`   | 引用 decision、唯一真实 invocation、模板 revision、正文 hash 与分块数；不再复制全文/向量                                                                      |

新迁移扩充既有 `0015` 的封闭 kind CHECK，并添加同首 attempt/kind 唯一及来源/owner/Run 绑定的受限写入校验；编号按实施时下一迁移选择，不改已合并文件。policy 与原接纳失败一起回滚；网络编码不在锁事务中。decision 相同内容重交只回原回执，冲突拒绝，不重新编码；路由记录不是恢复点。

三类路由记录追加必须确认实际插入一行；触发器吞掉写入等零行结果同样属于持久化失败。策略失败回滚接纳，决议失败不调用模型，展示失败回滚正文与收据，不能等到终态核验才隐藏已经发出的正文。

所有新 kind 继续由内部过滤器排除，不交外部 ThreadEvent parser。共享 seq 导致对外游标间隙合法；GET/同键重放只补已存事实，不创建策略或 attempt。旧 Run 有效批准恢复不补路由策略；R2-A 自己的上下文策略补录规则不被此处改变。

## 9. 工具调用与确定性展示

direct 接纳后，使用原 `harness/N` reserve/invoke、参数摘要、ToolGateway、真实接受结果、审计及 snapshot；唯一工具及规范参数必须等于 decision。拒绝改成写工具、第二动作或借旧 decision 换目标，不伪造 `assistant.tool_calls`/provider call ID。

TS renderer 对 typed accepted_result 作纯投影，不再查第二工具、不调用模型、不选择行动。完整文本与字节/安全分块在锁外准备，重验当前资格后同事务追加原 `message.delta` 和 render 回执，提交后按原顺序发送；失败无半份成功展示。输出装不下时诚实容量失败，不删内容却宣称完整。

`finish(done)` 必须对应本 Run 的唯一成功只读接受结果、有效 render 回执和零模型调用。首次模型前任意 answer 的现有宽口需收紧：普通模型回答只接受实际 pending provider delta；direct 正文只能来自 renderer，不借 native 自写答案绕来源。

snapshot2 的真实工具引用/调用号保持单调。direct 没有模型请求时，真实模型 iterations/tokens 为 0，编码计量单列；不构造虚假模型输入计量或把编码当 provider usage。fallback 才执行原窗口/字节/预算检查，不重置或扩大 R2-A 额度；已有未知 usage 不能清零。

## 10. 失败、取消与重放

| 时点/问题                                                                        | 行为                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| off、旧 Run、已调用模型、有效批准恢复                                            | 零分类，走原路径                                                            |
| shadow                                                                           | 可计算/记候选，零旁路业务调用，用户回复仍走原路径                           |
| direct 前的低分、未知/复杂目标、参数不足、可选编码超时/不可用/绑定不合格、资源满 | 完整回原模型，不注入猜测参数，不重试编码或切 E5                             |
| 主 Harness 接纳前提不满足                                                        | 沿原 `HARNESS_UNAVAILABLE` 等语义，不因可能直读而绕过                       |
| 协议/来源损坏、DB 无法接纳、owner/attempt/取消不合格                             | 停止；不是可绕过的语义拒识，不让模型掩盖                                    |
| direct 已接纳后 reserve/invoke/render 失败、denied/unknown                       | 原失败终结并留账，不转模型、不新开 slot、不重新选路线，即使工具尚未实际执行 |
| 取消/断连与编码或展示竞争                                                        | 原取消先提交即撤资格并 abort；迟到候选/输出不执行、不披露、不覆盖终态       |
| 结果/展示提交后丢响应                                                            | 只读补原事实，不补执行、不生成第二终态                                      |
| native 崩溃                                                                      | 原失败规则；不扩大任意中间点恢复                                            |

编码在 DB 锁外，前后复核资格，沿 Run abort signal；session close 清理在途请求和计时器。停用新 Run 路由不改已冻结策略或已有事实；已有 Run 需要停止时使用原取消机制，不借关开关重路由。

HTTP abort 证明的是传输取消和迟到结果不被接纳，不自动证明 CPU forward 已被抢占。服务若已进入不可中断的本次 forward，须跟踪真实占用直至计算结束并回收，不能提前释放容量名额后继续堆积后台计算；验收分别观察取消后的零业务动作和服务资源释放，不把请求deadline当作CPU计算的强制终止保证。

## 11. 运行预算与部署

[Proposed，验收起点而非用户给定 SLA] 含预处理、服务排队、tokenizer/forward/打分的总 deadline 1000ms；每 API 实例最多两个在途编码，满则本轮 fallback，不加持久队列/重试。一个请求最多一次实际编码、一个 direct 工具；拒识热态新增 p95 目标不超过 500ms。修改这些起点需新策略版本和重新验证，不能事后挑口径宣称过门。

目标宿主以生产 Linux CPU sidecar 与 API/PG 共存实测冷/热启动、HTTP、峰值/驻留、并发和拒识增量；不能用离线 2.21ms 当线上 SLA。模型/镜像预先获取、hash/许可校验并预热，请求内不下载。缓存/模型独立卷，服务运行只读；不开放公网端口。Windows 可配置下载、实验、环境与缓存放 D 盘或仓库外任务目录，不把权重/venv/日志提交仓库。

off 不要求编码服务或缓存。可选路由故障只停优化，核心 `/readyz` 的 DB/时间规则等类型化合同不能降级；主 Harness 接纳条件保持原语义。服务就绪和资产绑定单列诊断，不假装核心服务健康等于可直读。

## 12. 校准、独立评估与启用门

### 12.1 旧错例是回归，不是新留出

保留 BGE TST-032 时区误接为提醒、Dmeta CTL-013 读后改时区漏目标，以及六条共同误挡；模型归属和原失败见实验记录。修正不能靠删样本/改 gold、逐句特例、硬编码已知意图或只看新集合掩盖旧错误。已选 BGE 的旧资产不因新集合零误接而获准 enforce；E5 零观察错误也不等于安全证明。

任何 guard/parser/目录/模型/后端/量化变化都产生新 bundle，原暴露测试转回归。先冻结新材料和分组，按同故事、来源、模板母题、改写族及对比关系整体隔离 index/development、calibration、最终留出；不拆相关组凑数量。新校准单独选择每意图两阈值，保存全部候选、分母与并列规则，再冻结并一次评估未见留出。实验旧阈值不是生产默认值。

误接包括错对象/意图/日期/数量、遗漏目标或约束、误读否定/引用、相对/承接补错参数、查全仅给局部、输出超过真实回执。必须检查整个链，不只 top1。合成/自然、主集/控制、执行前候选/实际执行、规则/编码/工具失败分别报告。

### 12.2 从关闭到逐意图接管

| 阶段           | 可观察结果与进入下一阶段条件                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| 合同           | 独立 Issue/分支/change、设计/PRD/API/schema 对齐，strict 与引用检查通过，交用户审阅；不改业务代码          |
| 默认关闭实现   | 先服务最小真实实验，再 TS/native/shared 同批合同、存储/来源/展示/取消与受控正式消费者；旧路径不变          |
| 新离线验证     | 已知回归通过，新分组校准/未见留出全链审阅，完整保存失败；不把回归修好当泛化                                |
| 自然 shadow    | 原回答与执行仍沿原模型，候选零业务调用；候选逐条审阅，记录真实请求数、usage 可得性、资源和增量延迟         |
| 逐意图受控接管 | 该意图无已知实质误接，D 门/真实宿主通过，对真实 L1 miss 有非零正确增量，保守净收益为正，明确人员审阅后开启 |
| 扩大或停用     | 每批审阅再决定；重大误接立即停受影响意图，保留事实/版本，不自动降阈值、开量或改用 E5                       |

建议顺序是时区、活动提醒、单日简报；各自过门才能开启，不用总平均分抵消。起步 5% 合法新 Run 的稳定分桶是 Proposed 限制，不是自动发布许可；单租户样本少可使用明确受控小批，不凑百分比。达不到收益/质量门就保留 L1＋原模型、关闭 L2；没有义务为了三层形式在线保留编码器。

自然 shadow 可以专项暂停，而非必须持续运行；暂停与验收通过不同。未满足质量或收益准入时可保持 `off` 并停止专用编码服务，保留应用、历史事实与审阅证据。恢复观察或进入受控接管均需对应授权和有效证据，不能因实施 PR 合并而自动重启 shadow 或开启 enforce。

自然错误率与收益不能由合成分数代替。若声称独立 Bernoulli 假设下零误接的单侧 95% 上界≤1%，每意图至少 299 个独立接受单元（`1-0.05^(1/n)`）；同故事改写、总输入数或三意图合计不能充数。299 只是该统计声明示例，不是开发或受控小批的前置门；相关流量必须披露其限制。

### 12.3 收益与回滚

分母串联记录合法请求、L1 miss、实际编码、候选通过、direct 分派、完整零聊天模型交付；同时报每意图误接/误拒、handler 失败、unknown、取消、拒识增量 p95、端到端完成、CPU/内存和实际模型请求/usage。embedding 本地成本、常驻成本及 miss 叠加原模型成本都算入；shadow 只有额外开销和潜在收益，不能称已省费。usage/价格不可得写 unknown，不按字符估钱、不另跑一套收费基线隐瞒实验开销。

首选回滚是保留 v5 软件、关闭新 Run 路由或某意图；不删 policy/decision/render，不重写业务/工具/消息事实。含新事实或在途/批准 Run 时，降回 v4 二进制不是无损开关，须先验证兼容/停写/前滚；不把重建库或清缓存当回滚。

## 13. 实施拆分与验证所有权

各负责人按下列边界交付并记录实际证据；实现授权不延伸为自然流量、原安装升级、自动启用或归档授权。

1. 合同负责人：设计、行为 delta、PRD/API/schema/索引与静态校验；交付不适用运行时 TDD，也不计成部署验证。
2. 编码负责人：固定资产的最薄 HTTP CPU 服务与目标 Linux 真实实验，证明精确 tokenizer/CLS/归一化和长度/异常/取消行为，锁定真实镜像而不是只跑 mock。
3. native/TS 集成负责人：新严格 wire、首轮决议、原子 policy/decision/render、新迁移与来源/取消/重放保护；确定性新增行为先实际 Red，再 Green，环境失败不算 Red。
4. 质量负责人：通用规则修正、旧失败回归、冻结新校准/留出、逐意图人工审阅；不承诺未授权新模型实验已经运行。
5. 端到端负责人：正式 Web→API→仓颉→真实编码→原网关→PG→SSE 的三只读成功、拒识、失败及原模型/批准恢复；与受控 provider 的消费者证据分账。
6. 发布负责人：自然 shadow、受控小批、停用/回滚验证及最终 archive；发布/付费自然实验/原安装升级不由本合同自动授权。

每验收项一个验证负责人，复用有效证据；后续只补代码变化、集成或证据缺口，不再主线程重跑相同检查。沿现有根 scripts/五门，不新建替代 CI；实施交付须完成受其变更影响的验收与门禁，不能将未完成的自然/接管验收或最终 archive 勾选为完成。

## 14. 行为验收与追溯

| 验收面       | 必须观察的结果                                                                                                       | 映射                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 归属与旧路径 | business/缺省不变；off/旧 Run/GET/同键/resume 零分类，主依赖坏不偷偷直读                                             | D1/D6/D8                |
| 真调用数     | L1：零编码/零模型/一个原只读工具；L2：一次编码/零模型/一个原工具；shadow/miss 无旁路工具并走原模型                   | D8/D10                  |
| 全目标与参数 | 1/50/默认20、非法/重复/冲突日期数量、否定/引用/指代/多目标/查全/能力外；已知反例不得高分误接，规则误挡用通用行为覆盖 | D8/D10                  |
| 来源与 wire  | 错版、错序、旧/跨 owner/Run/attempt 引用、伪参数、direct 后 model/第二工具、任意 answer、无 render finish 均拒绝     | D1/D8/D9                |
| 真实展示     | 原 `has_more`/标题预览、timezone null、简报50张边界、来源、Unicode/CRLF/不可信正文和超大结果诚实处理                 | D2/D8/D10               |
| 原子与竞态   | policy/decision/render/终态失败无半写；编码/预约/接受/展示各点取消，迟到结果不推进；丢响应不重做                     | D6/D8/D9                |
| 资源与收益   | 目标宿主真实 HTTP 冷/热/并发、拒识增量和整体完成，L1 miss 的新增正确交付与真实模型调用数分账                         | D6/D8/D10，非仅单元测试 |
| 原有保证     | R2-A 额度/unknown usage/来源/批准恢复、冻结展示、取消回执及 A1–A4 不削弱；新 kind 不泄漏外部 SSE                     | D1–D10、A1–A4 原范围    |

源码依据：`packages/contracts/src/harness.ts`、`routing.ts`（wire/snapshot）；`apps/harness/src/main.cj`（首模型前/原循环）；`apps/api/src/modules/conversations/service.ts`（接纳）、`harness-authority.ts`（资格/answer/render）、`routing-checkpoints.ts`（内部记录）、`routing/`（事实/资产/编码/打分/展示）、`repository.ts`（公开过滤）；`apps/api/src/modules/tools/schemas.ts` 与公共只读用例（原参数/投影）；`infra/migrations/0020_conversation_readonly_routing.sql`（扩充0015封闭 kind 及来源约束）。实现变更与分级实测结果记录在 [change tasks](../../openspec/changes/define-readonly-intent-routing/tasks.md)，长期合同不保存临时交付进度。

## 15. 配置与受控实验

### 15.1 API 开关

| 配置                          | 行为                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `HARNESS_ROUTING_MODE`        | `off`（缺省）/`shadow`/`enforce`；非法模式直接报配置错误       |
| `HARNESS_ROUTING_BUNDLE`      | 外部绝对路径的完整、不可变 `bundle.json`，不是模型目录         |
| `HARNESS_ROUTING_ENCODER_URL` | 私有 HTTP origin；sidecar 不提供业务权限                       |
| `HARNESS_ROUTING_INTENTS`     | `enforce` 允许的逗号分隔意图子集；缺省为空，不自动授权三个意图 |

`off` 不读资产或访问编码服务。启用配置缺失、资产损坏/版本不符或私有 URL 不合法时，输出固定诊断 `ROUTING_CONFIG_UNAVAILABLE` 并关闭优化，不阻断原聊天或核心 readyz。每个新 Run 冻结启动时的有效策略；修改开关或资产不改写旧 Run。生产停用优先设置 `off` 或移除指定意图，保留 v5 与已存事实。

编码地址允许 IPv4 环回/私网、IPv6 `::1`、单标签内部服务名及 `.internal`/`.localhost` 主机名；先验证真正的 IPv4，再判断私网范围，`127.example.com` 等公网域名不是私网 IP。禁止凭据、非根路径、query/hash 与跨 origin 重定向；编码地址不授予任何业务权限。

### 15.2 编码服务

Linux wheelhouse、固定模型/tokenizer、许可来源与 manifest 均放仓库外。wheelhouse 必须满足 `apps/embedding/requirements.txt` 的精确版本及 SHA256；构建只从命名 `wheels` context 安装，不联网换包或下载模型。下面为 POSIX shell 命令，`WHEELS`/`ASSETS` 分别指向外部 wheelhouse/固定资产目录：

```sh
docker build --build-context wheels="$WHEELS" -t along-routing-encoder:local apps/embedding
docker run --rm --network none \
  --mount type=bind,source="$ASSETS",target=/assets \
  --entrypoint python along-routing-encoder:local build_manifest.py --assets /assets
docker run -d --name along-routing-encoder --read-only --cpus 4 --memory 768m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount type=bind,source="$ASSETS",target=/assets,readonly \
  -p 127.0.0.1:18088:8080 along-routing-encoder:local
```

manifest 生成前须备齐固定文件及可验证许可来源；运行时核对全部文件、依赖、图和 binding，预热成功才 ready。仅一个 Uvicorn 进程、一个 ORT session、两个真实占用名额。客户端断连不等于 CPU 已停，名额只能在实际 forward 结束后释放。运行只读挂载不代表网络出口已隔离，不能把普通 bridge 冒称无出口网络。

镜像内 `/app/third-party/bge-small-zh-v1.5/` 提供模型许可全文、来源及核验依据。该目录不含权重；随服务携带模型声明不代表基础镜像、全部依赖或生产启用已经通过验收。

### 15.3 校准和评估

根入口复用生产事实/打分/编码实现；不下载模型，不覆盖已有输出目录。`INDEX`、`CALIBRATION`、`HIDDEN_HOLDOUT` 指向仓库外的冻结材料；`ENCODER` 是已经就绪的私有 origin，`MANIFEST` 指向与其 binding 相同的 Linux manifest；`CAL_OUT`、`EVAL_OUT` 必须是不同且尚不存在的外部目录。实验材料、向量和逐条报告不进入业务仓库：

```sh
bun run routing:calibrate --index "$INDEX" \
  --dataset "$CALIBRATION" --manifest "$MANIFEST" \
  --encoder "$ENCODER" --out "$CAL_OUT"
bun run routing:evaluate --bundle "$CAL_OUT/bundle.json" \
  --dataset "$HIDDEN_HOLDOUT" --encoder "$ENCODER" --out "$EVAL_OUT"
```

先锁定分组、数据哈希与全部阈值候选，再冻结 bundle 后评估未见留出；失败输出与 `run.json` 也保留在仓库外。任何 guard/parser/资产/数值/展示规则变化须生成新版本 bundle、重新校准和新留出，已暴露留出降为回归。合成质量记录不代表实际业务执行、自然泛化或启用授权；有已知实质误接的 bundle 不得开启 enforce，只能关闭或按 §12.2 保持零旁路 shadow，并保留失败等待审阅。仓库只保留实现、必要行为测试与精简验收结论。
