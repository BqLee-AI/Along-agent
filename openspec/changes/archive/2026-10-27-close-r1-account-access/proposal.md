Issue: #68

## Why

R1 本地生命周期已提供稳定入口，但正式 credential 登录链尚未接入生产。seed 每次建新用户，不能解决原身份会话到期后的续登；只补表单或挂载整个 Better Auth handler 会遗漏原 owner、并发开户、撤销和登记收尾边界。

## What Changes

- 定义单租户唯一管理员与空安装原子开户；存在历史 owner 时禁止匿名接管。
- 有旧签名会话仅转正当前 owner；无会话由正式本地维护入口明确选原用户，保留 users.id、历史、任务、批准与工作区，不批量合并或覆盖已有 credential。
- 复用锁定 Better Auth 密码/Cookie、现有 HMAC resolver；补齐真实事务、标准字段/UUID、token 返回形状与可信撤销。
- 增加状态、初始化、转正、登录、退出窄 API 和账户页面；正式 proxy 保真，401 重登后只读恢复，不重放业务 POST。
- 账户提交与本机登记/配置/重载分开报告和显式收尾；复用 #67，不自建宿主 daemon，不要求手填 owner ID。

## Spec

- [design/16](../../../../docs/design/16-r1-account-access.md) §1–§8 是设计真源；[auth API](../../../../docs/api/auth/auth_routes.md) §4、[identity schema](../../../../docs/schema/identity-schema.md) 的 R1 合同同步。
- 行为增量为 identity；保留业务鉴权、session-bound CSRF、owner 隔离、精确批准、取消、unknown 及 #67 升级边界。
- 只新增下一序号迁移及对应版本核验/identity 扫描规则，不改旧迁移。

## Capabilities

### New Capabilities

- identity：唯一管理员、原身份转正、正式 credential 会话及可验证的本机收尾。

### Modified Capabilities

无；沿用 local-lifecycle、workspaces、agent-runtime、tool-gateway 与既有 gates，不重定义业务状态机。

## 非目标 / Deferred

本 PR 只交付合同及规划，不实施认证代码、SQL、账户页面或本机维护命令，不操作用户库/私有配置，不读取凭据、不运行模型，不 archive、不关闭 #68/#66。库兼容风险尚未真实复现，隔离实验在后续获准单元进行。

公开注册、多租户/RBAC、OAuth/SSO、邮箱验证/找回、滑动续期、历史发现、全站视觉/MVVM、R2、市场/推送/计费不在范围；不更换已授权 provider/model/路由。
