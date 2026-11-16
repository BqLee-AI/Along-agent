'use client';

import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { RunView } from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { followRunEvents, readRun } from '../model/conversation-run';

type Identity = { conversationId: string; runId: string };

/** Owns the read-only server-owned subscription; accepted events stay with the Run owner. */
export function useConversationFollow({
  selected,
  run,
  streaming,
  generation,
  followRef,
  followed,
  mounted,
  selectionVersion,
  cursors,
  acceptEvent,
  setLiveReply,
  setRun,
  refresh,
  setReadError,
}: {
  selected: Identity | null;
  run: RunView | null;
  streaming: boolean;
  generation: number;
  followRef: RefObject<AbortController | null>;
  mounted: RefObject<boolean>;
  followed: RefObject<string | null>;
  selectionVersion: RefObject<number>;
  cursors: RefObject<Map<string, number>>;
  acceptEvent: (event: ThreadEvent) => void;
  setLiveReply: (value: boolean) => void;
  setRun: (value: RunView) => void;
  refresh: () => Promise<void>;
  setReadError: (value: string) => void;
}) {
  useEffect(() => {
    if (
      !selected ||
      !run ||
      run.run_id !== selected.runId ||
      run.execution_lifecycle !== 'server-owned' ||
      run.status !== 'running' ||
      streaming
    )
      return;
    const target = selected;
    const key = `${target.conversationId}:${target.runId}:${generation}`;
    if (followed.current === key) return;
    followed.current = key;
    const controller = new AbortController();
    followRef.current = controller;
    const version = selectionVersion.current;
    const valid = () =>
      mounted.current && !controller.signal.aborted && version === selectionVersion.current;
    let automaticPause = false;
    void (async () => {
      try {
        await followRunEvents({
          conversationId: target.conversationId,
          runId: target.runId,
          signal: controller.signal,
          cursor: () => cursors.current.get(target.runId) ?? 0,
          onEvent: (event) => {
            if (!valid()) return;
            acceptEvent(event);
            if (event.type === 'message.delta') setLiveReply(true);
          },
          readStatus: async () => {
            const current = await readRun(target.conversationId, target.runId, controller.signal);
            if (
              current.conversation_id !== target.conversationId ||
              current.run_id !== target.runId
            )
              throw new Error('运行身份不匹配，未接纳状态。');
            if (
              valid() &&
              current.status === 'paused' &&
              current.pause?.reason === 'runtime' &&
              current.pause.purpose === 'automatic_compact'
            ) {
              automaticPause = true;
              setRun(current);
            }
            return current.status;
          },
        });
        if (valid() && !automaticPause) await refresh();
      } catch (failure) {
        if (valid())
          setReadError(
            `${failure instanceof Error ? failure.message : '事件连接中断。'} 请读取最新状态后重试跟随；不会重发原请求。`,
          );
      } finally {
        if (followRef.current === controller) followRef.current = null;
      }
    })();
    return () => {
      controller.abort();
      if (followRef.current === controller) followRef.current = null;
    };
    // Identity, frozen lifecycle and status determine subscription ownership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected?.conversationId,
    selected?.runId,
    run?.run_id,
    run?.execution_lifecycle,
    run?.status,
    streaming,
    generation,
  ]);
}
