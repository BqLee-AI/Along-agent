Issue: #168

# 首个公众只读远程 MCP：Microsoft Learn 查询

## Why

Along 需要查询公开的 Microsoft/Azure 官方资料，并在回答中保留可核对的来源，而不是让用户登记服务器或提供个人密钥。先用公开服务实测工具发现、搜索和返回边界，再决定是否接入产品；协议实验与产品运行分别举证。

Spec：`docs/design/14-r1-document-task-loop.md` §1、§4.3；`docs/design/20-goal-scoped-delegation.md` §2–§3、§4、§6、§8–§9。

## What Changes

- 在既有“连接应用”页加入唯一固定的 Microsoft Learn 公众资料查询。连接是本人显式启用，不是 Microsoft 登录或上游可用性承诺；无需密钥，不接收 URL。
- 仅新签名 delegation Harness Run 可冻结本人已启用连接的代次，并获得一个固定查询工具。模型只提交搜索词；工具发现结果不会变成动态模型工具或权限。
- 复用既有 MCP SDK、Run/attempt 资格、事务外只读执行、不可变接受结果和调用审计。每次真实出站前重新验证资格，结果接受时再次验证；断开和重连不能复活旧代次。
- 查询只返回有界的公开资料摘录和官方来源 URL，明确不是全文、实时状态或穷尽搜索。资料是非可信数据，不是指令或授权。超时、服务失败、协议/容量失败保留不同结果。

## 非目标 / Deferred

不接任意 URL、脚本、写工具、下载全文、市场、通用注册表、OAuth 或授权平台；不改变模型供应商、认证体系、推送、计费和 tool_search；不新增后台执行器，不迁写旧 Run、历史回执或飞书资格。

## Impact

- `tool-gateway`：单个固定远程只读能力、当前资格、输出与审计边界。
- `conversations`：连接页显式启用/断开与新 Run 冻结；沿用现有执行生命周期。
- 后续实现涉及固定连接状态、窄远程 MCP 适配、API/Web、TS/native 结果合同及验收记录；本 PR 仅提交 OpenSpec 草稿，不启用产品行为。
