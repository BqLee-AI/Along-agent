'use client';

import { useEffect, useRef, useState } from 'react';
import { readTask } from '../model/data';
import type { ResourceFailure } from '../model/data';
import type { TaskDetail } from '../model/types';

export function useReminderDetail(taskId: string, initialError: ResourceFailure) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<ResourceFailure | null>(initialError);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function recover() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await readTask(taskId, controller.signal);
      if (!controller.signal.aborted) {
        if (result.ok) {
          setTask(result.data);
          setError(null);
        } else setError(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { task, error, busy, recover };
}
