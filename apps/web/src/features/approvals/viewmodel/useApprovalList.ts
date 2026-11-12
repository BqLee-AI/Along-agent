'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import {
  historyPageReducer,
  initialHistoryPage,
  readHistoryCollectionPage,
} from '@/shared/http/page';
import { ApprovalPageSchema, approvalListPath } from '../model/approval';
import type { ApprovalFilter, ApprovalPage } from '../model/approval';

export interface ApprovalListProps {
  status: ApprovalFilter;
  initial: ApprovalPage | null;
  initialError: string | null;
}

export function useApprovalList({ status, initial, initialError }: ApprovalListProps) {
  type Item = ApprovalPage['items'][number];
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

  return { state, readError, load };
}
