'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isNearChatBottom } from '../model/task';

/** One owner for follow state; streaming growth only schedules a frame. */
export function useConversationScroll(identity: string | null) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const frame = useRef<number | null>(null);
  const lastTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const scroll = viewport.current;
      if (!scroll || !scroll.clientHeight) return;
      if (following.current && !isNearChatBottom(scroll)) {
        scroll.scrollTop = scroll.scrollHeight;
        lastTop.current = scroll.scrollTop;
      }
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
    lastTop.current = viewport.current?.scrollTop ?? 0;
    setShowLatest(false);
    schedule();
  }, [identity, schedule]);
  const onScroll = useCallback(() => {
    const scroll = viewport.current;
    if (!scroll || scroll.scrollTop === lastTop.current) return;
    lastTop.current = scroll.scrollTop;
    // A reader's scroll updates intent; it never schedules a scroll write.
    following.current = isNearChatBottom(scroll);
    setShowLatest(!following.current);
  }, []);
  const jumpLatest = useCallback(() => {
    following.current = true;
    setShowLatest(false);
    schedule();
  }, [schedule]);
  return { viewport, content, showLatest, onScroll, jumpLatest };
}
