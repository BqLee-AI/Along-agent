'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { ConversationListPageSchema, type ConversationListItem } from '@along/contracts';
import { readHistoryCollectionPage } from '../../lib/conversation-run';
import { ReadControls, useHistoryPage } from './HistoryResource';
import Chat from './Chat';

export default function HistoryList() {
  const [composing, setComposing] = useState(false);
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
    <section className="conversation-history">
      <h1>会话历史</h1>
      <p className="subtitle">
        来自服务端的本人会话，按建立时间从新到旧排列；不是最近活跃排序。打开历史只读取，不会自动执行。
      </p>
      <div className="actions">
        <button type="button" onClick={() => setComposing(true)} disabled={composing}>
          新对话
        </button>
      </div>
      {composing ? (
        <div className="panel">
          <Chat />
        </div>
      ) : null}
      <h2>已存会话</h2>
      {state.loaded && !state.reading && !state.error && !state.items.length ? (
        <p>当前没有已存会话。点击“新对话”明确发送第一条原话。</p>
      ) : null}
      <ul className="card-list">
        {state.items.map((item) => (
          <li className="panel" key={item.conversation_id}>
            <Link
              className="history-link"
              href={`/conversations?${new URLSearchParams({ conversation_id: item.conversation_id })}`}
            >
              {item.title}
            </Link>
            <p className="muted">
              状态：{item.status} · 会话 {item.conversation_id}
            </p>
            <p className="muted">
              建立：<time dateTime={item.created_at}>{item.created_at}</time>
            </p>
            <p className="muted">最新已存消息 / Run 事实：{item.last_activity_at ?? '尚无记录'}</p>
          </li>
        ))}
      </ul>
      <ReadControls state={state} read={read} label="会话列表" />
      <p className="muted">
        分页不是跨请求快照。较晚提交的新事实请显式刷新查找，不会因读取而补发任何操作。
      </p>
    </section>
  );
}
