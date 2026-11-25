'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { ErrorNotice } from '@/shared/ui/page';
import type { HistoryPageState } from '../http/page';

export function ReadControls({
  state,
  read,
  label,
  compact = false,
}: {
  state: Pick<
    HistoryPageState<unknown>,
    'reading' | 'error' | 'loaded' | 'resetting' | 'nextCursor'
  >;
  read: (reset: boolean) => Promise<void>;
  label: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'space-y-3' : 'space-y-3 py-4'}>
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
          size={compact ? 'icon' : undefined}
          aria-label={compact ? `刷新${label}` : undefined}
          title={compact ? `刷新${label}` : undefined}
          disabled={state.reading}
          onClick={() => void read(true)}
        >
          {compact ? <RefreshCw className="size-4" aria-hidden="true" /> : `刷新${label}`}
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
      {state.loaded && (!compact || state.reading || state.error) ? (
        <p className="text-xs leading-6 text-muted-foreground">
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
