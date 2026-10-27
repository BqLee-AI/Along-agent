## Context

本方案由 planner 静态调研后起草，主线程核对 `identity/better-auth.ts`、`pg-adapter.ts`、Web proxy 与 #67 版本核验路径。规划不是运行证据：正式登录 Cookie/HMAC 兼容性、库退出异常及真实事务须在隔离 PG 实验确认。

设计真源为 [design/16](../../../docs/design/16-r1-account-access.md)，准确路由和字段分别见 [auth API](../../../docs/api/auth/auth_routes.md#4-r1-账户访问68) 与 [identity schema](../../../docs/schema/identity-schema.md#r1-账户与安装绑定68)，这里仅记录取舍和实施顺序，不复制 DTO/DDL。

## Goals / Non-Goals

完整交付首次唯一管理员、原身份转正、登录、退出、过期重登和本机登记收尾；旧 users.id 与 owner 事实不变。不开放公众注册、不挂整个库 handler、不做多租户/RBAC/找回/滑动续期，不进入 #69/#70/R2。

## Decisions

1. identity 公共用例拥有管理员绑定及真实 PG 事务。唯一约束兜底，并发在同一命名域事务锁内复核；不用跨 pool.query 的伪事务，不让 HTTP 直接拼跨模块 SQL。
2. 使用现有 Better Auth 的密码、credential、Cookie 与 resolver，只适配必要字段、UUID、事务及 raw/HMAC 边界；不另造认证系统。不批量迁移历史 credential，不将存储 hash 作为 Cookie 原 token。
3. 匿名初始化只允许确证空安装；旧会话转正仅当前签名 actor，无会话用短命正式本地维护入口明确选人。已有密码不得通过转正重置；disabled 不自动激活。
4. 退出成功以已确认数据库撤销为准，而非库 success；数据库故障不当 401、不清 Cookie 伪报退出。固定七天，不开 refresh/cache 分支。
5. 只对 HTTP 401 做安全站内重登导航，成功后 GET 恢复原状态；不缓存重放消息、批准、取消或 resume。403/503 保留原义。
6. 账户 PG 提交、Windows 登记/配置文件及 #67 reload 各有事实。选择正式 local:account 维护命令，不引入常驻宿主桥或让容器写 Windows 配置。释放安装锁和数据库连接后再重载，失败只补做未完成收尾。

## Risks / Trade-offs

- 本地维护比全 Web 配置多一步，但避免把宿主路径/私有文件/进程管理扩入 API 信任边界；用户不用手填 ID 或依赖助手。
- 原 owner 可能存在于业务历史而无 users 外键，users 为空不足以开放开户；模块公共只读事实和登记失败状态必须保留。
- 没有全局 token 缓存或 hash 逆解；所选库链的按 ID 返回形状先实测。实验发现不兼容先修订合同，不做假 fallback。
- 新迁移必须同时提供 `scripts/local/baselines/0017-checks.json` 及扫描规则；沿用既有 JSON 目录结构核验，否则 #67 正式升级缺版本核验材料。旧 0016 基线仍受保护。

## Migration Plan

合同 PR 单独交付并评审；下一获准单元先执行 design/16 §7 E1–E5，再完整实施前后端、维护入口与文档。停旧写者后经 #67 显式升级应用新增迁移、核验并运行同批产物，保留原卷/secret/root。迁移不自动选择管理员或改 owner；失败保持停写，显式前滚。

## Verification

九项 requirement 对应 #68 七项验收，具体映射与真实实验见 design/16 §7–§8。明确行为 Red→Green；库未知先隔离实验；PG 并发/回滚、正式 proxy/浏览器和本机维护分层举证。合同 PR 不勾运行项、不归档；实现和真实用户路径获验收后才独立收口。
