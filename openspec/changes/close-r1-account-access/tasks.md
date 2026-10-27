## 1. 合同交付

- [x] 1.1 planner 调研 #68 最新要求与锁定 Better Auth、生产 HTTP/proxy、原身份、#67 配置和升级边界；主线程核对关键证据。
- [x] 1.2 定义唯一管理员、原身份转正、真实事务、窄 API/Cookie/退出、401 恢复及本机登记收尾；同步 design/API/schema/PRD/索引，区分源码观察和未执行实验。
- [x] 1.3 严格校验 change、文档引用与格式并完成仓库检查；合同独立提交，PR 仅 Refs #68/#66，不实施、不 archive、不关闭 Issue。

## 2. 锁定库的隔离真实实验

以下在合同后的获准实施单元执行；本合同 PR 未运行，不能把源码风险当已复现失败。以 design/16 §7 为准，使用隔离 PG、原迁移和测试身份，不用用户库、secret 或模型。

- [ ] 2.1 E1：验证库 factory 标准字段、UUID、真实同一 PoolClient 事务；中途失败后独立连接证明无提交孤儿。
- [ ] 2.2 E2：原 seed 与授权原地转正样本走真实库登录，credential account_id/password 兼容且 user ID 不变。
- [ ] 2.3 E3：分离前置错误后验证 raw token、PG HMAC、库 Cookie、正式 proxy/resolver 与 /me 往返；不记录凭据。
- [ ] 2.4 E4：真实 PG 撤销故障下核对库返回/清 Cookie/旧会话；证明窄入口不伪成功，正常退出旧 Cookie 失效。
- [ ] 2.5 E5：正式 proxy 的 Origin、多 Cookie、no-store、有界 UTF-8/分块 body、SSE/abort 与七天固定寿命；必要的合同修订先于实现。

## 3. 完整账户切片

- [ ] 3.1 identity 公共用例、唯一安装绑定、真正空安装判定和真实事务；新迁移/identity 扫描/0017 版本核验配套，旧迁移不改、不自动认领。
- [ ] 3.2 空安装 Web 开户与旧签名会话转正；无会话本地明确选择原用户，原 ID/历史/owner 不变；已有密码/disabled/冲突准确停止。
- [ ] 3.3 复用库密码/credential/Cookie，补齐标准字段/UUID/raw-HMAC 与 client-bound transaction；固定七天、无滑动或备用认证。
- [ ] 3.4 状态、初始化、转正、登录、退出窄 API，真实 Origin/CSRF、准确依赖错误、可信撤销和既有 body 边界；不挂库全 handler。
- [ ] 3.5 正式 Web proxy 保留 Origin、多 Set-Cookie、no-store、SSE 与取消传播；共享公共认证 DTO，不复制安全规则。
- [ ] 3.6 建号/登录/转正/退出页面及所有受影响调用者的 401 安全返回；403/503 不误判，重登只读恢复且无业务 POST 重放。
- [ ] 3.7 正式本机账户维护及工作区登记收尾；自动使用绑定管理员 ID，保留原登记/root，分层反馈文件/配置/重载失败，不重复开户、不造 daemon。
- [ ] 3.8 更新账户与本机使用指南、迁移说明和所影响合同/调用者；明确七天到期、退出故障及显式收尾操作。

## 4. 行为覆盖与真实验收

每项验收由实现负责人取证，复用已有有效覆盖但不冒充本次结果。明确行为先 Red 再 Green，库未知先实验；环境失败不冒充业务 Red。

- [ ] 4.1 AC1/R1：真实 Web 空安装开户，独立 PG 连接并发唯一、逐写入点失败全回滚、匿名重复/历史接管拒绝。
- [ ] 4.2 AC2/R2/R8：旧会话转正、过期会话本地明确选人、多 owner/已有密码/disabled/孤立 owner；原 user/history/tasks/approvals/workspace 不误改。
- [ ] 4.3 AC3/R3/R6：正式浏览器经 proxy 登录所获 Cookie 被 /me 接受；PG 仅 HMAC、密码为库 hash，JSON 无秘密。
- [ ] 4.4 AC4/R4：正常退出、真实撤销故障、固定七天/GET 不续期、原账户过期重登。
- [ ] 4.5 AC5/R5/R6：密码/无 credential/disabled 等统一失败；真实 Origin、CSRF、未知路径/方法、声明/分块/UTF-8 超限与原 SSE 边界。
- [ ] 4.6 AC6/R7：键盘/粘贴/密码管理器、可操作错误、安全 returnTo、401 返回原页面仅 GET；403/503 不跳登录，不重放业务动作。
- [ ] 4.7 AC7/R8/R9：正式本机开户/原身份维护/登记收尾和两次启停；文件/配置/重载失败分层反馈；不依赖助手、seed、手工 Cookie/owner ID 或临时服务。
- [ ] 4.8 沿用五门及 D1–D10；运行统一检查、正式 native 双传输合同与相关 PG 集成，记录版本、策略、实际路径、CI 及未覆盖项；不重复 #62/#67 无新增风险的旧证据。

## 5. 独立收口

- [ ] 5.1 对照 #68 七项验收汇总证据，经用户确认后 archive 本 change、同步 identity 主规格及索引；收口 PR 只 Closes #68、Refs #66，不进入 #69/#70/R2、不关闭 #66。
