# 设计导航（Proposed）

完整设计集中于 [docs/design/21-invited-account-access.md §1–§9](../../../docs/design/21-invited-account-access.md)，不在此维护第二份状态机或参数表。路由/DTO/错误在 auth API §5；字段/索引/事务在 identity schema 的 #112 Proposed 章节；外部未知由 PRD 待决表集中管理。

本 change 只提出行为增量，不改变有效 `openspec/specs/` 或 design/16 Required。identity 拥有准入、邮箱、一次凭证、密码与会话、窄管理和专用邮件；workspaces 拥有多 owner 有限登记；scheduler-delivery 拥有当前资格下的新发送许可；notifications 拥有独立接收。后三者不是通用授权重构，也不重写 conversations/#104 的 Run 生命周期。

推荐保留 Better Auth 1.7.10 密码/库 Cookie 与原 PG adapter，独立加密真实邮箱，不把库 auth_email 变为邮件字段。接受/恢复不自动登录，PG 提交未知不发布新/清 Cookie；邮件接受未知不盲重投。选项、锁序、TTL、配额、前向升级与可观察验收见唯一设计真源。

P0 合同、库/PG 实验、外部真实邮件/HTTPS 和 P1 完整旅程分别举证。tasks 中勾选文档起草不等于合同获批或行为已上线；P1 全部未实施。新事实后前向修复，不预占迁移号、不改旧迁移/原安装/认证 secret。只有完整验收后才独立归档和关闭 #112。
