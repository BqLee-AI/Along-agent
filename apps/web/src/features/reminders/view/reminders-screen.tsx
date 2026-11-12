import Link from '@/shell/view/workspace-link';
import { PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { loadReminders } from '../model/reminder-server';
import { TaskCollection } from './task-collection';
import { TaskStatusFilter } from './task-status-filter';

const pillClass =
  'inline-flex h-8 items-center rounded-full bg-muted px-3.5 text-[13px] leading-5 text-foreground/75 ring-1 ring-foreground/[0.08] transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:min-h-11';
export async function RemindersScreen({ query }: { query: PageQuery }) {
  const { status, returnTo, initial } = await loadReminders(query);
  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        title="提醒任务"
        description="查看冻结时间、调度回执与后续记录。"
        actions={
          <nav aria-label="提醒关联页面" className="flex items-center gap-2">
            <Link href="/approvals" className={pillClass}>
              提醒确认
            </Link>
            <Link href="/activity" className={pillClass}>
              提醒活动
            </Link>
          </nav>
        }
      />
      <section aria-label="已保存的提醒" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm leading-5 font-semibold">已保存的提醒</h2>
          <TaskStatusFilter key={status} status={status} />
        </div>
        <TaskCollection key={status} initial={initial} status={status} returnTo={returnTo} />
      </section>
      <p className="text-[13px] leading-5 text-muted-foreground">
        提醒时间在创建时冻结。调度登记回执不代表通知已送达，通知记录也不表示已经阅读。
      </p>
    </div>
  );
}
