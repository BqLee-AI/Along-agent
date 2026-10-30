'use client';

import Link from 'next/link';
import Chat from './Chat';

export default function HistoryDetail({
  conversationId,
  runId,
}: {
  conversationId: string;
  runId: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 sm:px-6">
        <nav aria-label="会话位置" className="flex min-w-0 items-center gap-3 text-sm">
          <Link
            className="inline-flex min-h-11 shrink-0 items-center text-muted-foreground hover:text-foreground"
            href="/conversations"
          >
            全部会话
          </Link>
          <span className="text-border" aria-hidden="true">
            /
          </span>
          <h1 className="truncate text-sm font-medium">会话 {conversationId.slice(0, 8)}</h1>
        </nav>
        <a
          className="inline-flex min-h-11 shrink-0 items-center text-sm text-muted-foreground hover:text-foreground"
          href="/conversations"
        >
          新对话
        </a>
      </header>
      <Chat conversationId={conversationId} runId={runId} />
    </div>
  );
}
