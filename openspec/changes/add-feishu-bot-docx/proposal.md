Issue: #155

# 飞书机器人 Docx 只读接入

## Why

Along 需要以已绑定的飞书机器人身份读取明确指定的文档，不依赖用户 OAuth 或继承个人文档权限。

Spec：`docs/design/20-goal-scoped-delegation.md` §2、§4、§6、§8–9。

## What Changes

- 新请求按 Along owner、当前会话、机器人绑定代次、连接修订和指定 Docx 冻结授权；`feishu_docx_read` 只接受空参数。
- 服务端使用匹配应用的凭据，区分本地资格不足与上游访问拒绝，私有正文仅交给当前有资格的调用。
- 默认关闭；保留旧资料和回执语义，不迁移旧授权，不回退到 OAuth。

## 非目标 / Deferred

不新增应用 scope，不接入 Wiki、MCP、消息或写入。

## Impact

- `tool-gateway`：授权、出站、结果接受与回取。
- Along API、仓颉共享结果合同、独立安装配置与历史存储。
