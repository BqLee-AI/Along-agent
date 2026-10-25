## 1. 合同与真实能力前提

- [x] 1.1 planner 沿实际 Web/TS/工具/批准/Run/SSE 链核对现状，明确 #46 I1–I6 与 #47 的职责、fixture 和真实模型证明边界；仅静态规划，不冒称运行验收。
- [x] 1.2 官方 SDK1.0.5/stdx1.0.5.1 实际编译 native 并通过中文/分片/合并 JSON 行、flush、EOF、顺序 cancel/SIGTERM；目标 Bun 镜像运行通过。裸 runtime fresh 编译缺 ar 已记录，版本/hash 与 builder 前置已明确；生产有界解析、模型中取消及 fresh builder 留正式验收，不冒称已通过。
- [x] 1.3 reviewer 独立审查四文件 spec-only，严格校验与既有五门通过后以 Refs #46 合并，不提前关闭 issue（PR #59，20cd203；实现审查另行取证）。

## 2. TS 可信运行与公共业务端口

- [x] 2.1 五工具涉及的 tasks/brief/identity 读取归所属模块公共 query-client 用例或明确只读投影，复用 #45 事务和原输出；删除网关跨模块私有 SQL。
- [x] 2.2 持久化服务端工具范围、启动上下文和有限等待引用，扩展只追加内部快照；新鲜/历史升级/失败回滚，不伪造旧 Run 快照或接受结果。
- [x] 2.3 实现可信 Run/attempt 绑定与状态提交：当前权限、取消、终态、消息及 SSE 投影原子裁决；旧 attempt 不能继续写，取消不能被后到 done 覆盖。
- [x] 2.4 实现等待批准及 owner-scoped Run 读取/取消/恢复；同一等待点最多一次有效恢复，原 Run/slot/invocation/批准不变，拒绝不绕路。
- [x] 2.5 事件补读过滤内部快照，保留既有七事件合同、游标/幂等与终态唯一性；等待结束传输不被当成取消。

## 3. 正式仓颉核心与集成

- [x] 3.1 正式仓颉工程实现循环、上下文/工具观察纳入、工具提议解析、预算、等待/恢复、停止；受控响应仅替换模型传输，不替换状态机。
- [x] 3.2 实现 TS 固定产物子进程适配及严格有界双向协议，最小环境不传 TS 数据库/认证凭据；无隐式 TS Agent 或 fixture 生产回退。
- [x] 3.3 root scripts、相关 CI 和生产镜像显式构建/打包原生产核心，不消费旧产物、不以可选 skip 掩盖缺工具链。独立 fresh builder 及完整生产镜像构建通过；正式根脚本又实际导出约10.86MB闭包（命中native构建缓存），二进制 SHA256 bccb4432…d1085b 与真实集成所用产物一致。隔离运行库启动后的空输入以 HARNESS_PROTOCOL_ERROR/exit2 拒绝，未把空输入失败当合法执行；正式协议行为由 native/HTTP/PG 验收覆盖。当前 HEAD 五门仍由收口 PR 外部检查验真。
- [x] 3.4 Web 进入正式仓颉路径、显示等待/停止/继续，批准后显式恢复同一 Run；代理真实 request-abort/reader-cancel 各有 HTTP 关闭证据，实际页面停止还观察到模型响应关闭。

## 4. 真实验收与收口

