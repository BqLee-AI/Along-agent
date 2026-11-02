# #92 日期锚契约与分离修复

## 1. 独立契约

- [x] 1.1 对照既有spec/design、相关代码与交接中的历史Red，区分中文时钟/缺字段修复与新的Run锚/延迟行为；记录会话锚和原延迟约束冲突。
- [x] 1.2 编写proposal、设计取舍、conversations增量及完整MODIFIED安全Requirement；明确可信关系、关系不明、同日延迟、真实午夜与旧冻结边界，不把当前草稿实现记为完成。
- [x] 1.3 独立 spec-only [PR #98](https://github.com/BqLee-AI/Along-agent/pull/98) 已合并，#92 已授权采纳并实施；该 PR 不带业务实现，文档/既有运行时校验不等于新锚验收。
- [x] 1.4 采纳后同步 design/05、Agent、黄金第14条、PRD、索引及 API/schema，明确最小来源引用和不可变 JSON，消除会话锚/延迟冲突；不改主 spec、proposal 或 spec 增量，不 archive。

## 2. 既有合同缺陷修复（独立实现PR）

- [x] 2.1 中文钟数唯一格式解析、缺日期准确话术、缺时段不替选及独立 note 完整校验，已由 [PR #97](https://github.com/BqLee-AI/Along-agent/pull/97) 合并。仅记历史完成，不含新日期锚。
- [x] 2.2 #97 已交付 time-core、API/隔离 PG、完整字段零承诺、50条覆盖/计数及只读/反时钟回归证据。历史专项为分段覆盖（不是单次全套 Green），最终 CI 五门通过；不是本次修改的当前验证。

## 3. 获准日期锚实施与验收

- [x] 3.1 完成新明确日期接纳锚、实际来源/未完成状态/紧邻关系验证；复用 frozen_context 的 reminderDateSource 和最小 clarification_of_run_id，不新表/迁移或旧数据回填，不用最新任意 Run 或缺来源 fallback。
- [x] 3.2 覆盖旧会话新今天/明天、可信整条时区补充、精确 fold 引用/原文/候选、关系不明/多个候选/无关消息/旧缺来源、同日120秒及真实午夜20秒；通过真实 HTTP/隔离 PG 工具提议与批准冻结取证。
- [x] 3.3 主Agent完成正式 native 消费与实施工作树验收：同 Run 工具、重放、批准恢复和只读历史不换锚、不读当前钟重算；全部数据位于本任务隔离 PG，不创建真实用户提醒。
- [x] 3.4 独立reviewer审阅合同、实现与证据；修复坏规则下可信时区补充绕过接纳预检的问题并复核关闭，归并主spec及归档。真实provider自然语言质量不由受控模型fixture证明。

## Verification

历史证据：#98 已合并采纳合同，其 `a051bac` CI [41401990381](https://github.com/BqLee-AI/Along-agent/actions/runs/41401990381) 及 strict/格式结果只证明该 spec-only 快照与既有运行时，不证明新锚端到端。#97 已合并既有缺陷修复，其 `0fe8aec` CI [41401991253](https://github.com/BqLee-AI/Along-agent/actions/runs/41401991253) 五门通过；本地专项为186个不同用例的分段覆盖，初次174 pass/12 fail、原12项重跑通过，随后符号事项独立 Red/Green，不冒称单次全套通过。

### 2026-11-02 实施工作树验收

- 状态：`fix/92-backend-worktree` 未提交工作树；正式契约 runner 从该工作树构建镜像 `sha256:834a305ae1da0d33098dc2366acab0616f939d0a8cf808b8438f317d2b901d31`，容器使用 Bun 1.4.2、正式 native 二进制和独立 PostgreSQL 16。WSL 的 Bun 仅启动 shell runner，不作为契约运行时。
- 策略：先实现后补行为覆盖，不宣称 TDD/Red。初次契约失败来自夹具误判拒绝恢复流程、混用实时工具结果和恢复快照的数据形状；修正夹具后执行完整契约，不以过滤后的专项结果代替全套。
- `bun run verify`：10步全部通过；lint保留既有warning，typecheck/依赖边界/门禁/冻结词/口径扫描通过；单元645 pass、7 skip、0 fail；OpenSpec strict 11/11；格式检查通过。
- `bun run test:contracts`：正式镜像149 pass、0 fail，含新增日期锚local/HTTP十个native用例；同日120秒、真实午夜20秒、缺日期禁止模型补造、批准恢复及跨午夜重放均通过。
- `bun run test:integration`：Linux/Bun 1.4.2及本任务独立PG，351 pass、0 fail。初次漏传测试专用认证变量的失败不计通过；补齐后修复新来源校验暴露的旧夹具与完整新请求边界，再执行全套通过。
- `bun run build`：全部包、API、生产Web构建通过。
- 实际表面：启动生产Web构建及API正式入口，浏览器进入创建提醒，提交纽约重复时刻，选择第一次后重新提交；隔离PG确认后继Run引用原失败Run且锚不变，生成一项pending批准（America/New_York、fold=0），tasks=0。未点击确认过期历史目标；该冒烟不是真实provider质量验收。
- 证据边界：模型步骤受控，但调用正式native、实际工具、HTTP/SSE及真实PG；未调用真实LLM供应商，未执行远端CI、commit/push、关闭Issue或规范归档。历史#97/#98结果不计入以上当前运行。

### 2026-11-02 独立审查与收口

- 独立reviewer审查`b179192`完整PR差异，发现一项P2：可信时区补充绕过坏规则预检，错误接纳并消耗原来源。修复后reviewer定点复核，blocking findings清零；未把主Agent自审称为独立审查。
- 回归先行：新增`time-errors.test.ts`的坏规则继承补充场景，实际Red为期望HTTP503却得到200；修复为按继承后的有效提醒输入执行事务内规则门。相同回归与日期锚集成专项Green：27 pass、0 fail。
- 正式入口冒烟：启动`apps/api/src/main.ts`，健康规则得到缺时区澄清，重启为坏规则后补“北京时间”返回HTTP503且零新增事实，再恢复规则以同键重试得到批准并保持原来源，tasks=0。全部使用本任务隔离PG与测试身份，不触碰用户安装。
- 实施提交`b179192`的[CI 41423806283](https://github.com/BqLee-AI/Along-agent/actions/runs/41423806283)五门全部通过；这不是后续修复/归档提交的CI证据。收口提交的五门以[PR #103](https://github.com/BqLee-AI/Along-agent/pull/103)对应head结果为准，未完成检查不记为通过。
