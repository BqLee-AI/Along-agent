## ADDED Requirements

### Requirement: 多 owner 账户的独立有限登记

系统 SHALL 保留无 workspace 的合法账户路径，由正式本机维护明确选择目标准入账户，通过 workspaces 公共校验新增独立有限登记；不得把安装管理员作为所有登记 owner 或替新人授权管理员 root。详见 docs/design/21-invited-account-access.md §8（D1/D6/D7/D8）。

#### Scenario: 无 workspace 的受邀账户

- **WHEN** 受邀用户正式登录但没有本人登记
- **THEN** 本人工作区集合为空且无宿主 root/其他 owner 信息，账户/邮箱/会话/恢复不受阻；基础聊天仅按真实已配置依赖可用，不虚报模型或资料能力

#### Scenario: 明确选择普通账户新增登记

- **WHEN** 部署者经正式本机有限候选明确选取普通准入账户，为其准备独立有限资料目录
- **THEN** 程序使用该身份公共事实并拒绝相同/重叠物理 root，不默认管理员或整卷；原登记 ID/root/有限权限和其他 owner 归属保持，不让浏览器/模型自报 owner/root

#### Scenario: 并发编辑和分步收尾失败

- **WHEN** 登记文件/配置在维护期间改变，或文件发布/保存/reload 失败
- **THEN** 版本冲突不覆盖他人变更，账户不回滚；文件/配置/重载独立报告，释放锁/连接后才重载，显式只补未完成步骤，不重新开户或自动启动 Agent
