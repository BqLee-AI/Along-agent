'use client';

import Link from '@/shell/view/workspace-link';
import { memo } from 'react';
import { ChevronsDown, PanelLeftClose, RefreshCw } from 'lucide-react';
import type { ConversationHistoryResource } from '../viewmodel/use-conversation-history';
import { botHref } from '../model/personal-bot';
import { Brand } from '@/shared/ui/brand';

const iconButton =
  'inline-flex size-8 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

/** Navigation only: opening a conversation reads its record and never sends or resumes. */
export const ConversationSidebar = memo(function ConversationSidebar({
  activeId,
  history,
  onCollapse,
}: {
  history: ConversationHistoryResource;
  activeId: string | null;
  onCollapse: () => void;
}) {
  const { botId, state, read } = history;
  return (
    <aside
      aria-label="会话"
      data-testid="conversation-sidebar"
      className="flex h-full w-64 shrink-0 flex-col border-r border-separator bg-foreground/5 backdrop-blur-xl dark:bg-foreground/[0.03]"
    >
      <div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-4">
        <Brand height={20} />
        <button
          type="button"
          className={iconButton}
          aria-label="收起会话栏"
          title="收起会话栏"
          onClick={onCollapse}
        >
          <PanelLeftClose className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-center justify-between pr-2 pl-4">
        <h2 className="py-2 text-xs font-medium text-muted-foreground">当前 Bot 的会话</h2>
        <button
          type="button"
          className={iconButton}
          aria-label="刷新会话列表"
          title="刷新会话列表"
          disabled={state.reading}
          onClick={() => void read(true)}
        >
          <RefreshCw
            className={`size-3.5 ${state.reading ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>
      <nav
        aria-label="历史会话"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
      >
        {state.reading && !state.loaded ? (
          <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
            正在读取会话…
          </p>
        ) : null}
        {state.error ? (
          <p role="alert" className="px-2 py-2 text-[13px] text-muted-foreground">
            读取失败，不表示没有历史。点上方刷新重试。
          </p>
        ) : null}
        {state.loaded && !state.reading && !state.error && !state.items.length ? (
          <p className="px-2 py-3 text-[13px] text-muted-foreground">还没有已存会话</p>
        ) : null}
        <ul className="space-y-0.5">
          {state.items.map((item) => (
            <li key={item.conversation_id}>
              <Link
                href={botHref(botId, item.conversation_id)}
                aria-current={item.conversation_id === activeId ? 'page' : undefined}
                className={`block truncate rounded-control px-2 py-1.5 text-[13px] leading-5 focus-visible:outline-2 focus-visible:outline-ring ${item.conversation_id === activeId ? 'bg-muted font-medium text-foreground' : 'text-secondary-foreground hover:bg-muted hover:text-foreground'}`}
              >
                {item.title || `会话 ${item.conversation_id.slice(0, 8)}`}
              </Link>
            </li>
          ))}
        </ul>
        {state.loaded && state.nextCursor !== null ? (
          <div className="flex justify-center py-2">
            <button
              type="button"
              className={iconButton}
              aria-label="继续读取会话列表"
              title="继续读取会话列表"
              disabled={state.reading}
              onClick={() => void read(false)}
            >
              <ChevronsDown className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </nav>
    </aside>
  );
});
