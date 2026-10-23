Issue: #43

# HTTP 请求体的有限入口边界

## Why

现有 HTTP 入口在身份门禁前收集全部 POST body，且直到 end 才解析，无累计字节上限。issue 中的有限真实 HTTP 观察已证明读取顺序，不重复做攻击或内存实验。

## What Changes [Proposed]

- HTTP 入口唯一拥有 JSON body 的累计字节上限：128 KiB（131072 字节，含 JSON 语法和转义；按原始 UTF-8 字节而非字符）。现有最长文本/回显为20000字符，最坏 JSON 转义约120000字节，保留协议字段余量；不扩大业务 schema。
- 复用既有 actor resolver 与 CSRF 规则，在收集受保护 POST body 前完成身份及可用请求头门禁。可信 Content-Length 超限可提前拒绝，缺失时仍累计流字节；不新建 Content-Type/编码合同。
- 超限采用 HTTP413、顶层code413、error.code=PAYLOAD_TOO_LARGE；畸形/空 JSON 使用既有400 VALIDATION_ERROR。继续使用 failEnvelope 和一致 request_id，不占用40xxxx业务编号。
- 提前拒绝或读取超限时停止收集，释放已保存块；未消费请求采用 Connection: close，先送完有限错误响应再关闭连接，不等待客户端结束、不无界 drain。中断/错误结束读取并清理监听器，不进入业务写入；完整合法请求保留 keep-alive。

## Spec 与设计真源

- `docs/design/10-api-and-stream-design.md` §1、§3、§6；`docs/design/03-v0-vertical-slice.md` §2。
- 增量：本 change 的 `specs/v0-safety-contract/spec.md`。实现收口同步 design/API/PRD/索引并 archive。

## 非目标 / Deferred

不改确认/取消事务、冻结展示、时间语义或已有认证体系；不建上传平台、不压测、不改代理/超时平台，不实现#45/#46/#47或R1。LLM、市场、推送与计费继续Deferred。不改.env、旧迁移或历史证据。

## 合入边界

本PR仅契约，Refs #43；五项required checks成功后squash合入，另起实现PR。实现必须保留真实HTTP失败回归、同用例Green和有限上传观察，验证既有正常会话/CSRF与批准/对话/任务路径。
