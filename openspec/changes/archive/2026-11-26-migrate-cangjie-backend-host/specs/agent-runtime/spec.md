## ADDED Requirements

### Requirement: 仓颉生产宿主拥有入口与运行编排

生产部署 SHALL 由仓颉接收 HTTP/SSE 请求、编排 Run 生命周期并驱动 Worker；用现有公开合同及已核验的 PostgreSQL 事实决定对外事件和副作用。见 design/08 §2–9、design/09 §1–8、design/10 §1–6。

#### Scenario: 聊天提醒经真实入口完成

- **WHEN** 用户通过生产 HTTP/SSE 入口请求一个具备执行资格的到点提醒
- **THEN** 仓颉 SHALL 接收请求并编排 Run，仓颉 Worker SHALL 推进到点投递，最终状态 SHALL 由独立回执支撑

#### Scenario: SSE 断开后的行为与补读

- **WHEN** 用户断开流连接后使用既有游标重新连接
- **THEN** 请求绑定和服务端所有权的 Run SHALL 各自保留其既有取消与继续语义，并按公开游标返回可披露事件

### Requirement: 服务交接保留持久执行权与回执

升级、重启和回滚 SHALL 保留已验证的授权、排空、恢复和唯一写入权限语义，继续使用 PostgreSQL 已提交的事务事实。见 design/08 §2、§7–9、design/09 §4–6 和 design/15。

#### Scenario: Worker 重启遇到已经投递的任务

- **WHEN** 旧 Worker 退出，新 Worker 处理具有投递回执的任务
- **THEN** 新 Worker SHALL 按现有回执推进状态，旧执行权 SHALL 无法重复提交该效果

#### Scenario: 历史 Run 在切换后继续

- **WHEN** 支持范围内的旧 Run 在服务切换后从合法等待点继续
- **THEN** 服务 SHALL 核验原执行权、资格和回执，恢复原目标、预算和协议语义，保持以前接受的效果
