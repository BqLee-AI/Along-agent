import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { PageHeading } from '@/components/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { TaskStatusFilter } from '@/features/reminders/task-status-filter';
import { TaskCollection } from '@/features/reminders/task-collection';
import {
  checked,
  snapshot,
  taskFilter,
  taskListPath,
  TaskListPageSchema,
} from '@/features/reminders/data';

export const dynamic = 'force-dynamic';

export default async function TasksPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  const status = taskFilter(Array.isArray(query.status) ? query.status[0] : query.status);
  const returnTo = pageReturnTo('/tasks', query);
  const result = checked(await apiGet<unknown>(taskListPath(status), returnTo), TaskListPageSchema);
  return (
    <section className="space-y-8">
      <PageHeading
        title="提醒任务"
        description="核对已保存的提醒、冻结时间与真实回执。资料处理结果请回到对话查看。"
        actions={
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<Link href="/" />}
          >
            返回今日
          </Button>
        }
      />
      <TaskStatusFilter key={status} status={status} />
      <TaskCollection key={status} initial={snapshot(result)} status={status} returnTo={returnTo} />
    </section>
  );
}
