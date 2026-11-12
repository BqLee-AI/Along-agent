'use client';

import Link from '@/shell/view/workspace-link';
import { memo, useCallback, useEffect, useState } from 'react';
import type { ConversationListItem } from '@along/contracts';
import { ArrowUpRight, History, Search } from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { useConversationHistory } from '../viewmodel/use-conversation-history';
import { ReadControls } from '@/shared/ui/read-controls';

const HistoryRow = memo(function HistoryRow({
  item,
  onOpen,
}: {
  item: ConversationListItem;
  onOpen: () => void;
}) {
  return (
    <li className="min-w-0 py-4 [overflow-wrap:anywhere]">
      <div className="flex items-start justify-between gap-3">
        <Link
          className="inline-flex min-h-8 max-lg:min-h-11 min-w-0 flex-1 items-center gap-2 text-sm leading-6 font-medium text-brand-ink underline-offset-4 hover:underline"
          onClick={onOpen}
          href={`/conversations?${new URLSearchParams({ conversation_id: item.conversation_id })}`}
        >
          <span className="min-w-0">
            {item.title || `会话 ${item.conversation_id.slice(0, 8)}`}
          </span>
          <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
        </Link>
        <Badge variant="glass">{item.status === 'open' ? '开放' : '已关闭'}</Badge>
      </div>
      <details className="text-sm leading-[22px] text-secondary-foreground">
        <summary className="min-h-8 max-lg:min-h-11 cursor-pointer content-center">
          建立时间与记录信息
        </summary>
        <p>
          建立：<time dateTime={item.created_at}>{item.created_at}</time>
        </p>
        <p>
          最近已存活动：{item.last_activity_at ?? '尚无记录'} · 辅助短号{' '}
          {item.conversation_id.slice(0, 8)}
        </p>
      </details>
    </li>
  );
});

export const ConversationHistory = memo(function ConversationHistory() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { state, read, search, setSearch, matches } = useConversationHistory();
  const openConversation = useCallback(() => setHistoryOpen(false), []);
  useEffect(() => {
    if (window.location.hash === '#conversation-history') setHistoryOpen(true);
  }, []);
  return (
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <Dialog.Trigger render={<Button variant="clear" color="default" aria-label="历史会话" />}>
        <History className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">历史</span>
      </Dialog.Trigger>
      <Dialog.Content className="flex max-h-[85dvh] max-w-xl flex-col">
        <Dialog.Header>
          <Dialog.Title>历史会话</Dialog.Title>
          <Dialog.Description>
            找回之前的对话。打开只读取原记录，不会发送或继续运行。
          </Dialog.Description>
        </Dialog.Header>
        <div className="flex items-center gap-3 py-3">
          <Search className="size-4 shrink-0 text-secondary-foreground" aria-hidden="true" />
          <Label htmlFor="conversation-search" className="sr-only">
            筛选已加载的会话
          </Label>
          <Input
            id="conversation-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="筛选已加载的会话"
            variant="glass"
            className="w-full"
          />
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain py-2">
          {state.loaded && !state.reading && !state.error && !state.items.length ? (
            <p className="py-8 text-center text-sm leading-[22px] text-secondary-foreground">
              还没有已存会话，从一段新对话开始。
            </p>
          ) : null}
          {search.trim() && state.items.length > 0 && !matches.length ? (
            <p className="py-6 text-sm leading-[22px] text-secondary-foreground">
              已加载的会话中没有匹配项。可以清空筛选，或继续读取更多记录。
            </p>
          ) : null}
          <ul className="divide-y divide-separator">
            {matches.map((item) => (
              <HistoryRow key={item.conversation_id} item={item} onOpen={openConversation} />
            ))}
          </ul>
          <ReadControls state={state} read={read} label="会话列表" />
        </div>
        <p className="pt-3 text-sm leading-[22px] text-secondary-foreground">
          按建立时间排序；筛选仅作用于已加载范围，分页不是跨请求快照。
        </p>
      </Dialog.Content>
    </Dialog>
  );
});
