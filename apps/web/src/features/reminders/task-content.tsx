import Link from 'next/link';
import { Button } from '@lorelum/lumen-ui/components/button';
import { EmptyState } from '@/components/page';
import type { ApiResult } from '@/lib/api';
import type { Me, TaskDetail } from '@/lib/types';
import CancelAction from '@/app/tasks/[id]/CancelAction';
import { TaskState } from './resource-ui';
import { ElapsedBasis } from './elapsed-basis';

export function TaskSummary({ task }: { task: TaskDetail }) {
  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <div className="space-y-2">
        <p className="text-xl font-semibold">{task.fire_at_local}</p>
        <p className="text-muted-foreground">
          {task.timezone_id} · 创建时冻结的本地时间，不在 Web 换算
        </p>
        <ElapsedBasis basis={task.time_basis} />
        <TaskState state={task.state} />
      </div>
      <dl className="grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)]">
        <dt className="text-muted-foreground">调度登记回执</dt>
        <dd className="whitespace-pre-wrap">
          {task.schedule_receipt ?? '无回执；尚不能确认调度登记成功'}
        </dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        状态与回执为本次读取结果，不保证通知必达；通知记录不表示用户已收到或看过。
      </p>
      <div className="flex flex-wrap gap-3">
        {task.source_approval_id ? (
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<Link href={`/approvals/${encodeURIComponent(task.source_approval_id)}`} />}
          >
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
    </div>
  );
}

export function TaskContent({ task, meResult }: { task: TaskDetail; meResult: ApiResult<Me> }) {
  return (
    <div className="min-w-0 space-y-8">
      <TaskSummary task={task} />
      <section className="space-y-4" aria-labelledby="notifications-heading">
        <div>
          <h2 id="notifications-heading" className="text-lg font-semibold">
            站内通知
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            以下是此任务实际保存的通知全文，不代表用户看过或外部送达。
          </p>
        </div>
        {task.notifications.length === 0 ? (
          <EmptyState title="暂无站内通知记录" description="这不改变任务的真实状态。" />
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {task.notifications.map((notice) => (
              <li key={notice.id} className="min-w-0 space-y-3 py-4 [overflow-wrap:anywhere]">
                <h3 className="whitespace-pre-wrap font-medium">{notice.title}</h3>
                <p className="whitespace-pre-wrap leading-7">{notice.body}</p>
                <dl className="grid gap-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
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
              </li>
            ))}
          </ul>
        )}
      </section>
      <CancelAction
        key={task.task_id}
        taskId={task.task_id}
        state={task.state}
        meResult={meResult}
      />
      <details className="p-4 text-sm [overflow-wrap:anywhere]">
        <summary className="cursor-pointer py-2 font-medium">任务技术信息</summary>
        <dl className="mt-4 grid gap-2 font-mono sm:grid-cols-[160px_minmax(0,1fr)]">
          <dt>task_id</dt>
          <dd className="select-text">{task.task_id}</dd>
          <dt>kind</dt>
          <dd>{task.kind}</dd>
          <dt>状态版本</dt>
          <dd>{task.state_version}</dd>
          <dt>冻结时间（UTC）</dt>
          <dd>{task.fire_at_utc}</dd>
          <dt>创建时间</dt>
          <dd>{task.created_at}</dd>
          {task.recreated_from ? (
            <>
              <dt>重约自</dt>
              <dd>
                <Link
                  className="text-primary underline"
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
  );
}
