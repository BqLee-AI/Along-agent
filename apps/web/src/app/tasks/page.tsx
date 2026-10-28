import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { PageHeading } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { TaskCollection } from '@/features/reminders/task-collection';
import {
  checked,
  snapshot,
  taskFilter,
  taskListPath,
  TaskListPageSchema,
  taskStates,
  taskStateLabel,
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
          <Button asChild variant="outline">
            <Link href="/">返回今日</Link>
          </Button>
        }
      />
      <form action="/tasks" method="get" className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="task-status">任务状态</Label>
          <select
            id="task-status"
            name="status"
            defaultValue={status}
            className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base sm:w-56"
          >
            {taskStates.map((value) => (
              <option key={value} value={value}>
                {taskStateLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <Button variant="outline" type="submit">
          应用筛选
        </Button>
      </form>
      <TaskCollection key={status} initial={snapshot(result)} status={status} returnTo={returnTo} />
    </section>
  );
}
