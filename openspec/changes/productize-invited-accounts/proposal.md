Issue: #112

# 受邀账户、联系邮箱与恢复

## Why

现行 Required 只允许绑定管理员正式密码登录，库 auth_email 是不可投递的句柄。给第二人插入 users/credential 或给管理员加邮件表单不能交付独立账户旅程；准入、恢复、会话并发、停用后的新投递与旧安装兼容必须先有可评审合同及真实库/PG 证据。

## What Changes

- 以 identity 显式准入且 active 取代“仅管理员登录”，安装管理资格不授予其他 owner 的资源读取权；保留原身份、credential、secret、空安装防接管及固定七天会话。
- 提议独立加密真实邮箱、用途分离 HMAC/规范化唯一，邀请/验证/恢复的一次凭证、代次/TTL、事务竞争、幂等和匿名失败/持久限流；邮件仅在提交后发送，接受未知不盲重投。
- 提议本人验证/换绑、库改密/恢复、本人会话撤销、普通账户停用/注销请求和唯一管理员保护；阻止停用后尚未获得许可的新投递/通知接收，保留既有回执与 unknown。
- 保留无 workspace 合法路径，明确本机选择普通 owner 的有限登记、正式 proxy/Origin/CSRF、401 只 GET 恢复和旧安装前向升级。

## Spec

设计真源：[docs/design/21-invited-account-access.md §1–§9](../../../docs/design/21-invited-account-access.md)；路由/DTO：[auth API §5](../../../docs/api/auth/auth_routes.md)；字段：[identity schema 的 #112 Proposed 章节](../../../docs/schema/identity-schema.md)。依据为 #112 与规划 §1–§4、§7–§9、§11，不把 Proposed 规划升级为有效合同。

行为 delta：identity、workspaces、scheduler-delivery、notifications。后三者分别拥有多 owner 登记、发送许可和独立接收的真实跨模块增量；不复制字段/路由表，不改写 #104/#105 的运行/授权合同。

## 生效与交付

本 change 为 **Proposed（待评审，不生效）**。P0 只交独立合同与锁定 Better Auth 1.7.10/真实隔离 PG16 可行性、外部前置证据；不改生产代码、依赖、迁移、原安装或有效 `openspec/specs/`。P1 仍未实施；真实邮件/生产 HTTPS/密钥托管/保留批准未齐不得放行邀请。任务与证据按层分列，合同或实验合并不关闭 #112，不提前 archive。完整实现、真实双用户/旧安装/隔离验收和独立收口后才归档。

## 非目标/Deferred

无公众注册、多组织/RBAC、管理员代登录/代改他人口令、物理删用户、管理员交接、第三方登录、飞书/办公连接、营销邮件、推送渠道、计费或供应商采购。不用原安装、现有凭据或 `.env*`，不改认证 secret/历史 owner/旧迁移，不预占迁移号，不改模型路由，不接管 #104/#105/#107/#108，不启用全量库 handler、不手写密码/Cookie。
