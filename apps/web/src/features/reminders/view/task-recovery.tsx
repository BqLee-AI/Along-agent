'use client';

import Link from '@/shell/view/workspace-link';
import { Button } from '@lorelum/lumen-ui/components/button';
import type { ApiResult } from '@/shared/http/result';
import type { Me } from '@/shared/session/identity';
import type { ResourceFailure } from '../model/data';
import { useReminderDetail } from '../viewmodel/use-reminder-detail';
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
  const { task, error, busy, recover } = useReminderDetail(taskId, initialError);
  if (task)
    return activity ? (
      <div className="min-w-0 space-y-6">
        <TaskSummary task={task} />
        <Button
          variant="glass"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href={`/tasks/${encodeURIComponent(taskId)}`} />}
        >
          查看任务详情
        </Button>
        <TaskEvents taskId={taskId} initial={{ page: null, error: null }} returnTo={returnTo} />
      </div>
    ) : meResult ? (
      <TaskContent task={task} meResult={meResult} />
    ) : null;
  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      {error ? (
        <ResourceError error={error} returnTo={returnTo}>
          <Button variant="glass" color="default" disabled={busy} onClick={() => void recover()}>
            {busy ? '正在读取…' : '重新读取此任务详情'}
          </Button>
        </ResourceError>
      ) : null}
    </div>
  );
}
