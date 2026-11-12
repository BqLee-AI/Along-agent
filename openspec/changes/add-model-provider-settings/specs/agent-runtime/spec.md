## ADDED Requirements

### Requirement: 安全的单次模型传输

模型传输 SHALL 仅执行仓颉请求的单次模型调用，不成为第二个 Agent 或执行工具；推理、同步和检测必须采用一致且可验证的出站控制。SDK 引入不豁免已有流、预算、取消、工具和恢复合同，见 [design/22](../../../../../docs/design/22-model-provider-settings.md)。

#### Scenario: 不可信地址和重定向

- **WHEN** 普通用户配置 endpoint，DNS、重定向或实际连接试图访问本机、私网、link-local 或云元数据
- **THEN** 默认拒绝；仅部署者针对明确本地目标有限放行，实际连接和跳转均重新受控，不能以同步或测试绕过策略

#### Scenario: 受信任 Fake-IP DNS

- **WHEN** 部署者为精确 HTTPS origin 配置 Fake-IP 例外，DNS 返回 `198.18.0.0/15` 地址
- **THEN** 仅允许该 origin 的此网段地址并固定连接，仍校验原域名 TLS；其他域名、端口、HTTP 和私网或元数据地址不得借此放行

#### Scenario: 禁止公网明文模型通信

- **WHEN** 模型同步、检测或推理使用 HTTP 地址且目标不是部署者显式放行的本地 IP origin
- **THEN** 出站边界在发送凭据或请求内容前拒绝；公网模型地址使用 HTTPS

#### Scenario: 流、计量和异常

- **WHEN** 供应商流截断、缺真实终止符、损坏 UTF-8、超限、无 usage 或中途取消
- **THEN** 严格区分真实完成、失败与未知，不能伪造成功或 usage；发送前计量对应实际发送字节，纯计量不发请求，不能隐式 SDK 重试

#### Scenario: 多工具提议

- **WHEN** 单次响应违背请求返回多个工具提议
- **THEN** 不执行任何提议，由现行 native 行为在原预算内要求逐项选择；真实工具授权、接受效果和取消边界不变

#### Scenario: 测试未保存配置

- **WHEN** 用户检测未保存地址或测试模型能力
- **THEN** 新地址仅可使用明确新 Key 或明确不发送 Key；使用合成内容且不创建 Run、不发历史、不调用业务工具，各项未测保持未测，失败不泄露原始 provider 内容
