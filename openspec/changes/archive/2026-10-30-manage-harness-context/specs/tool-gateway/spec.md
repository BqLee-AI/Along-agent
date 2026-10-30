## ADDED Requirements

### Requirement: 同 Run 原接受观察的受控回取

系统 SHALL 通过同一 ToolGateway 提供有界原接受事实读取，使用新持久调用、当前权限及原接受版本，不重新执行原操作；内部装配不能成为模型免预算回取。接口见 `docs/design/18-r2a-harness-context.md` §6–§7。

#### Scenario: 来源后续改变与分页（D8）

- **WHEN** 已接受只读结果的当前文件改变，模型按来源读取原正文或数组分页
- **THEN** 返回原接受版本、单位/范围/total/has_more 与确切内容；整结果遵守页字节门，UTF-8/Unicode 不损坏、数组稳定，不重调 MCP 或把当前文件当旧结果

#### Scenario: 来源资格拒绝（D1/D8/D9）

- **WHEN** 来源跨 owner/Run、未完成未接受、当前撤权、旧 attempt 或取消先提交
- **THEN** 拒绝且不披露存在性/内容，不返回空页伪成功，不新执行原操作；旧 Run 冻结 allowlist 不因升级自动扩权

#### Scenario: 新调用与不可递归来源（D8/D9）

- **WHEN** 模型请求回取、重放同引用或试图以 context_slice 再切片
- **THEN** 新动作按既有调用号/64 引用/预算审计接受，同引用重放原页；递归来源明确拒绝为不支持，不能生成免费重放链或绕网关读取

### Requirement: 投影保留失败与不可变来源

TS SHALL 从可信接受账生成投影元数据，不把省略字段伪装为空结果、完整搜索或新执行；来源损坏不能靠回读当前文件修复。见 `docs/design/18-r2a-harness-context.md` §4、§7–§8。

#### Scenario: 部分搜索和不同版本（D8/D10）

- **WHEN** 搜索含逐文件 failures，同路径多个接受版本被投影
- **THEN** 保留失败数量、不完整性和各来源身份，原 matches/failures 可回取，不称零匹配/穷尽，也不合并版本或冲突日期

#### Scenario: 超大元素与缺失来源（D8/D10）

- **WHEN** 单元素无法放入页，或可信已接受引用的底层结果损坏/缺失
- **THEN** 前者明确 range_too_large，不返回半元素或无进展下一页；后者协议失败，不以空结果、摘要或当前版本替代原事实
