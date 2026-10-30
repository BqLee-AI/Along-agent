'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  historyPageReducer,
  initialHistoryPage,
  type HistoryPageState,
} from '../../lib/conversation-run';
import { Button } from '@lorelum/lumen-ui/components/button';
import { ErrorNotice } from '@/components/page';

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

export function ReadControls({
  state,
  read,
  label,
}: {
  state: Pick<
    HistoryPageState<unknown>,
    'reading' | 'error' | 'loaded' | 'resetting' | 'nextCursor'
  >;
  read: (reset: boolean) => Promise<void>;
  label: string;
}) {
  return (
    <div className="space-y-3 py-4">
      {state.reading ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取{label}…
        </p>
      ) : null}
      {state.error ? (
        <ErrorNotice
          message={`${state.loaded ? '此部分未完整读取，已获取内容仍保留。' : '读取失败，不表示没有历史。'} ${state.error}`}
        >
          <Button
            variant="glass"
            color="default"
            type="button"
            disabled={state.reading}
            onClick={() => void read(state.resetting)}
          >
            重试读取{label}（GET）
          </Button>
        </ErrorNotice>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="glass"
          color="default"
          type="button"
          disabled={state.reading}
          onClick={() => void read(true)}
        >
          刷新{label}
        </Button>
        {state.loaded && state.nextCursor !== null ? (
          <Button
            variant="glass"
            color="default"
            type="button"
            disabled={state.reading}
            onClick={() => void read(false)}
          >
            继续读取{label}
          </Button>
        ) : null}
      </div>
      {state.loaded ? (
        <p className="text-sm text-muted-foreground">
          {state.reading || state.error
            ? `${label}保留上次获取的内容；本次读取尚未确认完整。`
            : state.nextCursor !== null
              ? `${label}尚未读完。`
              : `${label}已到达本次读取范围的末尾；新事实请刷新获取。`}
        </p>
      ) : null}
    </div>
  );
}
