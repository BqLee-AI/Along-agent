## 1. 公开实验与合同

- [x] P1 公开 MCP 初始化、发现、搜索和来源/容量实验，保留原证据边界。
- [x] P2 独立 OpenSpec-only 草稿 PR；本轮按用户纠正改为普通输入自主公开搜索，校验并先推送 #170，再实施 #172。

## 2. 最小实现

- [x] I1 固定 Microsoft Learn 入口、唯一搜索工具、SDK、容量与官方来源。
- [x] I2 合格普通会话由主模型选择空参工具，独立推理只使用本轮输入。旧 Run 名单与飞书私有读取保持隔离，Web 显示公开搜索说明。
- [x] I3 移除连接、代次、专用入口与未发布的 0042 迁移。保留网关、取消、不可变结果和审计。

## 3. 验收与交付

- [x] A1 隔离 Web 普通对话使用受控模型查询真实 Microsoft Learn，展示官方链接，刷新后可查看。DeepSeek 预检返回 HTTP 401，真实模型自主选择仍未验证。
- [x] A2 普通问候无检索出站。通过真实 PostgreSQL 网关验证旧 Run 名单和飞书私有读取隔离。
- [x] A3 签名 HTTP、原生 Harness 与 PostgreSQL 验证查询输入隔离、空参绑定、取消、重放及服务失败后的续答。工作区排除通过静态审查核对。
- [x] A4 [实现 PR](https://github.com/BqLee-AI/Along-agent/pull/172) 的[最终 CI](https://github.com/BqLee-AI/Along-agent/actions/runs/45347583343) 通过。完整证据见[实现验证记录](../../../../docs/verification/remote-mcp-verification-2026-11-23.md)。
- [x] 规范 #170 先合并，实现 #172 随后合并。
