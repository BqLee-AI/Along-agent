import Link from '@/shell/view/workspace-link';
import { ClipboardCheck, History } from 'lucide-react';
import { PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { loadReminders } from '../model/reminder-server';
import { TaskCollection } from './task-collection';
import { TaskStatusFilter } from './task-status-filter';

const iconLinkClass =
  'inline-flex size-8 items-center justify-center rounded-control text-secondary-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:size-11';
export async function RemindersScreen({ query }: { query: PageQuery }) {
  const { status, returnTo, initial } = await loadReminders(query);
  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        title="提醒"
        actions={
          <nav aria-label="提醒关联页面" className="flex items-center gap-2">
            <Link href="/approvals" aria-label="待确认" title="待确认" className={iconLinkClass}>
              <ClipboardCheck className="size-4" aria-hidden="true" />
            </Link>
            <Link href="/activity" aria-label="活动记录" title="活动记录" className={iconLinkClass}>
              <History className="size-4" aria-hidden="true" />
            </Link>
          </nav>
        }
      />
      <section aria-label="提醒列表" className="min-w-0 space-y-4">
        <TaskStatusFilter key={status} status={status} />
        <TaskCollection key={status} initial={initial} status={status} returnTo={returnTo} />
      </section>
    </div>
  );
}
