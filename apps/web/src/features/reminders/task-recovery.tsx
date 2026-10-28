'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiResult } from '@/lib/api';
import type { Me, TaskDetail } from '@/lib/types';
import { readTask, type ResourceFailure } from './data';
import { ResourceError } from './resource-ui';
import { TaskContent, TaskSummary } from './task-content';
import { TaskEvents } from './task-events';

export function TaskRecovery({
  taskId,
  initialError,
  meResult,
  activity = false,
  returnTo,
}: {
  taskId: string;
  initialError: ResourceFailure;
  meResult?: ApiResult<Me>;
  activity?: boolean;
  returnTo: string;
}) {
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
  if (task)
    return activity ? (
      <div className="space-y-8">
        <TaskSummary task={task} />
        <Button asChild variant="outline">
          <Link href={`/tasks/${encodeURIComponent(taskId)}`}>查看任务详情</Link>
        </Button>
        <TaskEvents taskId={taskId} initial={{ page: null, error: null }} returnTo={returnTo} />
      </div>
    ) : meResult ? (
      <TaskContent task={task} meResult={meResult} />
    ) : null;
  return (
    <div aria-busy={busy}>
      {error ? (
        <ResourceError error={error} returnTo={returnTo}>
          <Button variant="outline" disabled={busy} onClick={() => void recover()}>
            {busy ? '正在读取…' : '重新读取此任务详情'}
          </Button>
        </ResourceError>
      ) : null}
    </div>
  );
}
