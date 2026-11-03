## ADDED Requirements

### Requirement: 当前账户资格裁决新发送许可

scheduler-delivery SHALL 在原 task/outbox 发送栅栏内，经 identity 公共资格读取与停用事务串行裁决新的发送许可；无准入/不活跃或资格依赖不可核验不得取得新许可。不得复制身份存储规则或把停用变成任务取消。详见 docs/design/21-invited-account-access.md §7（A3、D1/D3/D9）。

#### Scenario: 停用先于发送许可提交

- **WHEN** 停用/注销请求先持用户写权且提交，另一个进程随后在真实 task/outbox 锁下申请发送许可
- **THEN** 新许可与 provider 调用增量为零，确定未调用的发送工作按脱敏无资格事实收尾；不把 task 标 cancelled/fired、不制造撤销回执，原窗口规则保持

#### Scenario: 许可先提交但后来停用

- **WHEN** 发送许可先于停用提交，调用可能在途或已经外部接受
- **THEN** 保留已许可/在途/unknown 真相，不承诺已追回；调用前原取消/时间栅栏仍执行，不允许借身份变化重新领取或重演 provider，已接收事实可只核对

#### Scenario: 资格读取故障与锁序

- **WHEN** identity 公共资格读取失败，或 scheduler 持 task/outbox 栅栏并发独立 notifications 接收和 identity 停用
- **THEN** 故障 fail closed、不当 active、不新增许可；用户 SHARE 门与独立接收相容、停用不反向取 task/Run 锁，无锁环，原取消优先/回执/unknown 不重发保持
