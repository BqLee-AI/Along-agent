import { Suspense } from 'react';
import Link from '@/shell/view/workspace-link';
import { ArrowUpRight, CheckCheck, Clock3, History } from 'lucide-react';
import { PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { loadTodayWorkspace } from '../model/brief-server';
import { BriefSections } from './brief-sections';
import { BriefLoading } from './today-workspace-loading-screen';

const destinations = [
  { href: '/tasks', title: '我的提醒', description: '查看安排与真实结果', icon: Clock3 },
  { href: '/approvals', title: '待我确认', description: '审阅方案，决定下一步', icon: CheckCheck },
  { href: '/activity', title: '活动记录', description: '核对已经记录的步骤', icon: History },
];

export function TodayWorkspaceScreen({ query }: { query: PageQuery }) {
  const workspace = loadTodayWorkspace(query);
  return (
    <div className="w-full min-w-0 space-y-8 [overflow-wrap:anywhere]">
      <PageHeading
        title="今日工作台"
        description="查看简报，处理待确认事项，核对提醒与活动记录。"
      />
      <section aria-label="日期简报" className="min-w-0">
        <Suspense fallback={<BriefLoading />}>
          <BriefSections workspace={workspace} />
        </Suspense>
      </section>
      <nav aria-label="事项与记录" className="min-w-0">
        <h2 className="mb-3 text-[13px] leading-5 font-medium text-muted-foreground">继续处理</h2>
        <ul className="grid gap-3 @md/workspace:grid-cols-3">
          {destinations.map(({ href, title, description, icon: Icon }) => (
            <li key={href} className="min-w-0">
              <Link
                href={href}
                className="group relative flex h-full min-w-0 flex-col gap-4 rounded-xl bg-muted p-4 ring-1 ring-foreground/[0.05] transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:min-h-14"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground">
                  <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm leading-5 font-medium">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                    {description}
                  </span>
                </span>
                <ArrowUpRight
                  className="absolute top-4 right-4 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
