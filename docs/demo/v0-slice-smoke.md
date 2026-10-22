# v0 切片冒烟：干净单次提醒闭环

> 本文是 [#26](https://github.com/BqLee-AI/Along-agent/issues/26) 的操作手册，不是验收记录。通知详情合同见 design/03 §3.1 与 tasks API §2.1；实施、审查与实际运行结果见对应 OpenSpec tasks 和 [2026-10-21 验收记录](v0-smoke-evidence-2026-10-21.md)。完整计划与 A1–A4 边界见 [收口计划](v0-smoke-closeout-plan.md)。

范围：同一受控环境、同一合成 owner、真实 Web 单端七步。不重开 brief，不扩展 CI、外部推送或通用 E2E 框架；D1–D10、五门、按钮确认、冻结展示、回执门均不变。正常主链只经对话/按钮写业务数据；SQL 仅只读取证，不手注任务、时间、通知或取消回执。

## 1. 执行前置与实施依赖

### 必须先落地的依赖

- **通知可见面：** `GET /api/v1/tasks/{id}` 提供只读 `data.notifications` 数组，任务详情展示存储记录或空态。每项仅投影现有 `id/title/body/status/sent_at`，`status` 为 `pending | sent | failed`，`sent_at` 可为 `null`。沿用详情 owner 校验：不存在 404，跨 owner 403；不向任务列表加字段，不新增通知路由或读取副作用。查询归 notifications 公共 service，tasks 按 owner/task ID 调用，禁止跨模块读表。实际运行前先核对版本与依赖，不能把合同描述当作部署成功证据。
- **取消回执：** 正常 worker 在任务锁与版本栅栏下撤销 PG outbox 的旧版本 work 和 lease，核对无活跃余单后，持久化本地回执并在同事务追加 `cancelled` 事件。不能用 SQL 改终态、手注回执或内存标记替代真实撤销；不改已合并迁移，无回执仍保持 `cancel_pending`。
- **调用观察（先配置）：** §4 的真实 provider 调用证据必须在正向任务到点前接通；无法可靠观察时，先在该边界落实最小、无内容的调用证据，不拿零通知/零 fired 代替。

### 独占环境与启动

1. 固定 Bun **1.4.2**、本地 OpenSpec **1.3.1**、Postgres **16**；执行者记录当前 commit、相关源码差异、进程/环境所有权和版本。保留用户改动。使用专属新 PG 数据库/项目及卷，确认无其他 worker 共用它；不清空用户库、不杀用户进程。
2. 所有凭据仅由执行器/私密终端的**进程环境**注入；不读取、source、复制或改写 `.env*`，不在命令、截图、证据文件中展开 DSN/secret。API、seed 使用同一 `DATABASE_URL` 和 `BETTER_AUTH_SECRET`；只读 psql 使用指向同库的 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` 等进程环境，不输出它们。API 的 `ROLE=all`、`PORT=3000`、`TZDB_VERSION=fixture-v1`，Web 的 `API_BASE=http://127.0.0.1:3000` 也从进程环境明确注入；不能继承 `ROLE=api` 而漏启 worker。
3. 在已明确独占的**空新库**上，仓根执行下列现有入口；运行记录另行保存，不能仅凭本命令清单认定通过：

   ```sh
   bun install --frozen-lockfile
   sh scripts/db/apply.sh
   bun run --filter @along/api seed:session
   bun run dev
   ```

   `apply.sh` 需要 POSIX shell 与宿主 `psql`，按顺序一次应用当前 0001–0011；不是可安全反复用于已有库的迁移 runner。必须注入专属 `DATABASE_URL`，不能意外走它的默认 DSN。根 `dev` 会构建共享包，再启动 API 3000、Web 3100；没有根 `db:migrate` 命令。若调试器需要不同启动方式，沿用相同源码/配置和单 worker，先构建共享包，记录实际启动命令；不得同时再运行另一套 all/worker。

4. 也可使用已拥有的 PG 编排，但现有 `infra/compose/compose.yaml` 仅含 PG 和 all API，镜像不含 Web，未自动迁移也未向 API 注入 `BETTER_AUTH_SECRET`。不能把 Compose readiness smoke 当作本手册环境；不得启动 Compose all API 后又启动指向同库的宿主 all。

   Compose 的 PostgreSQL/API 使用 `restart: unless-stopped`：进程异常退出或 Docker 引擎恢复后自动重启，显式停止的服务不会被重新拉起。该策略不启动 Docker Desktop，也不能阻止宿主关机、休眠或引擎停机。长时自然到点验收必须保持宿主与引擎运行，并保留观察中断；停机跨过到点宽限窗时按真实 `missed` 记录，不承诺补发。失败原任务保留不改，新一轮验收另建任务并分别报告。

5. API 直接探针：`http://127.0.0.1:3000/healthz` 返回 `ok`，`/readyz` 无类型化错误。注意 readiness 当前仅查 `TZDB_VERSION` 非空，不探 PG/完整规则；还要以真实 `/me`、业务请求与只读 SQL 确认路径。现归一使用 `FIXTURE_V1`、实际 tzdb `fixture-v1`，不是完整 IANA 库；记录环境声明值及 SSE 实际 `ruleset_id/tzdb_version`，不能把任意版本字符串当完整规则证明。

### 真实 session、CSRF 与 Next

- seed CLI 正常创建身份/session（不是业务 SQL 注入），默认用户时区 `Asia/Shanghai`；输出 `user=...`、签名 cookie `better-auth.session_token=...` 和 CSRF。只在不录屏的私密终端使用这些值，不保留 seed 原始输出。
- 打开 `http://127.0.0.1:3100`。在浏览器 Application/Storage 的该主机下设置 cookie `better-auth.session_token`，值为 seed 的完整签名值，Path `/`；不要混用 `localhost` 与 `127.0.0.1`。在同源访问 `/api/v1/me`，核 `data.user.id` 为本次 owner、`data.confirmed_timezone=Asia/Shanghai`，取 `data.csrf_token` 仅供临时请求使用。
- 浏览器写请求带 cookie、`content-type: application/json` 与 `x-csrf-token`，均经 Web 同源 `/api/v1/*` 的 Next 代理到 API；不直连 API 端口完成业务串链，不用 `ALLOW_DEV_AUTH`、假 actor 或测试认证接口代替。SSE 另带 `accept: text/event-stream`。
- 页面 GET 可能由 RSC 在服务端转发 cookie，不一定出现在浏览器 Network；另取同源 API 响应与页面对照即可。`/healthz`、`/readyz` 只走 API 根路径，不存在 `/api/v1/readyz`。

## 2. 数据、时间与证据准备

- 为同一 owner 记录初始 task ID/approval ID 集合及相关 outbox 基线（§3）；只比较本次 ID 的差量，不假设全库/首页 tasks 为空。分页列表必须读完有关页，不拿首页条数代替 SQL。
- 新环境无简报卡片时，先在 `/conversations` 用真实近未来输入生成一个**不确认**的准备 approval `P0`，记入基线。它只供步 1/2 的只读展示，不建立第三个 task。
- 两个正式任务分别为 `P_fire → T_fire`、`P_cancel → T_cancel`。**每次创建时重新**以可信当前钟选择约 3–5 分钟后的整分钟，输入 `YYYY-MM-DD HH:mm 提醒我喝水（北京时间）`，填写当次真实年份/日期/时间。`T_cancel` 在步 6 之后再建，不能复用已 fired 的任务。避免秒精度输入和明天固定时间，保证有时间确认/排期/取消又能有界等待。
- 记录服务端可信时间、PG `now()`、owner 时区及各任务原始 `fire_at_utc`；业务展示只核冻结 `wall_time/fire_at_local + timezone_id`，不在 Web 换算 UTC。不要用 SQL 回拨时间、修改 `fire_at_utc` 或手动调用 worker phase 加速正常链。
- 在正向到点前开始 §4 观察，整个运行保持同一个单 worker；记录器失联、代码热重载/进程重启或日志丢失均使该段“零调用”证据失效，不能续接为连续观察。

## 3. 七步操作与最低断言

### 步 1 简报

打开 Web `/`，同源 GET `/api/v1/brief`。成功响应为统一 envelope：

```json
{
  "code": 0,
  "data": {
    "date": "<owner 本地日期>",
    "timezone_id": "Asia/Shanghai",
    "summary": { "pending_count": 0, "fired_count": 0 },
    "cards": [],
    "meta": {
      "brief_state": "empty",
      "timezone_note": null
    }
  },
  "msg": "ok",
  "error": null,
  "request_id": "<request id>"
}
```

此 JSON **只是空态结构示例**，准备 P0 后实际 counts/cards/meta 按当次业务状态记录，不固定 `pending_count=1` 或上述空值。无其他写入时重复 GET 比较业务投影，忽略 request_id；brief 是 tasks/approvals 当前态投影，不建 `briefs` 表，不断言落库幂等。

### 步 2 只读卡片

从简报点击 P0 卡片到 `/approvals/{id}`，保存脱敏页面与 `GET /api/v1/approvals/{id}` 的 `data.echo_text/presentation_hash/status`。brief 的卡片 `kind=task | approval`、`schema_version=1`（**数字**），不是 `card.v1`；approval 卡片不要求拥有 task 全部字段。点击前后按 P0 与 owner 查 task/outbox，无新增，冻结回显不变；点只读卡片不等于确认。

### 步 3 对话 SSE

在 `/conversations` 输入本次正向近未来时间。核浏览器实际 POST `/api/v1/conversations/messages`，不是旧 `message` 字段：

```json
{
  "raw_text": "<本次 YYYY-MM-DD HH:mm 提醒我喝水（北京时间）>",
  "confirmed_timezone": "Asia/Shanghai",
  "idempotency_key": "<uuid>"
}
```

首轮 `conversation_id` 可省略；后续由 `thread.started.payload.conversation_id` 延续。保存脱敏 SSE `data:` JSON：`thread.started → message.delta → card.proposed → approval_required → thread.completed`（delta 可多帧；该成功运行终结事件唯一）。每帧 `protocol_version="v1"`、递增 `seq`、`request_id`；payload 中关联 cid/run_id。`card.proposed.payload.schema_version="v1"`（**字符串，与 brief 数字 1 不同**），含冻结 `wall_time/timezone_id`；`approval_required.payload.approval_id=P_fire`。外部不是旧 `thinking/done`。

取 approval 详情核 `data.status=pending`，只读 SQL 核审批表 `state=pending`，该 owner 的 `source_approval_id=P_fire` 对应 task 数为 0、关联 outbox 为 0；不能用“全库空”替代。记录回显告知“确认前不会创建正式提醒或排期”。这里不要求自然语言确认有效，v0 只走按钮。

### 步 4 按钮确认与重复请求

进入 `/approvals/P_fire`，核页面完整 `echo_text` 与存档 hash，一次点击确认。实际 POST `/api/v1/approvals/P_fire/actions/confirm`：

```json
{
  "presentation_hash": "<实际看到的哈希>",
  "seen_content": "<实际页面完整 echo_text，不能截断/自行重拼>",
  "idempotency_key": "<uuid>"
}
```

成功响应不是 `{state:"saved"}`，而是：

```json
{
  "code": 0,
  "data": {
    "approval_id": "<P_fire>",
    "status": "consumed",
    "task_id": "<T_fire>",
    "duplicate": false
  },
  "msg": "ok",
  "error": null,
  "request_id": "<request id>"
}
```

按钮成功会跳任务页且禁双击。以 Network 的已提交请求在**同源**重发一次原 body/幂等键（保留有效 CSRF，仅本地使用），核同一 `task_id`、`duplicate=true`，不要假装 UI 自动做了双次确认。approval 详情为 `data.status=consumed`，SQL `state=consumed/consumed_task_id=T_fire`；与确认前差量核 1 task、1 `created`、1 schedule 命令，无第二 task。worker 可能已改变 outbox status，不固定其为 pending。`PRESENTATION_MISMATCH` 等非成功立即保留现场，不省略所见校验绕过门。

### 步 5 真实到点与通知

保持 all worker 运行，先核 task `schedule_receipt=sched:<T_fire>`，再等待原 `fire_at_utc`。到点后取同源 `GET /api/v1/tasks/T_fire`、`/api/v1/tasks/T_fire/events`，核 `state=fired`、一条 `fired` 事件、默认本地 `evidence_ref=inapp:<sendKey>`，SQL 通知恰好一行；§4 真实 provider 调用恰好一次作正控制。至少再跨两个完整 30s tick，复取计数保持一次；只等 60s 但 worker 未工作不算两个有效 tick。

**待通知实施完成后**，详情 `data.notifications` 中恰好对应本次站内记录，Web `/tasks/T_fire` 显示相同 `id/title/body/status/sent_at`。body 按存储冻结文案原样展示，不重新算时间；站内 `sent` 与本地回执只证明服务端记录/本地接收，不证明设备送达、准时响铃或人已读。不请求不存在的通知列表路由。

超过原到点 15 分钟只应 missed、不补发；但本次正向任务若 missed，应判本轮 A1 失败，不能以符合 missed 分支替代到点成功。

### 步 6 任务详情与活动账

刷新 `/tasks/T_fire` 和 `/activity`，与同次详情/事件 API、SQL 对齐：事件 `created → scheduled → fired`、`state_version/recorded_at_utc/evidence_ref` 一致。task 可以 `saved → scheduled → fired`，不强求抓到 `pending_schedule`，不合成 `saved` 事件。通知面与事件账分别取证，不能把 fired 文案充当通知正文。

活动页目前仅查前 50 个 tasks、每 task 前 50 个 events；使用小规模合成数据。超出时用任务详情与分页事件 API，不误判丢账。API 失败、页面空白或事件页读取失败不能算“无事件”。

### 步 7 另建任务并真实取消

1. 重新选约 3–5 分钟后整分钟，经步 3/4 创建 `P_cancel → T_cancel`，记录其原始 `fire_at_utc`。先核真实 `schedule_receipt=sched:<T_cancel>`，保证不是未排期任务的空测；不足取消余量时另建新任务并完整说明，不改 DB 时间。
2. 从 `/tasks/T_cancel` 点击取消；实际 POST `/api/v1/tasks/T_cancel/actions/cancel` body 为 `{"idempotency_key":"<uuid>"}`（可选 `reason`），带 CSRF。响应统一 envelope，`data={task_id:"<T_cancel>",state:"cancel_pending",duplicate:false}`；以实际响应为准，重放可 duplicate，若已有真实回执也可能直接返回 cancelled。HTTP 成功返回与随后可读事务事实共同作为“已提交”证据。
3. 观察真实本地撤销/fencing 核对后的**持久回执**及 `cancelled` 事件、task 终态；cancel outbox 的 `provider_receipt_id` 与事件 `evidence_ref` 可对照。无回执必须停 `cancel_pending`，不口头算成功、不手调测试函数/SQL 补齐回执。仅内存 Set 命中也不算持久证据。
4. worker/调用观察保持连续运行，跨过 `T_cancel` 的**原到点 + 15 分钟窗口结束**，再覆盖至少两个有效 30s tick；即观察终点不早于 `original_fire_at_utc + 15min + 60s`，且确认这期间 worker 实际工作。记录原到点、窗口终点、实际观察终点与 tick 证据。
5. 主指标：从取消提交起实际 provider 调用数 **0**（§4）。辅证分别为通知 **0**、`fired` **0**、`cancel_breach` **0**、待处理非 cancel 余单 **0**。历史完成 outbox 不要求全部 superseded；cancel 命令可在等待时 pending，完成后 dispatched。

## 4. 只读 SQL 与实际调用取证

### SQL 快照

在同一个受控库执行 `psql -X -v ON_ERROR_STOP=1`（连接凭据已从进程环境注入，不将 DSN 拼入命令）。在私密交互会话设置以下**非凭据**变量为实际 UUID；占位符不可原样执行。每个检查点重新运行只读事务，记录基线/确认前/确认后/到点后/取消后/窗口结束后差量：

```sql
\set owner '<本次 /me 的 user.id>'
\set approval '<当前 P0、P_fire 或 P_cancel>'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT now() AS observed_at_utc;
SELECT id FROM tasks WHERE owner_id = :'owner'::uuid ORDER BY id;
SELECT id, state, consumed_task_id, presentation_hash, wall_time,
       timezone_id, tzdb_version
FROM approvals
WHERE owner_id = :'owner'::uuid AND id = :'approval'::uuid;
SELECT count(*) AS approval_tasks
FROM tasks WHERE owner_id = :'owner'::uuid
  AND source_approval_id = :'approval'::uuid;
SELECT count(*) AS approval_outbox
FROM outbox o JOIN tasks t ON t.id = o.task_id AND t.owner_id = o.owner_id
WHERE o.owner_id = :'owner'::uuid AND t.source_approval_id = :'approval'::uuid;
COMMIT;
```

取得 task ID 后，再为当前 `T_fire` 或 `T_cancel` 运行以下快照；所有表均按 owner 和本次 ID 限定，不导出全库或完整 outbox command：

```sql
\set task '<当前 T_fire 或 T_cancel>'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT now() AS observed_at_utc;
SELECT id, source_approval_id, state, state_version, schedule_receipt,
       fire_at_utc, wall_time, timezone_id, tzdb_version
FROM tasks WHERE owner_id = :'owner'::uuid AND id = :'task'::uuid;
SELECT id, type, state_version, recorded_at_utc, evidence_ref
FROM task_events
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid
ORDER BY recorded_at_utc, id;
SELECT id, command->>'kind' AS kind, status, attempt_no, provider_receipt_id
FROM outbox
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid
ORDER BY created_at, id;
SELECT id, title, body, idempotency_key, status, sent_at
FROM notifications
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid
ORDER BY created_at, id;
SELECT count(*) AS created_events FROM task_events
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid AND type = 'created';
SELECT count(*) AS schedule_commands FROM outbox
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid
  AND command->>'kind' = 'schedule';
SELECT count(*) AS notices FROM notifications
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid;
SELECT count(*) AS fired_events FROM task_events
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid AND type = 'fired';
SELECT count(*) AS pending_non_cancel FROM outbox
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid
  AND command->>'kind' <> 'cancel'
  AND status IN ('pending', 'dispatched', 'acked_unknown');
SELECT count(*) AS cancel_breaches FROM security_events
WHERE owner_id = :'owner'::uuid AND task_id = :'task'::uuid AND type = 'cancel_breach';
COMMIT;
```

`pending_non_cancel=0` 是取消任务的断言，不是对所有 task 的通用要求。安全事件单独取证；取消回执除其持久字段外，还需实施后的实际撤销/fencing 路径证据，不能仅凭一个手填字符串认定真实完成。保存合成通知内容即可；不向证据包输出身份凭据、授权头或真实提醒。

### provider 调用：独立于 SQL 的主指标

当前真实边界为 `apps/api/src/modules/notifications/service.ts#deliverInApp` 的 `await effective(notice)`。计数的是该 provider 调用瞬间，即使事务回滚/幂等插入无新增也算一次；不是 runSendPhase 扫描、SendSummary.fired、唯一通知行或网络包数（本地 provider 没有外网请求）。

优先在受控单 worker 上于该调用行设置**非暂停 debug logpoint**，仅记录固定标记、`notice.taskId`、调用时刻和本次观察的序号；禁止展开整个 notice（含提醒内容）、cookie 或环境。确认调试客户端实际支持持续 logpoint 且不暂停/拖延可信钟；不支持或无法保存完整记录时，先实现同一边界最小无内容证据，不建遥测框架或新测试 API。

同一调用边界也提供 Node 内置诊断通道 `along.notifications.provider-call`：只有订阅者存在时，才在调用实际 provider 紧邻之前发布 `{ taskId }`，默认不产生日志、不展开提醒或身份。可用独占启动器的 Bun `--preload` 观察脚本订阅，记录进程 ID、序号、时间与 task ID，并保存连续心跳；观察脚本不得替换 provider、修改请求或业务数据。它不是发送成功回执，通知与终态仍需分别核对。Bun 调试器不能可靠提供非暂停 logpoint 时，采用该边界观察，不用轮询通知行充当调用数。

观察从 `T_fire` 到点前开始，`T_fire` 的一次实际调用是正控制，再无中断延续到取消窗口结束。给 `T_cancel` 汇总提交后的调用数并保留原始脱敏观察；没有正控制、漏接进程或观察空档时，写“缺证据”，不得写零。

`cancel_requested.recorded_at_utc` 是事务内写入时间，不等于 commit。记录取消请求开始、HTTP 成功返回及事务已可读的时间，以成功返回后的调用证明提交后违规；开始至响应之间的调用若无法与提交排序，按既有“分不清先后按违规计”交人复核，不自行排除。调用破零即变红，即便数据库通知/fired 都为零。

## 5. 普通障碍、停止与交付口径

| 现象                                                      | 处理/边界                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Windows 缺 POSIX shell/psql、PG/端口冲突、PG 所有权不明   | 补齐工具或选择自己拥有的新环境；所有权不明即停止，不删库/抢端口/杀用户进程                             |
| `/me` 401、POST CSRF 403                                  | 核同 host、cookie Path/完整签名、API 与 seed 的同一 secret、有效 session 及最新 `/me` CSRF；不关闭鉴权 |
| `/readyz` TZDB 错误或业务规则不可用                       | 停止新归一/排期，修受控环境；readyz 绿不代替真实业务/规则证据                                          |
| `PRESENTATION_MISMATCH` / expired / superseded            | 保留错误 envelope；重新生成有效 approval 并以实际全文确认，不改 hash/业务表绕过                        |
| 通知数组/面板缺失、一直 cancel_pending、没有可靠调用观察  | 排查部署版本、实际撤销与取证依赖；未满足前不能宣称七步完成                                             |
| 时间余量不足、worker 无 tick、正向 missed                 | 本次未通过/未完成；保留现场，在修复原因后重新生成近未来任务，不 SQL 回拨                               |
| 活动页空白/事件 GET 失败、日志中断、取消后调用>0/时序不清 | 保留脱敏证据，停止收口；不将错误当空态或按零通知放行                                                   |

真实记录需逐步填写预期/实际/证据/执行者/复核者，附开始结束、版本/源码状态、环境别名及所有权、ROLE、时钟/实际规则、关联 ID/request_id、脱敏 SSE/API/SQL/页面与调用观察。所有本手册示例均非已观测结果，不填完成勾选，不造截图。HAR 必须先去除 cookie/CSRF/授权头/个人内容再留存。

七步证据齐备后，只能据实报告其覆盖：重复确认不是完整 A2 supersession；正常取消不是完整 A3 kill/resume；Shanghai 正向运行不是完整 A4 DST/规则故障。完整 A2/A3/A4 及时间错误合同冲突仍按收口计划另列，不自动纳入 P4，不宣称“v0 全验收通过”。