- [x] 4.1 I1（A2/A4、D1/D6）：伪造 owner/allowlist、跨 Run 调用、旧 attempt 均拒绝；真实结果不泄露、零越权副作用，不只测试参数转发。
- [x] 4.2 I2（A2/A4、D6/D9）：真实事务屏障证明取消先提交后无新工具效果，工具先提交不伪撤销；仓颉停止安排，迟到终结/快照不能覆盖取消。
- [x] 4.3 I3（A2/A4、D2/D3/D6）：真实提议→等待→冻结按钮确认/拒绝→同 Run 新 attempt；重复恢复、丢恢复回答及同等待点新键均不重复动作，拒绝/过期/替代不绕批准。
- [x] 4.4 I4（A2/A4、D6/D8）：GET/同入站键只补读，不启动仓颉/新增 attempt；内部快照不污染 SSE，只有有效等待点可显式恢复。
- [x] 4.5 I5（A2/A4、D1/D2/D3/D5/D6/D9/D10）：冻结确认、typed 时间错误、只追加事件/审计、取消与回执门、#45 已接受结果/unknown 规则不变；真实入口及独审缺陷先 Red 后 Green，环境/编译失败不计 Red。Linux Bun1.4.2/PG16 全量198测试、25文件、1399断言通过；15迁移及真实psql结构/只追加SQL合同通过。目标 Red 包括显式 business400、取消流缺已存回执、终态锁死锁、回答超过4000及取消reason边界；夹具 eager matcher/缺生命周期接口/旧schema调用新writer不冒充生产缺陷。
- [x] 4.6 I6（A2/A4、D8）：真实浏览器/签名会话/CSRF，经 Next→TS→本次构建仓颉→TS 工具→PG→SSE/批准页回读。真实 PG snapshot advisory 屏障下先开批准新页并确认，原流保持、仅一 task；释放后同 Run attempt2 完成，模型观察包含真实 task ID。原请求重试、刷新/GET 不增加 task/model 调用；拒绝后无新 task/提议；显式停止持久 cancelled 并关闭未完成模型 HTTP。开发桥接 null-CSRF 的 business 提议/拒绝也通过，正式签名请求保留 CSRF。原继续请求为受控浏览器换 tab 搬运同一 checkpoint/key，未造新请求；不把该操作冒充自动跨 tab 恢复。Web 6测试/13断言通过。证据仅覆盖正式核心+受控模型传输，不覆盖真实 provider、完整 R1 或通用产物。
- [x] 4.7 更新长期 design/API/schema/agent/PRD/索引及构建运行说明；独立实现 reviewer 五项缺陷修复后 focused 复审无剩余发现。根 verify 10步骤全通过（189测试/26文件/876断言；503模块/1232依赖无越界），contracts16测试/50断言及完整integration198测试/1399断言通过。当前 HEAD 五门的最终结果以收口 PR 外部检查为权威，不预写通过。
- [x] 4.8 archive change 并同步主 spec。收口 PR 须 Closes #46 并提供验收证据，合并要求当前 HEAD 五门全成功；远端合并、issue关闭和本次资源清理以 PR/交付记录为准，不在待合并提交中预写发生。

#47 在独立任务中消费本合同：同一根契约入口真实构建/运行正式仓颉，覆盖成功/拒绝/取消/重复/unknown 和必要步骤缺失变红，才提升精确声明范围的 D8；不将本 tasks 的完成当作 #47 已验收。

## 验证记录（实现快照；最终 CI 以 PR HEAD 为准）

- 策略：未知 SDK/stdio/运行库先真实探针，再正式 native。最终源 SHA256 `bccad7214d85ec0502610be684de57588d8114fa0691809fd4b15c253ce53908`，正式二进制 SHA256 `bccb44325376f79160821ef03a42d7c56999e79bb856e84b1d90a0bb2fd1085b`。历史叶探针32项中 consumed-only 项随错误约束删除而失效，该记录不视作最终32项重跑；最终二进制另有6项恢复证明。
- 缺陷先行：独审对应的真实终态双写锁升级、两种长回答、分块间取消、取消 reason 超限在旧源0通过/5失败；修复后同模式及既有锁竞争9通过/84断言。Web null-CSRF 在真实 dev `/me` 为200/null而旧 SessionSchema 拒绝；实际页面另暴露成功 envelope `error:null` 解析失败，随后统一公共合同。早批准导航只记录修复后的真实屏障 Green，不冒称独立导航 Red。
- 全量：最终 Windows 根 verify10步骤/189测试全通过；完整 contracts16/50通过。Linux Bun1.4.2、PG16、正式 native 的 root integration入口198测试/25文件/1399断言通过；15迁移及真实psql结构/只追加SQL合同通过。全量已含调度故障，不重复单跑scheduler。模型传输另有真实HTTP5测试/8断言；Web实际HTTP6测试/13断言。
- 夹具/类型失败不作生产 Red：旧 SSE 假响应缺 once/off、0014-only fixture调用latest writer、Bun eager matcher在释放业务屏障前等待、旧mock-fetch取消timeout、Web目标lib不含全局PromiseWithResolvers。分别修复夹具生命周期、迁移分段、等待顺序、真实HTTP取消及局部测试结构类型；最终统一入口验真。
- 范围：真实浏览器观察正式签名会话/CSRF、native→TS工具→PG结果、早确认后同Run继续、拒绝、原请求重试/只读刷新和持久停止后模型响应关闭；受控响应仅替换模型HTTP，不替换仓颉循环。未覆盖真实provider/MCP、完整R1、通用产物、任意checkpoint/无人值守崩溃恢复、COMMIT回答不确定窗口、性能/DoS/TLS或生产部署。D8仍partial，#47独立验收。
- 临时浏览器会话、fixture schema、服务、标签页和driver已清理；原始诊断不纳入版本库。其余本次构建/数据库资源的最终清理以交付记录为准。
