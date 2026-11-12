# 模型接入数据合同

> Proposed；[设计](../design/22-model-provider-settings.md)与 [OpenSpec](../../openspec/changes/add-model-provider-settings/proposal.md) 描述目标，非已部署 schema。仅追加迁移，不修改既有迁移。具体 DDL、索引名与错误码以实施后的可审查迁移和 contracts 为准，下列约束不可因实现省略。

| 关系                          | 职责及必要约束                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model_providers`             | 本人拥有的接入身份、名称、启用状态及当前版本；更新/删除须 owner 限定，删除不可破坏历史显示                                                                                   |
| `model_provider_versions`     | 每次配置变化产生独立版本；关联 owner/provider，保存 endpoint 与 AES-256-GCM 认证密文和解密所需非秘密参数，AAD 绑定 owner/provider；clear/delete 可撤销旧凭据，replace 不撤销 |
| `model_provider_models`       | 按 owner/provider 保存完整、区分大小写的 ID；同 provider 同 ID 唯一；同步合并不删手工项                                                                                      |
| `model_provider_defaults`     | 每个 owner 至多一个选择；事务内校验该 owner、provider 启用且模型存在；禁用/删除/移除默认模型同事务清空                                                                       |
| `model_provider_run_bindings` | 一 Run 至多一行；`run_id,owner_id,version_id,provider_id,provider_name,model_id`，引用的 Run、版本和接入必须同 owner；不可变决议与接纳时展示快照独立于当前 provider 存续     |

加密材料为进程外部提供的 `MODEL_PROVIDER_ENCRYPTION_KEY`（base64 的 32 字节），不存 DB。非秘密展示快照不含地址、密文或 Key；旧版本只保留旧 Run 恢复所需材料，撤销后不得借当前版本替代。提供不带 Key 的服务端投影，不允许跨模块绕过 owner 自读秘密。

新模型 Run 的接纳、原 `run_context_policies` 和绑定在同一事务提交；校验冻结策略 `model_binding.model` 与版本解析的 model 及 adapter 一致。原策略仍严格为 `{model,adapter_revision}`，不修改其只追加约束，不改旧 checkpoint、预算、身份或历史工具事实。business 不建绑定。历史无绑定不能推断；独立快照在改名、停用、删除后保留。并发写入/删除/同步须保证选择与版本决议一致；同步不持事务等待网络，提交前重新核对原版本。

旧部署导入必须管理员明确选择一个 owner，禁止无证据回填旧 Run；不可证明安全恢复的等待明确不可用，历史仍可读。停旧写者后前向迁移、故障停写及新事实产生后的回滚限制见设计 §4。
