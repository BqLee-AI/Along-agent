'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isNearChatBottom } from '../model/task';

/** One owner for follow state; streaming growth only schedules a frame. */
export function useConversationScroll(identity: string | null) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const frame = useRef<number | null>(null);
  const pendingScroll = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const scroll = viewport.current;
      if (!scroll || !scroll.clientHeight) return;
      // Finish all geometry reads before the optional scroll write.
      const height = scroll.scrollHeight;
      const top = scroll.scrollTop;
      const clientHeight = scroll.clientHeight;
      if (pendingScroll.current) {
        following.current = isNearChatBottom({
          scrollHeight: height,
          scrollTop: top,
          clientHeight,
        });
        pendingScroll.current = false;
      }
      setShowLatest(!following.current);
      if (following.current) scroll.scrollTop = height;
    });
  }, []);
  useEffect(() => {
    const scroll = viewport.current;
    const body = content.current;
    if (!scroll || !body) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(body);
    observer.observe(scroll);
    schedule();
    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule]);
  useEffect(() => {
    following.current = true;
    pendingScroll.current = false;
    setShowLatest(false);
    schedule();
  }, [identity, schedule]);
  const onScroll = useCallback(() => {
    pendingScroll.current = true;
    schedule();
  }, [schedule]);
  const jumpLatest = useCallback(() => {
    following.current = true;
    pendingScroll.current = false;
    setShowLatest(false);
    schedule();
  }, [schedule]);
  const locate = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target || !viewport.current?.contains(target)) return;
    let ancestor: HTMLElement | null = target;
    while (ancestor && ancestor !== viewport.current) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    following.current = false;
    pendingScroll.current = false;
    setShowLatest(true);
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
  }, []);
  return { viewport, content, showLatest, onScroll, jumpLatest, locate };
}
