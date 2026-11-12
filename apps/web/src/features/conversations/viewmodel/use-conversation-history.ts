'use client';

import { useCallback, useState } from 'react';
import { ConversationListPageSchema } from '@along/contracts';
import type { ConversationListItem } from '@along/contracts';
import { readHistoryCollectionPage } from '@/shared/http/page';
import { useHistoryPage } from '@/shared/http/use-page';

export function useConversationHistory() {
  const [search, setSearch] = useState('');
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
  const matches = state.items.filter((item) =>
    (item.title || item.conversation_id)
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return { state, read, search, setSearch, matches };
}
