'use client';

import { Button } from '@lorelum/lumen-ui/components/button';
import { EmptyState } from '@/components/page';
import type { TaskEventItem } from '@/lib/types';
import { TaskEventsPageSchema, taskEventsPath, type PageSnapshot } from './data';
import { PageControls, ResourceError } from './resource-ui';
import { useReminderPages } from './use-reminder-pages';

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
    <section className="min-w-0 space-y-4" aria-labelledby="events-heading" aria-busy={busy}>
      <div>
        <h2 id="events-heading" className="text-lg font-semibold">
          此提醒的事件账
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
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
        <ol className="divide-y divide-border border-y border-border">
          {page.items.map((event) => (
            <li key={event.event_id} className="min-w-0 space-y-3 py-4 [overflow-wrap:anywhere]">
              <h3 className="font-medium">{event.type}</h3>
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[120px_minmax(0,1fr)]">
                <dt className="text-muted-foreground">记录时间（UTC）</dt>
                <dd>
                  <time dateTime={event.recorded_at_utc}>{event.recorded_at_utc}</time>
                </dd>
                <dt className="text-muted-foreground">证据引用</dt>
                <dd className="whitespace-pre-wrap">
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
