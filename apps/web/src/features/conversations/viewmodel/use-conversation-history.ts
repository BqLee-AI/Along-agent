'use client';

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ConversationListItem } from '@along/contracts';
import { readBotConversations } from '../model/personal-bot';
import type { HistoryPageState } from '@/shared/http/page';
import { useHistoryPage } from '@/shared/http/use-page';

export interface ConversationHistoryResource {
  botId: string;
  state: HistoryPageState<ConversationListItem>;
  read: (reset: boolean) => Promise<void>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  matches: ConversationListItem[];
}

export function useConversationHistory(botId: string): ConversationHistoryResource {
  const [search, setSearch] = useState('');
  const loader = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const page = await readBotConversations(botId, cursor, signal);
      return { items: page.items, nextCursor: page.next_cursor };
    },
    [botId],
  );
  const { state, read } = useHistoryPage<ConversationListItem>(
    `bot-conversations:${botId}`,
    loader,
  );
  const matches = state.items.filter((item) =>
    (item.title || item.conversation_id)
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return { botId, state, read, search, setSearch, matches };
}
