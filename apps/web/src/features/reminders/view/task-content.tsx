import Link from '@/shell/view/workspace-link';
import { Clock3, Link2 } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { EmptyState } from '@/shared/ui/page';
import type { ApiResult } from '@/shared/http/result';
import type { Me } from '@/shared/session/identity';
import type { TaskDetail } from '../model/types';
import CancelAction from './CancelAction';
import { TaskState } from './resource-ui';
import { ElapsedBasis } from './elapsed-basis';

export function TaskSummary({ task }: { task: TaskDetail }) {
  return (
    <section className="min-w-0 space-y-5 [overflow-wrap:anywhere]" aria-label="提醒时间与状态">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Clock3 className="size-4" aria-hidden="true" />
            冻结提醒时间
          </h2>
          <p className="text-xl font-semibold leading-7 tabular-nums">{task.fire_at_local}</p>
          <p className="text-sm leading-[22px] text-muted-foreground">
            {task.timezone_id} · 创建时冻结的本地时间，不在 Web 换算
          </p>
          <ElapsedBasis basis={task.time_basis} />
        </div>
        <TaskState state={task.state} />
      </div>
      <div className="min-w-0 space-y-2 border-l-2 border-separator pl-4">
        <h3 className="text-sm font-medium">调度登记回执</h3>
        <p className="whitespace-pre-wrap text-sm leading-6">
          {task.schedule_receipt ?? '无回执；尚不能确认调度登记成功'}
        </p>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm leading-[22px] text-muted-foreground">
          状态与回执为本次读取结果，不保证通知必达；通知记录不表示用户已收到或看过。
        </p>
        {task.source_approval_id ? (
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<Link href={`/approvals/${encodeURIComponent(task.source_approval_id)}`} />}
          >
            <Link2 className="size-4" aria-hidden="true" />
            查看来源提醒确认
          </Button>
        ) : task.source_invocation_id ? (
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer py-2">本人委托直接创建 · 来源调用</summary>
            <p className="select-text font-mono">{task.source_invocation_id}</p>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">无来源批准引用，不推测关联会话。</p>
        )}
      </div>
    </section>
  );
}

export function TaskContent({ task, meResult }: { task: TaskDetail; meResult: ApiResult<Me> }) {
  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0 space-y-6">
        <TaskSummary task={task} />
        <div className="min-w-0 border-t border-separator pt-6">
          <section className="space-y-6" aria-labelledby="notifications-heading">
            <div className="space-y-2">
              <h2 id="notifications-heading" className="text-base font-semibold">
                站内通知
              </h2>
              <p className="text-sm leading-[22px] text-muted-foreground">
                以下是此任务实际保存的通知全文，不代表用户看过或外部送达。
              </p>
            </div>
            {task.notifications.length === 0 ? (
              <EmptyState title="暂无站内通知记录" description="这不改变任务的真实状态。" />
            ) : (
              <ul className="space-y-4">
                {task.notifications.map((notice) => (
                  <li key={notice.id} className="min-w-0 [overflow-wrap:anywhere]">
                    <article className="min-w-0 space-y-4 border-b border-separator py-4">
                      <h3 className="whitespace-pre-wrap font-semibold leading-6">
                        {notice.title}
                      </h3>
                      <p className="max-w-4xl whitespace-pre-wrap leading-6">{notice.body}</p>
                      <dl className="grid gap-x-5 gap-y-2 text-sm leading-[22px] sm:grid-cols-[140px_minmax(0,1fr)]">
                        <dt className="text-muted-foreground">通知记录状态</dt>
                        <dd>{notice.status}</dd>
                        <dt className="text-muted-foreground">发送时间（UTC）</dt>
                        <dd>
                          {notice.sent_at ? (
                            <time dateTime={notice.sent_at}>{notice.sent_at}</time>
                          ) : (
                            '未记录'
                          )}
                        </dd>
                      </dl>
                      <details className="text-sm text-muted-foreground">
                        <summary className="cursor-pointer py-2">通知技术信息</summary>
                        <p className="select-text font-mono">{notice.id}</p>
                      </details>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <section
        className="min-w-0 space-y-5 border-t border-separator pt-6"
        aria-label="提醒操作与技术信息"
      >
        <CancelAction
          key={task.task_id}
          taskId={task.task_id}
          state={task.state}
          meResult={meResult}
        />
        <div className="min-w-0 border-t border-separator pt-4">
          <details className="text-sm [overflow-wrap:anywhere]">
            <summary className="cursor-pointer py-2 font-medium">任务技术信息</summary>
            <dl className="mt-4 space-y-2 font-mono">
              <dt className="text-muted-foreground">task_id</dt>
              <dd className="select-text">{task.task_id}</dd>
              <dt className="pt-2 text-muted-foreground">kind</dt>
              <dd>{task.kind}</dd>
              <dt className="pt-2 text-muted-foreground">状态版本</dt>
              <dd>{task.state_version}</dd>
              <dt className="pt-2 text-muted-foreground">冻结时间（UTC）</dt>
              <dd>{task.fire_at_utc}</dd>
              <dt className="pt-2 text-muted-foreground">创建时间</dt>
              <dd>{task.created_at}</dd>
              {task.recreated_from ? (
                <>
                  <dt className="pt-2 text-muted-foreground">重约自</dt>
                  <dd>
                    <Link
                      className="text-primary underline underline-offset-4"
                      href={`/tasks/${encodeURIComponent(task.recreated_from)}`}
                    >
                      {task.recreated_from}
                    </Link>
                  </dd>
                </>
              ) : null}
            </dl>
          </details>
        </div>
      </section>
    </div>
  );
}
