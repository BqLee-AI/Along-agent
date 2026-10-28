import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { MeSchema, TaskDetailSchema } from '@/lib/types';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { PageHeading } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TaskContent } from '@/features/reminders/task-content';
import { TaskEvents } from '@/features/reminders/task-events';
import { TaskRecovery } from '@/features/reminders/task-recovery';
import {
  checked,
  invalidResponse,
  snapshot,
  taskPath,
  taskEventsPath,
  TaskEventsPageSchema,
} from '@/features/reminders/data';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageQuery>;
}) {
  const { id } = await params;
  const returnTo = pageReturnTo(`/tasks/${encodeURIComponent(id)}`, await searchParams);
  const [detailResponse, eventsResponse, identityResponse] = await Promise.all([
    apiGet<unknown>(taskPath(id), returnTo),
    apiGet<unknown>(taskEventsPath(id), returnTo),
    apiGet<unknown>('/api/v1/me', returnTo),
  ]);
  const parsedDetail = checked(detailResponse, TaskDetailSchema);
  const detail =
    parsedDetail.ok && parsedDetail.data.task_id !== id ? invalidResponse : parsedDetail;
  const events = checked(eventsResponse, TaskEventsPageSchema);
  const me = checked(identityResponse, MeSchema);
  return (
    <section className="min-w-0 space-y-8">
      <PageHeading
        title="提醒任务"
        description="冻结时间、通知与事件各自保留真实记录。"
        actions={
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link href="/tasks">返回提醒任务</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href={`/activity?${new URLSearchParams({ task_id: id })}`}>在活动中定位</Link>
            </Button>
          </div>
        }
      />
      {detail.ok ? (
        <TaskContent task={detail.data} meResult={me} />
      ) : (
        <TaskRecovery
          key={id}
          taskId={id}
          initialError={detail}
          meResult={me}
          returnTo={returnTo}
        />
      )}
      <TaskEvents key={id} taskId={id} initial={snapshot(events)} returnTo={returnTo} />
    </section>
  );
}
