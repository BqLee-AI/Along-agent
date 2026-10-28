'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/page';
import type { TaskListItem } from '@/lib/types';
import { TaskListPageSchema, taskListPath, type PageSnapshot, type TaskFilter } from './data';
import { PageControls, ResourceError, TaskState } from './resource-ui';
import { useReminderPages } from './use-reminder-pages';

const taskIdentity = (task: TaskListItem) => task.task_id;
export function TaskCollection({
  initial,
  status = 'all',
  index = false,
  selectedId,
  returnTo,
}: {
  initial: PageSnapshot<TaskListItem>;
  status?: TaskFilter;
  index?: boolean;
  selectedId?: string;
  returnTo: string;
}) {
  const { page, error, busy, load } = useReminderPages(
    taskListPath(status),
    initial,
    TaskListPageSchema,
    taskIdentity,
  );
  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      {index ? (
        <p className="text-sm text-muted-foreground">
          当前获取的提醒任务范围；选择一项才读取其事件。不代表全局活动。
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          按冻结提醒时间排列。这里只列提醒，不包含资料任务；不额外读取批准来拼接标题。
        </p>
      )}
      {page?.items.length === 0 ? (
        <EmptyState title="此范围没有提醒任务" description="确认提醒提议后才会创建任务。">
          <Button asChild variant="outline">
            <Link href="/approvals">查看提醒确认</Link>
          </Button>
        </EmptyState>
      ) : null}
      {page && page.items.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {page.items.map((task) => (
            <li
              key={task.task_id}
              className={`min-w-0 py-4 ${index && selectedId === task.task_id ? 'border-l-2 border-primary bg-accent pl-3' : ''}`}
            >
              <div
                className={index ? 'space-y-3' : 'flex flex-wrap items-start justify-between gap-4'}
              >
                <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
                  <p className="font-medium">{task.fire_at_local}</p>
                  <p className="text-sm text-muted-foreground">{task.timezone_id} · 冻结本地时间</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <TaskState state={task.state} />
                    <span className="text-sm text-muted-foreground">
                      {task.schedule_receipt ? '有调度登记回执' : '无调度登记回执'}
                    </span>
                  </div>
                </div>
                <Button asChild variant="ghost" className={index ? 'w-full justify-start' : ''}>
                  <Link
                    aria-current={index && selectedId === task.task_id ? 'true' : undefined}
                    href={
                      index
                        ? `/activity?${new URLSearchParams({ task_id: task.task_id })}#task-events`
                        : `/tasks/${encodeURIComponent(task.task_id)}`
                    }
                  >
                    {index ? '查看此任务事件' : '查看任务详情'}
                    <span className="sr-only">
                      {' '}
                      · {task.fire_at_local} · {task.task_id}
                    </span>
                  </Link>
                </Button>
              </div>
              <details className="mt-2 text-sm text-muted-foreground">
                <summary className="cursor-pointer py-2">
                  技术信息 · {task.task_id.slice(0, 8)}
                </summary>
                <p className="select-text font-mono [overflow-wrap:anywhere]">
                  task_id: {task.task_id}
                </p>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <ResourceError error={error} returnTo={returnTo}>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            {busy ? '正在读取…' : page ? '重新读取未成功页' : '重新读取任务范围'}
          </Button>
        </ResourceError>
      ) : null}
      {page ? (
        <PageControls
          count={page.items.length}
          nextCursor={page.next_cursor}
          busy={busy}
          load={load}
          noun="任务"
        />
      ) : null}
    </div>
  );
}
