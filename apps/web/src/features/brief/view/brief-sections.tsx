'use client';

import { use } from 'react';
import Link from '@/shell/view/workspace-link';
import { RefreshCw } from 'lucide-react';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { ErrorNotice } from '@/shared/ui/page';
import { ElapsedBasis } from '@/features/reminders/view/elapsed-basis';
import type { TodayWorkspace } from '../model/brief-server';

const helperClass = 'text-[13px] leading-5 text-muted-foreground';
const linkClass =
  'inline-flex items-center gap-1 rounded-control text-[13px] leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:min-h-11';
const panelClass = 'rounded-xl bg-muted ring-1 ring-foreground/[0.05]';

export function BriefSections({ workspace }: { workspace: TodayWorkspace }) {
  const response = use(workspace.result);
  if (!response.ok) {
    return (
      <ErrorNotice message={response.message}>
        <Link href={workspace.refreshHref} className={linkClass}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          重新读取简报
        </Link>
      </ErrorNotice>
    );
  }
  const { brief, groups } = response.data;
  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">
            <time dateTime={brief.date}>{brief.date}</time>
            <span className="ml-2 text-xs font-normal text-secondary-foreground">
              {brief.timezone_id}
            </span>
          </h2>
          <Link
            href={workspace.refreshHref}
            aria-label="刷新简报"
            title="刷新简报"
            className={`${linkClass} size-8 justify-center hover:bg-muted max-lg:size-11`}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <dl className={`grid grid-cols-2 divide-x divide-separator ${panelClass}`}>
          <div className="min-w-0 px-4 py-3">
            <dt className={helperClass}>待确认</dt>
            <dd className="text-2xl leading-8 font-semibold tabular-nums">
              {brief.summary.pending_count}
            </dd>
          </div>
          <div className="min-w-0 px-4 py-3">
            <dt className={helperClass}>已记录触发</dt>
            <dd className="text-2xl leading-8 font-semibold tabular-nums">
              {brief.summary.fired_count}
            </dd>
          </div>
        </dl>
      </div>
      {brief.meta.timezone_note && (
        <Alert variant="glass">
          <Alert.Content>{brief.meta.timezone_note}</Alert.Content>
        </Alert>
      )}
      {brief.meta.brief_state === 'stale' && (
        <Alert color="warning" variant="glass">
          <Alert.Content>
            <Alert.Title>简报可能过期</Alert.Title>
            <Alert.Description className={helperClass}>
              <p>显示上次读取的记录，请刷新。</p>
              {brief.meta.stale_reason && <p className="mt-1">{brief.meta.stale_reason}</p>}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {groups.map(({ id, title, href, items, empty }) => (
        <section key={id} aria-labelledby={`brief-${id}`} className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2
                id={`brief-${id}`}
                className="shrink-0 text-sm leading-5 font-semibold whitespace-nowrap"
              >
                {title}
              </h2>
            </div>
            {href && (
              <Link href={href} aria-label={`查看全部${title}`} className={`shrink-0 ${linkClass}`}>
                查看全部
              </Link>
            )}
          </div>
          {items.length === 0 ? (
            <p className={`border-t border-separator pt-3 ${helperClass}`}>{empty}</p>
          ) : (
            <ul className={`${panelClass} divide-y divide-separator`}>
              {items.map((item) => (
                <li key={item.id} className="min-w-0 px-4 py-3">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.href ? (
                        <Link
                          href={item.href}
                          className="min-w-0 text-sm leading-5 font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
                        >
                          {item.title}
                        </Link>
                      ) : (
                        <p className="text-sm leading-5 font-medium">{item.title}</p>
                      )}
                      {item.status && <Badge variant="glass">{item.status}</Badge>}
                    </div>
                    {item.time && (
                      <p className="font-mono text-[13px] leading-5 text-muted-foreground tabular-nums">
                        {item.time}
                      </p>
                    )}
                  </div>
                  {item.warning && <p className={`mt-1 ${helperClass}`}>{item.warning}</p>}
                  {item.frozenTimezone && (
                    <p className={`mt-1 ${helperClass}`}>冻结时区：{item.frozenTimezone}</p>
                  )}
                  <ElapsedBasis basis={item.timeBasis} className={`mt-1 ${helperClass}`} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <p className={helperClass}>
        <Link href="/conversations" className={linkClass}>
          找回会话与结果
        </Link>
      </p>
    </div>
  );
}
