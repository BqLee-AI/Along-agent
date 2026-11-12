# 用户模型接入与 Run 绑定

## Why

现行部署级单一模型无法表达本人多个接入、默认值和历史 Run 的固定决议；用户提供地址和密钥还引入跨账户、凭据泄漏和服务端出站风险。本变更将 [提案](../../../docs/plans/model-provider-settings-api-plan.md) 纳入可审查合同，不将合同或局部实现视为已交付的 SDK、Web 或真实供应商验收。

## What Changes

- 增加本人接入、加密凭据、模型发现/手动维护、默认选择和独立连接检测；禁止回显或跨地址复用密钥。
- 新模型 Run 在接纳事务冻结选择、版本与安全展示快照；按客户端选择意图幂等，同键重放原决议；旧 Run 不猜绑定。
- 固定旧部署显式指定 owner 导入及旧等待的安全恢复/不可恢复处置；受控前向迁移，不改写历史事实。
- SDK 仅为单次模型传输，仓颉仍为唯一循环；安全出站、准确计量、流完整性和真实工具路径是发布前提，不因本合同或配置接口存在自动成立。

## 合同与范围

行为 delta 见 [conversations](specs/conversations/spec.md) 与 [agent-runtime](specs/agent-runtime/spec.md)；设计见 [design/22](../../../docs/design/22-model-provider-settings.md)，接口见 [API](../../../docs/api/model-providers.md)，数据约束见 [schema](../../../docs/schema/model-provider-schema.md)。此变更为 Proposed，归档前既有合同仍为现行基线；本变更获采纳后，design/14 的部署级固定模型和 design/18 的无 registry 约束仅适用于旧基线，不适用于新绑定 Run。无供应商目录、计费、新 Agent、自动迁移账户或未授权真实服务调用。
