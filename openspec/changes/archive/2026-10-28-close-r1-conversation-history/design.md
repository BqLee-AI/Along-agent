## Context

设计真源为 [design/17](../../../../docs/design/17-r1-conversation-history.md)。变更前用户原文已保存在 messages，business/harness 新 Run 均写 input_message_id；旧 business 可能为空。Run 终结将本 Run 所有 attempt 已接受 delta 合并为 assistant message，但 messages 没有 assistant→Run 引用。外部回复与批准事件按 event_seq 持久化，内部 snapshot 被显式过滤。原 Web 缺集合发现，userTexts 只有内存，同一 Run 仅保留最后一个批准链接。

## Goals / Non-Goals

完成不依赖客户端临时状态、旧URL或模型重新执行的服务器发现与恢复。支持多Run、全部可见回复和批准结果、明确部分失败、旧深链及撤权后历史/动作边界。不做#70视觉重构、搜索平台、账户重做、R2或任意自动执行恢复。

## Decisions

1. 新增 conversations capability，归属 design/02 已有 conversations 模块，覆盖 business 与 harness。agent-runtime 负责执行、workspaces 负责授权、identity 负责登录；本 change 引用其不变量，不重定义既有主规格。
2. 新增owner-scoped集合，旧事件响应/SSE/RunView保持不变。新DTO与task批准公开结果schema归packages/contracts；既有ThreadEventSchema留stream-protocol，避免contracts反向依赖或扩包图。
3. 稳定排序采用建立时间而非会随活动移动的最新活跃时间；活动时间独立从真实消息/Run计算。keyset保留PG微秒精度，固定首屏上界，不承诺跨HTTP的数据库快照。新提交事实经刷新发现，不引入持久scan session。
4. 原话仅沿input_message_id或尚存且完整匹配的既有幂等引用读取；无引用明确不可关联。assistant主要回复按Run的全部已存外部delta投影；最终消息档案不能按内容或近邻时间强绑Run，也不能重复拼入回复。
5. task批准详情补公开真实task结果引用；document批准沿既有授权/effect分离投影。通过各模块公共读取组合，不调用ToolGateway执行/重放路径，不直读其他模块私有表。
6. Web保留/conversations及旧conversation_id/run_id深链，用URL选择历史与Run。列表、mount、读取更多、刷新、back和重登只GET。失败保留已读内容/原游标；所有批准均可达，不只显示最后一个。当前动作资格仍由RunView和原动作服务裁决。

## Alternatives

只保存URL或sessionStorage不能通过清空临时状态验收；每页按max活动时间排序会让更新搬页，offset也会漂移。持久快照/物化历史表带来第二套生命周期且无本期必要。推荐已有事实上的keyset与显式刷新。将历史全部塞入RunView会破坏strict消费者并产生无界响应，故新增有界集合、保持现有Run读合同。

## Compatibility / Migration

`0018` 迁移增加四个非唯一查询索引，不改 `0001`–`0017`、不回填虚构引用、不改 owner。三个 keyset 索引之外，`conversation_idempotency(run_id)` 支撑旧 Run 缺少 `input_message_id` 的回退查找；仍按 run_id 取全引用并保留 scope/歧义检测，不用唯一约束或预过滤改变事实解释。#67 升级沿原 SQL verifier 对真实表、键、非唯一性、有效/就绪/存活状态核验，表驱动 smoke 拒绝缺失/错误索引且不修复、不改事实。停旧写者后升级并部署同批 API/Web/contracts；不改变 Harness 协议、SSE 词表及现有动作。保留原卷、密钥与 root；失败沿既有显式升级处理，不自动重试业务写入。

## Risks / Verification

时间keyset不是跨请求MVCC快照；旧数据可缺原文/关联，必须诚实展示。独立GET不能冒充原子总快照，部分失败不能变空历史。真实浏览器/PG验证服务器重新发现、分页、隐私、结果、撤权及零读取副作用；沿现有门取证，合同、实现、运行验收及归档分别记录。

原三索引升级与 47 场景生命周期证据只属于旧状态；四索引版本的真实 PG16 EXPLAIN、53 场景 smoke、单次事件聚合及实际 Web 证据见[验证记录](../../../../docs/conversation-history-verification-2026-10-28.md)，不扩大为本轮重跑完整模型验收。
