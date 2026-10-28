'use client';

import { useMemo } from 'react';
import { useConversationTask } from '@/features/conversations/use-conversation-task';
import { LeaveRunDialog, RunStatusPanel, TaskComposer } from '@/features/conversations/task-views';
import type { TaskIntent } from '@/features/conversations/task-model';
import ApprovalHistory from './ApprovalHistory';

export default function Chat({
  conversationId = null,
  initialIntent = null,
}: {
  conversationId?: string | null;
  initialIntent?: TaskIntent | null;
}) {
  const task = useConversationTask({ conversationId, initialIntent });
  const selected = task.selected;
  const transcript = task.selected ? task.transcript.get(task.selected.runId) : null;
  const approvals = useMemo(() => {
    const items = [...(transcript?.approvals ?? [])];
    const waiting = task.run?.waiting;
    if (waiting) {
      const kind =
        'approval_kind' in waiting && waiting.approval_kind === 'document' ? 'document' : 'task';
      if (!items.some((item) => item.kind === kind && item.approvalId === waiting.approval_id))
        items.push({ kind, approvalId: waiting.approval_id, seq: 0 });
    }
    return items;
  }, [transcript, task.run]);
  return (
    <div className="space-y-8">
      {!selected || task.ambiguousProposal || task.run?.status === 'failed' ? (
        <TaskComposer task={task} />
      ) : null}
      {selected ? (
        <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
          <article className="min-w-0 max-w-[720px] space-y-8 xl:col-start-1 xl:row-start-1">
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">原话</h2>
              <p className="whitespace-pre-wrap leading-7 [overflow-wrap:anywhere]">
                {task.original}
              </p>
            </section>
            <div className="xl:hidden">
              <RunStatusPanel task={task} />
            </div>
            <section id="run-reply" className="space-y-3 border-t border-border pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">助手回复</h2>
                {task.streaming && transcript?.text ? (
                  <a className="min-h-11 py-2 text-primary underline" href="#latest-reply">
                    有新内容，查看末尾 ↓
                  </a>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                以下为助手文本，不作为保存、核对或提醒登记回执。
              </p>
              {transcript?.text ? (
                <p className="whitespace-pre-wrap leading-7 [overflow-wrap:anywhere]">
                  {transcript.text}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {task.streaming ? '执行连接中，尚未收到可见回复。' : '当前读取范围没有可见回复。'}
                </p>
              )}
              <span id="latest-reply" />
            </section>
            <section id="run-results" className="space-y-4 border-t border-border pt-6">
              <h2 className="text-lg font-semibold">修改与结果</h2>
              <p className="text-sm text-muted-foreground">
                逐项展示已接收批准；授权与效果分别读取。打开新标签页审阅不会断开当前连接，返回后请读取状态并明确继续。
              </p>
              {approvals.length ? (
                <ul className="divide-y divide-border">
                  {approvals.map((reference) => (
                    <ApprovalHistory
                      key={`${reference.kind}:${reference.approvalId}`}
                      reference={reference}
                      conversationId={selected.conversationId}
                      runId={selected.runId}
                      onUnknownEffect={task.observeEffect}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">尚未收到批准事件，不推断处理结果。</p>
              )}
            </section>
          </article>
          <aside className="hidden min-w-0 xl:col-start-2 xl:row-start-1 xl:block">
            <RunStatusPanel task={task} />
          </aside>
        </div>
      ) : null}
      <LeaveRunDialog task={task} />
    </div>
  );
}
