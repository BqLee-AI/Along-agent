'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { historyPageReducer, initialHistoryPage } from './page';

export interface HistoryReadPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function useHistoryPage<T>(
  target: string,
  loader: (cursor: string | null, signal: AbortSignal) => Promise<HistoryReadPage<T>>,
) {
  const [state, dispatch] = useReducer(historyPageReducer<T>, initialHistoryPage<T>(target));
  const current = useRef(state);
  current.current = state;
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(
    async (reset: boolean) => {
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      const identity = ++request.current;
      const cursor = reset ? null : current.current.nextCursor;
      dispatch({ type: 'start', target, request: identity, reset });
      try {
        const page = await loader(cursor, active.signal);
        if (active.signal.aborted) return;
        dispatch({
          type: 'success',
          target,
          request: identity,
          items: page.items,
          nextCursor: page.nextCursor,
        });
      } catch (failure) {
        if (active.signal.aborted) return;
        dispatch({
          type: 'failure',
          target,
          request: identity,
          error: failure instanceof Error ? failure.message : '读取失败；尚未确认此部分历史。',
        });
      }
    },
    [target, loader],
  );

  useEffect(() => {
    void read(true);
    return () => controller.current?.abort();
  }, [read]);

  return { state, read };
}
