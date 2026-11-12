## MODIFIED Requirements

### Requirement: 固定会话与可信退出

系统 SHALL 保持固定七天会话及服务端确认撤销后清Cookie；按 [design/20 §1、§8](../../../../../../docs/design/20-goal-scoped-delegation.md) 分开授权修订、会话访问和冻结生命周期。server-owned退出/到期不取消已接纳执行，request-bound不承诺退出后继续并按原连接策略收尾；账户禁用/明确撤权阻止新动作。退出不是取消task或回滚既成效果。

#### Scenario: 七天过期与只读重登（D6/D8）

- WHEN 反复读取页面后到固定期限再访问并重登
- THEN GET不延长会话，过期401；同owner重登只读原事实，不重发业务POST、不创造新运行

#### Scenario: 正常退出与已接纳委托（D6/D8/D9）

- WHEN 用户正确会话/Origin/CSRF提交退出，服务端确认PG撤销，且读取到原Run的冻结生命周期
- THEN 清Cookie且旧Cookie访问/me为401；server-owned只断订阅不撤委托，request-bound仍按原连接策略收尾，不因delegation/1宣称后台继续；都不取消既成提醒或回滚偏好/文件

#### Scenario: 撤销依赖失败（D6/D8/D10）

- WHEN 会话撤销失败或提交结果未知，即使认证库报告success
- THEN 返回真实依赖错误，不伪报完整退出或先清Cookie；明确再次操作核对事实，不以本地状态代替撤销

#### Scenario: 账户禁用（D6/D8/D9）

- WHEN 已接纳委托运行期间owner被disabled或明确资源撤权
- THEN 阻止后续新动作，保留既成/未知效果，不把禁用等同普通session轮换，也不披露已撤权内容

## ADDED Requirements

### Requirement: 本人默认时区真实保存与清除

identity SHALL 拥有本人默认时区的窄公共用例；新profile按 [design/20 §4.1、§6.1](../../../../../../docs/design/20-goal-scoped-delegation.md) 在明确委托内直接保存/清除，与工具接受结果/审计原子提交，返回真实事实而非提议或虚构记忆；不开放任意账户patch或宿主配置。

#### Scenario: 同一委托保存并使用（A1/D4/D8）

- WHEN 用户让记住上海时区并按它建立明确提醒
- THEN 无二次批准真实保存，后续尚未冻结动作可引用刚接受的设置回执，后续请求也可读真实值；写或结果失败全回滚

#### Scenario: 单次时区和清除（A4/D2/D8）

- WHEN 用户只这次按纽约，或明确清除本人默认时区
- THEN 单次不改偏好，清除返回真实null且后续动作不沿被清除值；本次明确值优先于设置回执/接纳偏好，旧task/approval不改

#### Scenario: 非本人或越界设置（D1/D6/D8）

- WHEN 模型带owner/任意账户字段或资料自行要求改偏好
- THEN 拒绝确定性越界，摘要委托不执行额外设置；消息ID/hash不是语义授权证明，未知/不支持时区不静默保存为别处
