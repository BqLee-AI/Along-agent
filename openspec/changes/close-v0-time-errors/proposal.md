Issue: #30

# A4：typed 时间失败与有界真实规则

## Why

冻结安全 spec Requirement 1/Scenario 1.2 已要求时间失败为 `thread.failed`422；当前 gateway/conversation 却把失败完成为澄清、候选只拼文本，Web 没有 fold 选择。生产直接使用三 zone 的 `FIXTURE_V1`，readyz 仅验版本非空，既不能证明规则/alias 可用，也不能证明 API README 已要求的 DB 可达。

## What Changes [Proposed]

- 恢复冻结失败语义；SSE 外层200、帧内422/503，唯一终结，结构化双候选；普通缺信息/模糊表达仍澄清。
- API 应用统一拥有不可变规则上下文，readyz 与所有新归一入口共用；time-core 仍零I/O纯函数。预检规则不可用在认证/CSRF及既有输入/owner/幂等边界之后、任何新run写入之前503拒绝；流中故障保留失败审计但零承诺写入。
- 仅承诺实际三 zone 的本地 `[2026-01-01T00:00:00,2028-01-01T00:00:00)`；规则/alias/标识坏包与范围外沿既有 TZDB_UNAVAILABLE，用户未知时区/显式别名为 UNKNOWN_TIMEZONE，不静默fallback。
- Web 保留原输入/日期/时区，明确 first/second 与偏移后新键重提议，客户端不算UTC；旧冻结读取/确认/取消/执行不受新规则门阻断。

## Spec 与设计真源

- 增量：`specs/v0-safety-contract/spec.md`（本 change）；既有权威：`openspec/specs/v0-safety-contract/spec.md` Requirement 1（不修改其当前场景）。
- `docs/design/05-time-core.md` §5、§9、§10；`docs/design/10-api-and-stream-design.md` §3、§4、§6；`docs/api/conversations/conversations_routes.md` §2、§4。
- 同步 time-core 黄金与 Agent 话术合同；共享 PRD/API总览/索引由主线程整合。

## 非目标 / Deferred

不实现代码/测试/迁移/CI，不改旧迁移、不读写.env、不改A2/A3/brief/通知投影/生产取消；不接全IANA、在线更新、客户端换算或通用健康/故障框架。目标市场、LLM供应商、外部推送、计费等既有Deferred保持冻结。

## 合入与取证边界

这是独立契约草案，PR只 `Refs #30`，不关闭issue。review + 固定五门 SUCCESS + CLEAN 合入后才实施；保留D1–D10及Bun1.4.2/OpenSpec1.3.1。实施、有效回归、真实Web/缺失部署证据、独立证据审查、最终五门与archive均未执行，不把mock坏规则或readyz200当完整A4。
