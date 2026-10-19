# Auth 路由：会话自检

> 状态：草稿，可评审。范围：v0 鉴权对外契约（仅 `GET /me` + 401/403 行为）。方案已定：Better Auth 自建 credential（D7 空环境冒烟不依赖外部 IdP；v0 单租户）。不包含：注册/登录/登出/刷新细节（随 Better Auth 落地补）。阶段标签：v0。
>
> 蓝图引用：B03；B06（v0 Web 单端）。

## 1. 方案状态 [Required]

- [Required] 鉴权方案已定：Better Auth 自建 credential。以下字段随 Better Auth 落地补齐，不先猜：cookie 名、有效期、登出/刷新端点。
- [Required] 以下行为不变：受保护路由无有效会话返回 401；跨用户访问返回 403；写操作需 CSRF。

## 2. 路由

| 方法 | 路径 | 鉴权 | CSRF | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/me` | 会话自检（无会话返回 401，不跳转） | 否 | 当前 actor 快照 + CSRF token 下发 |

### GET /me [Required]

用途：前端启动时自检会话、取 CSRF token 与已确认时区；也是“会话是否有效”的唯一可编程判断点。

成功响应 `200`（`data` 字段在方案确定前仅定形状，不定 token 细节）：

```json
{
  "code": 0,
  "data": {
    "user": { "id": "usr_01J…", "display_name": "…" },
    "csrf_token": "csrf_…",
    "confirmed_timezone": "Asia/Shanghai"
  },
  "msg": "ok",
  "error": null,
  "request_id": "req_…"
}
```

- `user.id`：多租户隔离键，后续所有资源按此过滤 [Required]。
- `csrf_token`：后续 POST 在 `X-CSRF-Token` 头回传 [Proposed：字段名随方案可换，机制不变]。
- `confirmed_timezone`：用户已确认时区（缺失则为 `null`，前端引导确认；“明天”解析依赖此值冻结，见 conversations 文档）[Required]。
- [Deferred] 不返回：session 过期时间、provider 信息、权限列表（v0 无 RBAC，owner 即全权）。

失败：

```json
{
  "code": 40101,
  "data": null,
  "msg": "未登录",
  "error": { "code": "UNAUTHENTICATED", "message": "会话无效或已过期，请重新登录。", "request_id": "req_…" },
  "request_id": "req_…"
}
```

- HTTP `401` + `error.code=UNAUTHENTICATED` [Required]。前端收到后清本地会话态、引导登录，不自动重试业务请求。
- HTTP `403` + `FORBIDDEN`：会话有效但访问他人资源（各资源路由统一行为，本路由不直接产生）[Required]。

## 3. CSRF 约定 [Proposed]

- 机制：Cookie session + `X-CSRF-Token`。`GET /me` 下发 token，前端内存持有并在每次 POST 附带。
- 缺失/错误 token 的 POST 返回 `403 FORBIDDEN`（`details.reason=CSRF_MISMATCH`），不执行副作用 [Required]。
- 机制“写操作必校验”不变；token 形态变化时随之修订本节。
