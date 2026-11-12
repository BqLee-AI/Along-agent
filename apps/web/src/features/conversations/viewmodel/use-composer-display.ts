'use client';

import { useCallback, useEffect, useRef } from 'react';

export function useComposerDisplay(value: string) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = textarea.current;
      if (!input) return;
      input.style.height = 'auto';
      const height = input.scrollHeight;
      input.style.height = `${Math.min(height, 160)}px`;
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return textarea;
}

export function useComposerFocus() {
  return useCallback(() => document.getElementById('task-message')?.focus(), []);
}
