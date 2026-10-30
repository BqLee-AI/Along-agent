## ADDED Requirements

### Requirement: 分离额度并计量完整模型请求

仓颉 SHALL 分开累计 Run 预算、模型窗口、单次输出上限和序列化字节容量，TS 只计量/传输指定候选；计量与实际 usage 分账，未知不伪造。规则见 `docs/design/18-r2a-harness-context.md` §2–§3、§6。

#### Scenario: 独立输出与完整边缘（D8/D9）

- **WHEN** 累计余额远大于输出 cap，或完整 tools/角色/函数包装使输入达到窗口或余额边缘
- **THEN** 请求仅使用独立可行输出额度；无至少一个输出 token 的可信空间时零模型请求，不把 remaining_tokens 原样作为 max_tokens

#### Scenario: 计量不足与 usage 缺失（D8/D9）

- **WHEN** 输入只有估算/不可计量，或任次 provider 缺 usage，随后批准恢复
- **THEN** 精度如实标识，累计 usage 保持 unknown 而非零或估算，原迭代/已知账不重置；精确字节门仍生效，不宣称不可证明的窗口/费用保证

#### Scenario: 最终包装和输出截断（D8/D10）

- **WHEN** 消息正文单独合法但完整 wire/HTTP 超限，或 provider 明确窗口拒绝/length 截断
- **THEN** 诚实容量失败，不执行截断参数或静默重试；可得 usage 照实记账，不假报完成

### Requirement: 确定性投影不改变事实与调用语义

仓颉 SHALL 仅在容量压力下选择有来源的确定性观察投影，保护冻结输入和执行事实，保持真实函数配对与完整 snapshot2；TS 不替代仓颉决策。见 `docs/design/18-r2a-harness-context.md` §4–§6。

#### Scenario: 六次大观察与原事实（D8）

- **WHEN** 六个分别合法的大读取使聚合体超过 1MiB，且保护集及最小输出可容纳
- **THEN** 正式 native 后续请求有界，旧正文经合法可回取来源投影，接受结果和全部快照引用/usage/调用号不变，不提高硬门

#### Scenario: 新观察、不同版本与函数配对（D8/D10）

- **WHEN** 新结果到达，或旧调用对被投影，同路径存在不同版本、失败/部分搜索
- **THEN** 新结果先真实呈现，旧函数对整体移出且无孤立 tool/假调用；来源/版本/失败/冲突不合并成成功，观察不升级为系统指令

#### Scenario: 无法容纳保护集（D8/D9/D10）

- **WHEN** 完整冻结输入、新全文基线或其他不可省略事实自身超限，或已到引用/消息/迭代门
- **THEN** 明确容量或预算失败，不截断冻结材料、不删账、不换 slot/自动新 Run、不再调模型或工具

### Requirement: 有界批准恢复与不可变上下文策略

系统 SHALL 使用冻结的 per-Run policy 和完整 snapshot2 引用重建有界 start；只恢复显式有效批准等待点，不扩大旧 Run 权限。见 `docs/design/18-r2a-harness-context.md` §3、§6、§8。

#### Scenario: 批准后大观察恢复（D6/D8）

- **WHEN** 用户批准后显式继续，原全量观察聚合超过 1MiB
- **THEN** 先核当前决议/权限，再用全部引用的有界视图启动唯一新 attempt，不先拼超限全文、不重跑 MCP；拒绝/未知与原 apply 身份仍不绕过

#### Scenario: 旧 Run 及策略并发（D8/D9）

- **WHEN** 旧有效等待点在新执行器恢复，或部署策略后来变化/并发恢复
- **THEN** 原冻结输入/预算/allowlist 不变，策略最多补入一次且同恢复事务原子；无新增回取资格时保留唯一正文，放不下明确失败，不自动扩权

#### Scenario: 只读与取消（D1/D8/D9）

- **WHEN** GET/同入站键补读，或旧 pipe/取消后提交内部源查询、测量后的模型请求
- **THEN** 只读不创建策略或 attempt，不执行；旧或取消资格拒绝新读取/动作，不披露被撤权内容，不覆盖既成事实
