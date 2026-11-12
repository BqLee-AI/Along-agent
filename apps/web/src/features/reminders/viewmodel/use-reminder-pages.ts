'use client';

import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { readNextPage } from '../model/data';
import type { PageSnapshot, ReminderPage } from '../model/data';

export function useReminderPages<T>(
  path: string,
  initial: PageSnapshot<T>,
  schema: z.ZodType<ReminderPage<T>>,
  identity: (item: T) => string,
) {
  const [resource, setResource] = useState(initial);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );
  async function load() {
    if (request.current || (resource.page && resource.page.next_cursor === null)) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const next = await readNextPage(path, resource, schema, identity, controller.signal);
      if (!controller.signal.aborted) setResource(next);
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { ...resource, busy, load };
}
