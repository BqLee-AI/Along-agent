'use client';

import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { readAccountCollection } from '../model/account-actions';

/** Read-only cursor pagination over a protected account collection; never replays a write. */
export function useAccountCollection<T extends { id: string }>(
  path: string,
  schema: z.ZodType<{ items: T[]; next_cursor: string | null }>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(next: string | null = null) {
    setBusy(true);
    setError(null);
    try {
      const result = await readAccountCollection(
        `${path}${next ? `?${new URLSearchParams({ cursor: next })}` : ''}`,
        schema,
      );
      setItems((old) => (next ? [...old, ...result.items] : result.items));
      setCursor(result.next_cursor);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [path]);

  return { items, cursor, busy, error, load };
}
