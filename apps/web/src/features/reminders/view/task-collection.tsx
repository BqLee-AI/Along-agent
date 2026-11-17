'use client';

import Link from '@/shell/view/workspace-link';
import { ArrowUpRight, Clock3 } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { EmptyState } from '@/shared/ui/page';
import type { TaskListItem } from '../model/types';
import { TaskListPageSchema, taskListPath } from '../model/data';
import type { PageSnapshot, TaskFilter } from '../model/data';
import { PageControls, ResourceError, TaskState } from './resource-ui';
import { ElapsedBasis } from './elapsed-basis';
import { useReminderPages } from '../viewmodel/use-reminder-pages';

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
      {index && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          当前获取的提醒范围。选择一项才读取其事件，不代表全局活动。
        </p>
      )}
      {page?.items.length === 0 ? (
        <EmptyState title="此范围没有提醒任务">
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<Link href="/approvals" />}
          >
            查看提醒确认
          </Button>
        </EmptyState>
      ) : null}
      {page && page.items.length > 0 ? (
        <ul className="space-y-3">
          {page.items.map((task) => (
            <li key={task.task_id} className="min-w-0">
              <article className="min-w-0 rounded-xl bg-muted p-4 ring-1 ring-foreground/[0.05]">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3 [overflow-wrap:anywhere]">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06]">
                      <Clock3 className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm leading-5 font-semibold">
                        <span className="font-mono tabular-nums">{task.fire_at_local}</span>
                        {index && selectedId === task.task_id ? (
                          <Badge variant="glass" color="primary">
                            当前任务
                          </Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                        {task.timezone_id} · 冻结本地时间
                      </p>
                      <ElapsedBasis basis={task.time_basis} />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col items-end gap-1">
                    <TaskState state={task.state} />
                    <p className="text-[13px] leading-5 text-muted-foreground">
                      {task.schedule_receipt ? '有调度登记回执' : '无调度登记回执'}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-separator pt-3">
                  <details className="min-w-0 text-[13px] text-muted-foreground">
                    <summary className="cursor-pointer py-1">
                      技术信息 · {task.task_id.slice(0, 8)}
                    </summary>
                    <p className="select-text font-mono [overflow-wrap:anywhere]">
                      task_id: {task.task_id}
                    </p>
                  </details>
                  <Button
                    variant="clear"
                    color="default"
                    className="shrink-0 justify-between"
                    role="link"
                    nativeButton={false}
                    render={
                      <Link
                        aria-current={index && selectedId === task.task_id ? 'true' : undefined}
                        href={
                          index
                            ? `/activity?${new URLSearchParams({ task_id: task.task_id })}#task-events`
                            : `/tasks/${encodeURIComponent(task.task_id)}`
                        }
                      />
                    }
                  >
                    {index ? '查看此任务事件' : '查看任务详情'}
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                    <span className="sr-only">
                      {' '}
                      · {task.fire_at_local} · {task.task_id}
                    </span>
                  </Button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <ResourceError error={error} returnTo={returnTo}>
          <Button variant="glass" color="default" disabled={busy} onClick={() => void load()}>
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
