'use client';

import { History } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { EmptyState } from '@/shared/ui/page';
import type { TaskEventItem } from '../model/types';
import { TaskEventsPageSchema, taskEventsPath } from '../model/data';
import type { PageSnapshot } from '../model/data';
import { PageControls, ResourceError } from './resource-ui';
import { useReminderPages } from '../viewmodel/use-reminder-pages';

const eventIdentity = (event: TaskEventItem) => event.event_id;
export function TaskEvents({
  taskId,
  initial,
  returnTo,
}: {
  taskId: string;
  initial: PageSnapshot<TaskEventItem>;
  returnTo: string;
}) {
  const { page, error, busy, load } = useReminderPages(
    taskEventsPath(taskId),
    initial,
    TaskEventsPageSchema,
    eventIdentity,
  );
  return (
    <section
      className="min-w-0 space-y-6 border-t border-separator pt-6"
      aria-labelledby="events-heading"
      aria-busy={busy}
    >
      <div className="space-y-2">
        <h2 id="events-heading" className="flex items-center gap-2 text-base font-semibold">
          <History className="size-5" aria-hidden="true" />
          此提醒的事件账
        </h2>
        <p className="max-w-3xl text-sm leading-[22px] text-muted-foreground">
          只读展示此任务已记录的事件，按服务端记录顺序读取；不代表用户已收到或看过通知，也不是全站完整审计。
        </p>
      </div>
      {page?.items.length === 0 ? (
        <EmptyState title="此提醒尚无事件记录" description="只表示本次成功读取没有记录。" />
      ) : null}
      {!page && !error ? (
        <Button variant="glass" color="default" disabled={busy} onClick={() => void load()}>
          {busy ? '正在读取…' : '读取此任务事件'}
        </Button>
      ) : null}
      {page && page.items.length > 0 ? (
        <ol className="min-w-0">
          {page.items.map((event) => (
            <li
              key={event.event_id}
              className="relative min-w-0 space-y-3 border-l border-separator pb-7 pl-5 last:pb-0 [overflow-wrap:anywhere]"
            >
              <span
                className="absolute top-1 -left-1 size-2 rounded-full bg-primary"
                aria-hidden="true"
              />
              <div className="space-y-1 text-sm leading-[22px]">
                <p className="text-muted-foreground">记录时间（UTC）</p>
                <time className="tabular-nums" dateTime={event.recorded_at_utc}>
                  {event.recorded_at_utc}
                </time>
              </div>
              <div className="min-w-0 space-y-3">
                <h3 className="font-semibold">{event.type}</h3>
                <dl className="space-y-2 text-sm">
                  <dt className="text-muted-foreground">证据引用</dt>
                  <dd className="whitespace-pre-wrap leading-6">
                    {event.evidence_ref || '服务端记录（无外部凭据）'}
                  </dd>
                </dl>
                <details className="text-sm text-muted-foreground">
                  <summary className="cursor-pointer py-2">事件技术信息</summary>
                  <dl className="space-y-2 font-mono">
                    <dt>event_id</dt>
                    <dd className="select-text">{event.event_id}</dd>
                    <dt>状态版本</dt>
                    <dd>{event.state_version}</dd>
                  </dl>
                </details>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {error ? (
        <ResourceError error={error} returnTo={returnTo}>
          <Button variant="glass" color="default" disabled={busy} onClick={() => void load()}>
            {busy ? '正在读取…' : '重新读取未成功事件页'}
          </Button>
        </ResourceError>
      ) : null}
      {page ? (
        <PageControls
          count={page.items.length}
          nextCursor={page.next_cursor}
          busy={busy}
          load={load}
          noun="此任务事件"
        />
      ) : null}
    </section>
  );
}
