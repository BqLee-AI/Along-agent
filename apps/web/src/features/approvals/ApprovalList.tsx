'use client';

import Link from 'next/link';
import { useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { EmptyState, ErrorNotice } from '@/components/page';
import {
  historyPageReducer,
  initialHistoryPage,
  readHistoryCollectionPage,
} from '@/lib/conversation-run';
import {
  ApprovalPageSchema,
  approvalListPath,
  approvalStatusLabels,
  type ApprovalFilter,
  type ApprovalPage,
} from './model';

type Item = ApprovalPage['items'][number];
export default function ApprovalList({
  status,
  initial,
  initialError,
}: {
  status: ApprovalFilter;
  initial: ApprovalPage | null;
  initialError: string | null;
}) {
  const [state, dispatch] = useReducer(historyPageReducer<Item>, {
    ...initialHistoryPage<Item>(status),
    items: initial?.items ?? [],
    nextCursor: initial?.next_cursor ?? null,
    loaded: initial !== null,
    error: initialError,
  });
  const [readError, setReadError] = useState(initialError);
  const request = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function load(reset: boolean) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const id = ++request.current;
    dispatch({ type: 'start', target: status, request: id, reset });
    try {
      const page = await readHistoryCollectionPage(
        approvalListPath(status, reset ? null : state.nextCursor),
        ApprovalPageSchema,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        dispatch({
          type: 'success',
          target: status,
          request: id,
          items: page.items,
          nextCursor: page.next_cursor,
        });
        setReadError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const message = failure instanceof Error ? failure.message : '提醒确认暂不可读取。';
        dispatch({ type: 'failure', target: status, request: id, error: message });
        setReadError(message);
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  return (
    <div className="space-y-6" aria-busy={state.reading}>
      <p className="text-sm text-muted-foreground" role="status">
        读取到 {state.items.length} 条 · {approvalStatusLabels[status]} ·{' '}
        {state.loaded
          ? state.nextCursor
            ? '仍有后续页，尚未读完'
            : '本筛选读取至末页'
          : '范围尚未读取'}
        。按建立时间倒序，每页最多 50 条。
      </p>
      {state.items.length ? (
        <ul className="divide-y divide-border border-y border-border">
          {state.items.map((item) => (
            <li
              key={item.approval_id}
              className="flex min-h-24 min-w-0 flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    className="font-medium text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                    href={`/approvals/${item.approval_id}`}
                  >
                    {item.title}
                  </Link>
                  <Badge variant="glass">{approvalStatusLabels[item.status]}</Badge>
                </div>
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  有效期至 {item.expires_at}
                </p>
              </div>
              <Button
                variant="glass"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href={`/approvals/${item.approval_id}`} />}
              >
                审阅提议
              </Button>
            </li>
          ))}
        </ul>
      ) : state.loaded ? (
        <EmptyState
          title="本筛选没有提醒提议"
          description="可切换状态查看已处理的提议；文档批准请从原会话进入。"
        />
      ) : null}
      {readError ? (
        <ErrorNotice message={readError}>
          <p>先前内容与后续游标仍保留；重读只发送 GET。</p>
          <Button
            variant="glass"
            color="default"
            disabled={state.reading}
            onClick={() => void load(!state.loaded || state.resetting)}
          >
            重试{!state.loaded || state.resetting ? '首批读取' : '后续页'}
          </Button>
        </ErrorNotice>
      ) : null}
      {state.reading ? (
        <p role="status" className="text-muted-foreground">
          正在读取提醒确认，已有内容仍可审阅…
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {state.nextCursor ? (
          <Button
            variant="glass"
            color="default"
            disabled={state.reading}
            onClick={() => void load(false)}
          >
            继续读取提醒确认
          </Button>
        ) : null}
        <Button
          variant="clear"
          color="default"
          disabled={state.reading}
          onClick={() => void load(true)}
        >
          重新读取首批
        </Button>
      </div>
    </div>
  );
}
