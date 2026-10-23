## 关联

<!-- Refs #N 或 Closes #N（只有带 archive 的收口 PR 写 Closes，其余一律 Refs） -->

## Before / After

<!-- 行为变化一句话 + 前后对比：改了什么行为，调用方/用户可见什么差异 -->

- Before:
- After:

## Spec

<!-- 路径 §章节，必填，如 docs/design/03-v0-vertical-slice.md §2；有行为契约再加 openspec 路径 -->

Spec:（可填 openspec/changes/<name>/proposal.md 或 docs/design 路径 §章节）

## Compatibility & Migration

<!-- 坏了什么、不兼容点、迁移/回滚路径；无则写"无" -->

## Verification

<!-- 按 CONTRIBUTING.md §6.1 说明策略和保护的行为：测试先行 / 复用覆盖 / 先探索 / 不适用，由实现者自主选择。 -->
<!-- 测试先行须给出 Red 命令及目标失败原因、Green 命令与结果；其他策略给对应覆盖/实验/检查依据，不强填 Red。 -->
<!-- 以下记录实际命令、结果和适用版本；环境失败、事后补测或变异证据不冒充 TDD，不要求红色 commit。 -->

- 测试策略与证据：
- 真实路径验证：（实际用户/API/数据库/跨语言/工具产物；不适用说明原因与替代检查）

- [ ] `bun run verify` 通过（含 typecheck、lint、unit 与阻塞式 format:check）
- [ ] `bun run test:contracts` 通过（API 进程内/HTTP 双跑及契约包）
- [ ] 相关真实 PostgreSQL 16 测试通过（`bun run test:integration` 全部 9 个 DB 文件 / `bun run test:scheduler` D9 指定集；不适用须说明）
- [ ] `openspec validate <name> --strict` 通过（如有 change）

<!-- 没跑什么 + 原因，未跑项必填 -->

未跑项：

## 验收证据

<!-- CI 链接 / 测试输出 / 变红 PR 链接 -->

<!-- Required checks：static、migration-scan、scheduler-fault、contracts-dual、compose-smoke；须全部通过。 -->

## Reviewer focus

<!-- 请 reviewer 重点看哪里：风险点、不确定处、需拍板处 -->

## 未触碰的 Deferred 声明

<!-- 本 PR 明确没动哪些 Deferred，如鉴权/LLM/市场/推送/计费 -->

## AI assistance

<!-- 是否用 AI 辅助；用则写工具名 + 人工复核了什么；没用写"无" -->

## OpenSpec change

<!-- 路径 openspec/changes/<name> 或 无：原因（纯文档/脚手架/CI 类按 config.yaml 可不建 change） -->

- [ ] tasks.md 已勾选对应项
- [ ] 收口 PR 已 archive（非收口 PR 不勾）

## Checklist

<!-- 提交前自查 -->

- [ ] 一个 PR 只做一件事；提交信息英文 `type(area): description`
- [ ] 改 `docs/design/` 已同步 `docs/prd/` 与 `docs/README.md`
- [ ] 未引入 S0 冻结别名；未猜 Deferred 字段
