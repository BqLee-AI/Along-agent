## ADDED Requirements

### Requirement: PR 模板证据化

系统 SHALL 以 `.github/PULL_REQUEST_TEMPLATE.md` 要求每个 PR 回答行为变化、兼容迁移、证据与边界：保留关联/Spec/验收证据/Deferred/OpenSpec，并新增 Before/After、Compatibility & Migration、Verification（含未跑项）、Reviewer focus、Checklist、AI assistance。引用 `docs/design/13-p0-bootstrap-and-ci-rules.md §3` 与 `CONTRIBUTING.md §5`。

#### Scenario: 行为变化可读

- **WHEN** reviewer 打开任一 PR 正文
- **THEN** 能在 Before/After 看到行为变化一句话与前后对比，无需翻 diff 猜意图

#### Scenario: 证据边界明确

- **WHEN** reviewer 检查 Verification 段
- **THEN** 能看到跑了什么（CI 链接/测试输出/变红测试）与没跑什么+原因，无"测试通过"空话

### Requirement: Issue 模板可验收

系统 SHALL 以 `task.md` 要求每个任务 issue 写证据边界与可观察验收，以 `decision.md` 要求写 alternatives、验证证据、reopen 条件，并新增 `config.yml` 指引空 issue/Discussions/Security。引用 `docs/README.md`（文档分层）。

#### Scenario: 任务可验收

- **WHEN** 读任一 task issue 的验收段
- **THEN** 每条验收是可观察行为（映射 D/A 或 A-治理），非空勾选框

#### Scenario: 决策可重开

- **WHEN** 读任一 decision issue
- **THEN** 有备选方案、验证证据与 reopen 条件，结论变更有路径

### Requirement: 合并门文档化

系统 SHALL 在 `CONTRIBUTING.md §8` 文档化 required checks 清单（gate-manifest、lint、depcruise、unit、migration-scan、scheduler-fault、contracts-dual、compose-smoke 8 个 job）与 reviewer 打回规则（无证据/未声明未跑项/无 Spec 引用直接打回）。引用 `docs/design/13-p0-bootstrap-and-ci-rules.md §3`。

#### Scenario: 打回有据

- **WHEN** reviewer 面对无证据或未声明未跑项的 PR
- **THEN** 可引用模板字段与 §8 规则打回，不进入代码细节评审

#### Scenario: 门禁可查

- **WHEN** 新人要合 PR
- **THEN** 在 CONTRIBUTING 能查到 8 个 required checks 名称与含义，无隐藏门
