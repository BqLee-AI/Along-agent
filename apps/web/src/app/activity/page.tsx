import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { TaskDetailSchema } from '@/lib/types';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { EmptyState, PageHeading } from '@/components/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { TaskCollection } from '@/features/reminders/task-collection';
import { TaskSummary } from '@/features/reminders/task-content';
import { TaskEvents } from '@/features/reminders/task-events';
import { TaskRecovery } from '@/features/reminders/task-recovery';
import {
  checked,
  invalidResponse,
  snapshot,
  taskListPath,
  taskPath,
  taskEventsPath,
  TaskListPageSchema,
  TaskEventsPageSchema,
} from '@/features/reminders/data';

export const dynamic = 'force-dynamic';

export default async function ActivityPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  const selectedId = Array.isArray(query.task_id) ? query.task_id[0] : query.task_id;
  const returnTo = pageReturnTo('/activity', query);
  // A deep link reads the real detail directly, even outside the first task page.
  // There is never an event request for every task in the index.
  const [taskResponse, detailResponse] = await Promise.all([
    apiGet<unknown>(taskListPath('all'), returnTo),
    selectedId ? apiGet<unknown>(taskPath(selectedId), returnTo) : Promise.resolve(null),
  ]);
  const tasks = checked(taskResponse, TaskListPageSchema);
  const parsedDetail = detailResponse ? checked(detailResponse, TaskDetailSchema) : null;
  const detail =
    parsedDetail?.ok && parsedDetail.data.task_id !== selectedId ? invalidResponse : parsedDetail;
  const events =
    selectedId && detail?.ok
      ? checked(await apiGet<unknown>(taskEventsPath(selectedId), returnTo), TaskEventsPageSchema)
      : null;
  return (
    <section className="space-y-8">
      <PageHeading
        title="提醒活动"
        description="先定位一条提醒，再核对这条提醒的事件账。此页不是全站时间线或完整审计。"
        actions={
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<Link href="/tasks" />}
          >
            返回提醒任务
          </Button>
        }
      />
      <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section
          id="task-index"
          className="min-w-0 scroll-mt-24 space-y-4"
          aria-labelledby="task-index-heading"
        >
          <h2 id="task-index-heading" className="text-lg font-semibold">
            任务范围索引
          </h2>
          <TaskCollection
            initial={snapshot(tasks)}
            index
            selectedId={selectedId}
            returnTo={returnTo}
          />
        </section>
        <section
          id="task-events"
          className="min-w-0 scroll-mt-24 space-y-8"
          aria-label="选中任务的事件"
        >
          {selectedId ? (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="glass"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href="#task-index" />}
              >
                返回任务范围
              </Button>
              <Button
                variant="clear"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href="/activity" />}
              >
                清除任务选择
              </Button>
            </div>
          ) : null}
          {!selectedId ? (
            <EmptyState
              title="选择一条提醒查看事件"
              description="任务范围索引与此任务事件分别读取、分别分页；不会自动读取所有提醒的事件。"
            />
          ) : detail?.ok ? (
            <>
              <TaskSummary task={detail.data} />
              <Button
                variant="glass"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href={`/tasks/${encodeURIComponent(selectedId)}`} />}
              >
                查看任务详情
              </Button>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer py-2">当前任务技术信息</summary>
                <p className="select-text font-mono [overflow-wrap:anywhere]">
                  task_id: {detail.data.task_id}
                </p>
              </details>
              {events ? (
                <TaskEvents
                  key={selectedId}
                  taskId={selectedId}
                  initial={snapshot(events)}
                  returnTo={returnTo}
                />
              ) : null}
            </>
          ) : detail ? (
            <TaskRecovery
              key={selectedId}
              taskId={selectedId}
              initialError={detail}
              activity
              returnTo={returnTo}
            />
          ) : null}
        </section>
      </div>
    </section>
  );
}
