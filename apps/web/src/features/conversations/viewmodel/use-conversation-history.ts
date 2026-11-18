'use client';

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ConversationListPageSchema } from '@along/contracts';
import type { ConversationListItem } from '@along/contracts';
import { readHistoryCollectionPage } from '@/shared/http/page';
import { api } from '@/shared/http/eden';
import type { HistoryPageState } from '@/shared/http/page';
import { useHistoryPage } from '@/shared/http/use-page';

export interface ConversationHistoryResource {
  state: HistoryPageState<ConversationListItem>;
  read: (reset: boolean) => Promise<void>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  matches: ConversationListItem[];
}

export function useConversationHistory(): ConversationHistoryResource {
  const [search, setSearch] = useState('');
  const loader = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    const query = { limit: '20', ...(cursor !== null ? { cursor } : {}) };
    const page = await readHistoryCollectionPage(
      api.api.v1.conversations.get({ query, fetch: { signal } }),
      ConversationListPageSchema,
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
