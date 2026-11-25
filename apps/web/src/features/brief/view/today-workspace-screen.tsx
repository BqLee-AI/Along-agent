import { Suspense } from 'react';
import Link from '@/shell/view/workspace-link';
import { History } from 'lucide-react';
import { PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { loadTodayWorkspace } from '../model/brief-server';
import { BriefSections } from './brief-sections';
import { BriefLoading } from './today-workspace-loading-screen';

export function TodayWorkspaceScreen({ query }: { query: PageQuery }) {
  const workspace = loadTodayWorkspace(query);
  return (
    <div className="w-full min-w-0 [overflow-wrap:anywhere]">
      <PageHeading
        title="概览"
        actions={
          <Link
            href="/activity"
            aria-label="活动记录"
            title="活动记录"
            className="inline-flex size-8 items-center justify-center rounded-control text-secondary-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:size-11"
          >
            <History className="size-4" aria-hidden="true" />
          </Link>
        }
      />
      <section aria-label="日期简报" className="min-w-0">
        <Suspense fallback={<BriefLoading />}>
          <BriefSections workspace={workspace} />
        </Suspense>
      </section>
    </div>
  );
}
