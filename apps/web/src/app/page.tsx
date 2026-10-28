import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell, FileText, RefreshCw, History } from 'lucide-react';
import { apiGet, type ApiResult } from '@/lib/api';
import { describeCard } from '@/lib/presentation';
import type { Brief } from '@/lib/types';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeading, EmptyState, ErrorNotice } from '@/components/page';

export const dynamic = 'force-dynamic';
type BriefRead = Promise<ApiResult<Brief>>;

async function TodayHeading({ result }: { result: BriefRead }) {
  const response = await result;
  const brief = response.ok ? response.data : null;
  return (
    <PageHeading
      eyebrow="你的工作台"
      title="今日"
      description={
        brief ? (
          <>
            {brief.date} · {brief.timezone_id}
            <span className="mt-1 block">
              本次简报：待确认 {brief.summary.pending_count} · 已记录触发{' '}
              {brief.summary.fired_count}。此处不是全量任务账。
            </span>
          </>
        ) : (
          '开始一件事，或核对已经记录的结果。'
        )
      }
      actions={
        <Button asChild variant="outline">
          <Link href="/">
            <RefreshCw aria-hidden="true" />
            刷新简报
          </Link>
        </Button>
      }
    />
  );
}

function TaskEntries() {
  return (
    <aside className="order-first min-w-0 lg:order-last">
      <h2 className="mb-4">开始一件事</h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        {[
          {
            href: '/conversations?intent=reminder',
            title: '创建提醒',
            description: '说明日期、时间和时区，确认后再记录。',
            icon: Bell,
          },
          {
            href: '/conversations?intent=document',
            title: '处理资料',
            description: '先选授权资料，修改前审阅完整方案。',
            icon: FileText,
          },
        ].map(({ href, title, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex min-h-24 items-start gap-3 p-5 transition-colors hover:bg-accent"
          >
            <Icon
              aria-hidden="true"
              strokeWidth={1.75}
              className="mt-1 size-5 shrink-0 text-primary"
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-primary">{title}</h3>
              <p className="mt-2 text-sm leading-[22px] text-muted-foreground">{description}</p>
            </div>
            <ArrowRight
              className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>
      <div className="mt-8 border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">资料任务与修改结果保存在原会话中。</p>
        <Button asChild variant="link" className="mt-2 px-0">
          <Link href="/conversations">
            <History aria-hidden="true" />
            找回会话与结果
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </aside>
  );
}

function BriefLoading() {
  return (
    <div role="status" aria-label="正在读取今日事项" className="min-w-0 space-y-6">
      <span className="sr-only">正在读取简报，仍可选择新任务目标。</span>
      {[0, 1].map((group) => (
        <div className="space-y-4" key={group}>
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-[88px] w-full" />
          <Skeleton className="h-[88px] w-full" />
        </div>
      ))}
    </div>
  );
}

async function BriefSections({ result }: { result: BriefRead }) {
  const response = await result;
  if (!response.ok)
    return (
      <ErrorNotice message={response.message}>
        <Button asChild variant="outline">
          <Link href="/">重新读取简报</Link>
        </Button>
      </ErrorNotice>
    );
  const brief = response.data;
  const groups = [
    {
      title: '待你确认',
      description: '审阅完整方案，再决定是否确认。',
      href: '/approvals',
      items: brief.cards.filter((card) => card.kind === 'approval'),
    },
    {
      title: '今日提醒',
      description: '只展示已记录的步骤，不承诺通知必达。',
      href: '/tasks',
      items: brief.cards.filter((card) => card.kind === 'task'),
    },
    {
      title: '其他简报记录',
      description: '保留原始简报内容与类型提示。',
      href: null,
      items: brief.cards.filter((card) => card.kind !== 'approval' && card.kind !== 'task'),
    },
  ].filter((group) => group.title !== '其他简报记录' || group.items.length > 0);
  return (
    <div className="min-w-0 space-y-8">
      {brief.meta.timezone_note && (
        <Alert>
          <AlertTitle>时间说明</AlertTitle>
          <AlertDescription>{brief.meta.timezone_note}</AlertDescription>
        </Alert>
      )}
      {brief.meta.brief_state === 'stale' && (
        <Alert className="border-warning/30 bg-warning-soft">
          <AlertTitle>简报可能过期</AlertTitle>
          <AlertDescription>
            保留先前获取的内容；请刷新核对最新记录，此处不代表完整范围。
          </AlertDescription>
        </Alert>
      )}
      {groups.map(({ title, description, href, items }) => (
        <section key={title} aria-label={title}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2>{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            </div>
            {href && (
              <Button asChild variant="link">
                <Link href={href}>
                  查看全部
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            )}
          </div>
          {items.length === 0 ? (
            <EmptyState
              title={title === '待你确认' ? '本次简报没有待确认事项' : '本次简报没有提醒'}
              description="其他日期、尚未载入或已变化的记录，请进入对应列表核对。"
            />
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {items.map((card) => {
                const view = describeCard(card);
                return (
                  <li
                    key={card.card_id}
                    className="flex min-h-[88px] min-w-0 flex-wrap items-center justify-between gap-3 py-5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        {view.href ? (
                          <Link
                            className="inline-flex min-h-11 items-center font-medium hover:text-primary hover:underline"
                            href={view.href}
                          >
                            {view.title}
                          </Link>
                        ) : (
                          <span className="font-medium">{view.title}</span>
                        )}
                        {view.status && <Badge variant="outline">{view.status}</Badge>}
                      </div>
                      {view.warning && (
                        <p className="text-sm text-muted-foreground">{view.warning}</p>
                      )}
                    </div>
                    {view.time && (
                      <p className="w-full text-sm tabular-nums text-muted-foreground sm:w-auto">
                        {view.time}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export default async function HomePage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const result = apiGet<Brief>('/api/v1/brief', pageReturnTo('/', await searchParams));
  return (
    <div>
      <Suspense
        fallback={
          <PageHeading
            eyebrow="你的工作台"
            title="今日"
            description="正在读取今日事项；仍可开始一件事。"
          />
        }
      >
        <TodayHeading result={result} />
      </Suspense>
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
        <TaskEntries />
        <Suspense fallback={<BriefLoading />}>
          <BriefSections result={result} />
        </Suspense>
      </div>
    </div>
  );
}
