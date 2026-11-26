'use client';

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { isWorkspacePath, shellLocation } from '@/shell/model/navigation';
import { isSameReadingPage, watchHistoryNavigation } from '../model/stream-navigation';

type Identity = { conversationId: string; runId: string };

/** Guard navigation only while a request-bound run owns the connection. */
export function useConversationNavigationGuard({
  botId,
  streaming,
  lifecycle,
  conversation,
  selected,
  leaveAllowed,
  leaveAction,
  setLeaving,
}: {
  botId: string;
  streaming: boolean;
  lifecycle: string | undefined;
  conversation: RefObject<string | null>;
  selected: RefObject<Identity | null>;
  leaveAllowed: RefObject<boolean>;
  leaveAction: RefObject<(() => void) | null>;
  setLeaving: (value: boolean) => void;
}) {
  useEffect(() => {
    if (!streaming || lifecycle === 'server-owned') return;
    const leavesConversation = (url: string) => {
      const destination = new URL(url, location.href);
      if (destination.origin !== location.origin) return true;
      if (shellLocation(destination.pathname, destination.search).invalid) return true;
      const bid = destination.searchParams.get('bot_id');
      if (bid !== null && bid !== botId) return true;
      if (isWorkspacePath(destination.pathname)) {
        const cid = destination.searchParams.get('conversation_id');
        if (bid !== null && cid === null) return true;
        const rid = destination.searchParams.get('run_id');
        return (
          (cid !== null && cid !== conversation.current) ||
          (rid !== null && rid !== selected.current?.runId)
        );
      }
      if (destination.pathname !== '/conversations') return true;
      return (
        destination.searchParams.get('conversation_id') !== conversation.current ||
        Boolean(
          destination.searchParams.get('run_id') &&
          destination.searchParams.get('run_id') !== selected.current?.runId,
        )
      );
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (leaveAllowed.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        isSameReadingPage(destination.href, location.href) ||
        !leavesConversation(destination.href)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      leaveAction.current = () => window.location.assign(destination.href);
      setLeaving(true);
    };
    const unwatchHistory = watchHistoryNavigation((action) => {
      leaveAction.current = action;
      setLeaving(true);
    }, leavesConversation);
    document.addEventListener('click', click, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      document.removeEventListener('click', click, true);
      window.removeEventListener('beforeunload', unload);
      unwatchHistory();
    };
  }, [botId, streaming, lifecycle, conversation, selected, leaveAllowed, leaveAction, setLeaving]);
}
