Issue: #69

## Why

现有会话只有按ID读取事件与Run的入口；用户原话虽已持久化，Web新发原话仍仅靠React内存。退出重登且不保留旧URL后，用户不能从服务器找到原会话、原任务和结果。提醒列表及活动账不是资料任务历史，账户切片完成也不等于历史可发现。

## What Changes

- 提供owner隔离的会话发现、可见消息与Run索引及稳定分页，标题和活动时间来自持久事实，不依赖未维护的updated_at。
- Web交付列表、会话、指定Run和所有关联批准/结果的只读恢复；保留旧深链、事件、Run与批准明细。
- 用户原话仅从原消息及可信引用读取；明确旧数据缺失/不能关联的情况，不从模型回答推断。
- 列表、打开、刷新、回退及同账户重登恢复只读，不启动执行或自动重发业务POST；历史可读不恢复已撤销的工作区动作资格。
- 空、无权、不存在、依赖错误与部分读取失败分别反馈；不泄露system/internal checkpoint，不新增任务事实表。

## Spec

设计真源：[design/17](../../../docs/design/17-r1-conversation-history.md) §1–§10。API 及存储同步见 [conversation API §6](../../../docs/api/conversations/conversations_routes.md#6-r1-可发现历史与只读恢复proposed69)、[approval API §8](../../../docs/api/approvals/approvals_routes.md#8-r1-历史中的真实提醒结果proposed69) 及 [conversation schema 历史读取节](../../../docs/schema/conversation-and-runs-schema.md#r1-历史读取投影与查询索引proposed69)。

新增conversations capability，与design/02模块所有权一致；引用既有agent-runtime/workspaces/identity合同，不修改它们的执行、授权或账户语义。所有正文均为待评审合同，不表示功能已实现。

## Impact

影响conversations只读入口、approvals结果读取、packages/contracts、Web历史/批准消费者、对应行为测试，以及#67新增迁移核验。复用现有消息、Run、事件与模块公共只读投影；不改SSE词表、Harness协议或既有动作入口。

## 非目标 / Deferred

不做#70全站导航/视觉/目标入口、登录机制修改、R2、搜索/FTS/向量、跨owner合并、导入导出、后台自动恢复、第二份资料任务事实表、缓存/队列/持久扫描会话、provider/模型/路由/秘密配置或用户数据库操作。本change的规划和合同PR不归档、不关闭#69/#66。
