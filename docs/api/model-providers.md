# 模型接入 API

> Proposed：关联 [OpenSpec](../../openspec/changes/add-model-provider-settings/proposal.md)、[设计](../design/22-model-provider-settings.md)；本表不证明路由或 SDK 已上线。Base Path `/api/v1`；统一 envelope，成功 `data` 如下。所有端点响应包括错误均 `Cache-Control: no-store`；GET 需签名会话，POST 和会发外部请求的动作还需 session-bound CSRF、Origin 与既有 body 收集前门禁，strict JSON，不接受 owner 字段。

`Provider = {id,name,enabled,base_url,has_api_key,key_hint,models}`；ID 为 UUID，model ID 为区分大小写的不透明完整字符串，`key_hint` 可 null、非敏感，`has_api_key` 不证明有效，允许无 Key 端点。不得回显完整 Key。`Selection = {provider_id,model_id}`。

| 方法/路径                                                   | 请求                                      | 成功 data                                                     |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| GET `/model-providers`                                      | —                                         | `{items:Provider[],default_selection:Selection                | null}`        |
| POST `/model-providers`                                     | `{name}`                                  | 未配置的 `Provider`                                           |
| POST `/model-providers/{provider_id}/actions/update`        | `{name?,enabled?,base_url?,credential?}`  | 更新后的 `Provider`                                           |
| POST `/model-providers/{provider_id}/actions/delete`        | `{}`                                      | `{deleted:true}`                                              |
| POST `/model-providers/{provider_id}/models/actions/sync`   | `{}`                                      | `{provider:Provider,added_model_ids:string[]}`                |
| POST `/model-providers/{provider_id}/models`                | `{model_id}`                              | 更新后的 `Provider`；重复不增加                               |
| POST `/model-providers/{provider_id}/models/actions/remove` | `{model_id}`                              | 更新后的 `Provider`；使用 body 以保留 `/` 等字符              |
| POST `/model-providers/{provider_id}/actions/test`          | 可选 `base_url`、`credential`、`model_id` | `{text_stream,tool_round_trip,usage}`，每项 `{status:'passed' | 'failed'      | 'not_tested',latency_ms:number | null}` |
| POST `/model-selection/actions/set-default`                 | `{selection:Selection                     | null}`                                                        | `{selection}` |

`credential` 为 `{action:'keep'}`、`{action:'replace',api_key:'…'}` 或 `{action:'clear'}`；省略等同 keep，空输入不删除。修改地址不可静默将旧 Key 发往新地址；未保存地址的检测必须显式提供新 Key 或明确不发送 Key。同步只使用已保存配置、网络前后比较版本，失败不删除模型；检测用合成内容，不创建 Run、不发历史或调用业务工具。未提供 `model_id` 时三项均为 `not_tested`；有模型时按实际执行的文本流、合成工具往返与 usage 结果分别报告，检测整体无法完成返回脱敏失败 envelope。列表出现模型不保证 Key 具有调用权限或流式/工具可用。

公网模型地址仅支持 HTTPS；HTTP 仅用于部署者显式放行的本地 IP origin。出站前统一拦截不符合条件的地址，不发送 Key 或对话内容。

默认只允许本人已启用接入中的模型。删除/停用默认接入或移除默认模型与清除默认同事务；不挑替代。认证失败 401 `UNAUTHENTICATED`，跨 owner 403 `FORBIDDEN`，本人资源不存在 404 `NOT_FOUND`，字段无效 400 `VALIDATION_ERROR`，版本竞争或选择失效 409 `STATE_CONFLICT`。连接失败、鉴权失败、模型列表不支持、不兼容响应和超时须能以稳定脱敏类别区分；具体错误码及 numeric code 未经 contracts 确认前不在此虚构。不得返回原始 provider body、header、请求内容或 SDK 异常。

检测发生脱敏连接/鉴权/超时等错误时不会返回上游原文或草稿密钥；有模型 ID 但模型 transport 未配置时返回 `503 NOT_READY`。草稿请求的 Key 不持久化，地址或凭据也不改变已保存配置。生产推理与检测使用同一 SDK 工厂和受控出站路径。

`POST /conversations/messages` 的模型 Run 新增可选 `model_selection:Selection`；省略仅在首次接纳事务读取本人默认，旧客户端不需新字段，但未配置默认时需明确选择。business 行为不变。显式选择进入请求哈希，省略保持旧哈希；同键同意图直接重放原 Run 的已持久事件，不再解析当前默认或检查接入是否仍可新选，不因原 Run 为 running 而拒绝重放；同键换意图冲突。重放是只读原 Run 的持久前缀（可为空）并结束 POST，不启动新执行或跟随将来的事件；需要持续读取时使用既有 Run events GET，从实际游标补读并跟随。该行为是对现行 running 同键 409 接流规则的拟议变更，不改变身份撤销或读取授权。详情和历史列表 `model_selection` 为 `{state:'available',provider_id,provider_name,model_id}`、`{state:'legacy_unavailable'}` 或 `{state:'not_applicable'}`，从冻结事实只读，原 owner 授权不变；不增加 SSE 事件。详见 [设计](../design/22-model-provider-settings.md) §3。

拟议 SSE 响应在授权完成后，通过 `X-Conversation-Id` 和 `X-Run-Id` 标识 POST 首次接纳、POST 重放及 server-owned 订阅所对应的原会话与 Run；空前缀也能据此定位后续补读。不新增 SSE 事件词，响应头不替代读取时的授权检查。
