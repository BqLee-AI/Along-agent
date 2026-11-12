import Link from '@/shell/view/workspace-link';
import { Button } from '@lorelum/lumen-ui/components/button';
import { EmptyState, PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { loadReminderActivity } from '../model/reminder-server';
import { TaskCollection } from './task-collection';
import { TaskSummary } from './task-content';
import { TaskEvents } from './task-events';
import { TaskRecovery } from './task-recovery';

export async function ReminderActivityScreen({ query }: { query: PageQuery }) {
  const { selectedId, returnTo, initial, detail, events } = await loadReminderActivity(query);
  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        eyebrow="事项 / 活动"
        title="提醒活动"
        description="定位一条提醒，核对已记录的事件。这里不是全站时间线或完整审计。"
      />
      <nav aria-label="活动导航" className="flex flex-wrap gap-2 border-b border-separator pb-4">
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href="/tasks" />}
        >
          提醒任务
        </Button>
        {selectedId ? (
          <Button
            variant="clear"
            color="default"
            role="link"
            nativeButton={false}
            render={<Link href="/activity" />}
          >
            清除任务选择
          </Button>
        ) : null}
      </nav>
      <section
        id="task-events"
        className="min-w-0 scroll-mt-6 space-y-5"
        aria-label="选中提醒的事件"
      >
        {!selectedId ? (
          <EmptyState
            title="选择一条提醒查看事件"
            description="任务范围与事件分别读取、分别分页；不会自动读取所有提醒的事件。"
          />
        ) : detail?.ok ? (
          <>
            <TaskSummary task={detail.data} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="glass"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href={`/tasks/${encodeURIComponent(selectedId)}`} />}
              >
                查看提醒详情
              </Button>
              <Button
                variant="clear"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href="#task-index" />}
              >
                选择其他提醒
              </Button>
            </div>
            <details className="text-sm leading-[22px] text-muted-foreground">
              <summary className="cursor-pointer py-2">当前提醒技术信息</summary>
              <p className="select-text font-mono [overflow-wrap:anywhere]">
                task_id: {detail.data.task_id}
              </p>
            </details>
            {events ? (
              <TaskEvents
                key={selectedId}
                taskId={selectedId}
                initial={events}
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
      <section
        id="task-index"
        className="min-w-0 scroll-mt-6 space-y-4 border-t border-separator pt-6"
        aria-labelledby="task-index-heading"
      >
        <h2 id="task-index-heading" className="text-sm leading-6 font-semibold">
          提醒范围
        </h2>
        <TaskCollection initial={initial} index selectedId={selectedId} returnTo={returnTo} />
      </section>
    </div>
  );
}
