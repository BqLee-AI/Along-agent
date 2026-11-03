## ADDED Requirements

### Requirement: 独立通知接收的当前账户资格

notifications SHALL 在独立接收事务提交新内容前经 identity 公共用例核验准入/active，并与停用的用户写权串行裁决；保留既有 owner/task/发送键绑定、独立提交与只读回执核对，不因身份变化改写历史或伪造发送结果。详见 docs/design/21-invited-account-access.md §7（A3、D1/D3/D9）。

#### Scenario: 停用后新接收被拒绝

- **WHEN** 普通用户停用/注销请求已提交，而新的 in-app 接收尚未取得用户共享资格锁
- **THEN** 不插入新通知或接受回执，即使 scheduler 曾读过 active；不返回 delivered 成功、不把旧任务改 cancelled，不以缓存身份放行

#### Scenario: 已提交接收与回答丢失

- **WHEN** 接收先提交而随后停用，或接收回答丢失、worker 结果事务回滚/重启
- **THEN** 原匹配接收事实保留并可经公共 service 只读核对，不删除/改 owner、不重演 provider，不因停用谎称从未发送或凭唯一行宣称恰好一次调用

#### Scenario: 独立连接无锁环及依赖失败

- **WHEN** scheduler 持原 task/outbox 栅栏调用独立接收，同时发生停用，或资格公共用例失败
- **THEN** 接收只持相容的用户 SHARE 门且不取 task 写锁，identity 不反向锁业务对象；不存在父事务持用户独占锁等待接收的死锁，依赖失败不提交新通知或伪造成功
