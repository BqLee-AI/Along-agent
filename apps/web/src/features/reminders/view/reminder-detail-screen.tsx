import Link from '@/shell/view/workspace-link';
import { Button } from '@lorelum/lumen-ui/components/button';
import { PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { loadReminderDetail } from '../model/reminder-server';
import { TaskContent } from './task-content';
import { TaskEvents } from './task-events';
import { TaskRecovery } from './task-recovery';

export async function ReminderDetailScreen({ id, query }: { id: string; query: PageQuery }) {
  const { returnTo, detail, events, me } = await loadReminderDetail(id, query);
  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        eyebrow="事项 / 提醒详情"
        title="提醒任务"
        description="冻结时间、通知与事件各自保留真实记录。"
      />
      <nav
        aria-label="提醒详情导航"
        className="flex flex-wrap gap-2 border-b border-separator pb-4"
      >
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href="/tasks" />}
        >
          返回提醒
        </Button>
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href={`/activity?${new URLSearchParams({ task_id: id })}`} />}
        >
          在活动中定位
        </Button>
      </nav>
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
      <TaskEvents key={id} taskId={id} initial={events} returnTo={returnTo} />
    </div>
  );
}
