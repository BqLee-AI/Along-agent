## ADDED Requirements

### Requirement: 历史上下文片段不替代完整基线与新回读

系统 SHALL 区分 context_slice、原完整 workspace_read 和 apply 后新的全文读取；投影/回取不能改变精确批准、唯一 apply、零写 conflict 或 unknown 效果规则。见 `docs/design/18-r2a-harness-context.md` §4、§7–§9 与 `docs/design/14-r1-document-task-loop.md` §4–§7。

#### Scenario: 旧片段帮助精确修改（D6/D8）

- **WHEN** 模型从旧观察回取 old_text 后提出精确替换
- **THEN** 提案仍须引用同 Run 原完整 read，TS 核对完整基线/唯一匹配/当前版本，context_slice 引用不能作全文基线；完整目标和无关原字节不由投影改写

#### Scenario: apply 后回取旧事实（D8/D10）

- **WHEN** apply 已接受后模型仅回取旧读或旧片段并声称完成
- **THEN** 不满足 verified/done，必须 apply 后新创建且接受的真实 workspace_read 核对产物；批准本身仍零写且不算效果

#### Scenario: 大资料真实任务与错误事实（D6/D8/D10）

- **WHEN** 正式模型处理至少六份大资料、冲突日期与一次读取失败，发生投影/原来源回取后批准继续
- **THEN** 原 Run 以真实证据查证并唯一写入/新回读，保留冲突与失败的区别；unknown 不重写、不转成功，小任务不因新增机制无谓增加模型调用
