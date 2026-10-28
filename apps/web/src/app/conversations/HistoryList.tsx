'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { ConversationListPageSchema, type ConversationListItem } from '@along/contracts';
import { PageHeading, EmptyState } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import type { TaskIntent } from '@/features/conversations/task-model';
import { readHistoryCollectionPage } from '../../lib/conversation-run';
import { ReadControls, useHistoryPage } from './HistoryResource';
import Chat from './Chat';

export default function HistoryList({
  initialIntent = null,
}: {
  initialIntent?: TaskIntent | null;
}) {
  const loader = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor !== null) query.set('cursor', cursor);
    const page = await readHistoryCollectionPage(
      `/api/v1/conversations?${query}`,
      ConversationListPageSchema,
      signal,
    );
    return { items: page.items, nextCursor: page.next_cursor };
  }, []);
  const { state, read } = useHistoryPage<ConversationListItem>('conversations', loader);
  return (
    <div className="space-y-8 md:space-y-12">
      <PageHeading
        title="对话"
        description="开始新任务，或找回原话、回复与真实结果。资料任务在这里保留，不混入提醒任务。"
      />
      <Chat initialIntent={initialIntent} />
      <section id="conversation-history" className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">已存会话</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            按建立时间从新到旧，不是最近活跃排序。打开历史只读取，不自动执行。
          </p>
        </div>
        {state.loaded && !state.reading && !state.error && !state.items.length ? (
          <EmptyState title="还没有已存会话" description="在上方选择目标并明确提交第一条原话。" />
        ) : null}
        <ul className="divide-y divide-border">
          {state.items.map((item) => (
            <li className="min-w-0 py-5 [overflow-wrap:anywhere]" key={item.conversation_id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <Link
                  className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
                  href={`/conversations?${new URLSearchParams({ conversation_id: item.conversation_id })}`}
                >
                  {item.title || `会话 ${item.conversation_id.slice(0, 8)}`}
                </Link>
                <Badge variant="outline">{item.status === 'open' ? '开放' : '已关闭'}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                建立：<time dateTime={item.created_at}>{item.created_at}</time>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                最近已存活动：{item.last_activity_at ?? '尚无记录'} · 辅助短号{' '}
                {item.conversation_id.slice(0, 8)}
              </p>
            </li>
          ))}
        </ul>
        <ReadControls state={state} read={read} label="会话列表" />
        <p className="text-sm text-muted-foreground">
          分页不是跨请求快照；新提交事实请显式刷新。读取不会补发任何操作。
        </p>
      </section>
    </div>
  );
}
