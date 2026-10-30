'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { ConversationListPageSchema, type ConversationListItem } from '@along/contracts';
import { History } from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Card } from '@lorelum/lumen-ui/components/card';
import type { TaskIntent } from '@/features/conversations/task-model';
import { readHistoryCollectionPage } from '../../lib/conversation-run';
import { ReadControls, useHistoryPage } from './HistoryResource';
import Chat from './Chat';

export default function HistoryList({
  initialIntent = 'chat',
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
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
        <h1 className="text-base font-medium">对话</h1>
        <details id="conversation-history" className="group">
          <summary className="flex min-h-11 list-none items-center gap-2 px-3 text-sm text-muted-foreground">
            <History className="size-4" aria-hidden="true" />
            历史会话
          </summary>
          <Card
            material="panel"
            role="region"
            aria-label="已存会话"
            className="absolute top-full right-3 left-3 max-h-[65dvh] space-y-4 overflow-y-auto px-4 sm:left-auto sm:w-96"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base">已存会话</h2>
              <span className="text-xs text-muted-foreground">打开只读取</span>
            </div>
            {state.loaded && !state.reading && !state.error && !state.items.length ? (
              <p className="text-sm text-muted-foreground">还没有已存会话。</p>
            ) : null}
            <ul className="divide-y divide-border">
              {state.items.map((item) => (
                <li className="min-w-0 py-3 [overflow-wrap:anywhere]" key={item.conversation_id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
                      href={`/conversations?${new URLSearchParams({ conversation_id: item.conversation_id })}`}
                    >
                      {item.title || `会话 ${item.conversation_id.slice(0, 8)}`}
                    </Link>
                    <Badge variant="glass">{item.status === 'open' ? '开放' : '已关闭'}</Badge>
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
            <p className="text-xs text-muted-foreground">
              按建立时间排序；分页不是跨请求快照，读取不会发送或继续运行。
            </p>
          </Card>
        </details>
      </header>
      <Chat initialIntent={initialIntent} />
    </div>
  );
}
