'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown } from 'lucide-react';
import type { ConversationRunHistoryItem } from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Card } from '@lorelum/lumen-ui/components/card';
import { useConversationTask } from '@/features/conversations/use-conversation-task';
import { AssistantMarkdown } from '@/features/conversations/assistant-markdown';
import { LeaveRunDialog, RunStatusPanel, TaskComposer } from '@/features/conversations/task-views';
import {
  isNearChatBottom,
  messageRunReference,
  type TaskIntent,
} from '@/features/conversations/task-model';
import { conversationHref, runStatusLabel } from '@/lib/conversation-run';
import ApprovalHistory from './ApprovalHistory';

export default function Chat({
  conversationId = null,
  runId = null,
  initialIntent = 'chat',
}: {
  conversationId?: string | null;
  runId?: string | null;
  initialIntent?: TaskIntent | null;
}) {
  const task = useConversationTask({ conversationId, runId, initialIntent });
  const selected = task.selected;
  const transcript = selected ? task.transcript.get(selected.runId) : null;
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const runEntries: { runId: string; history?: ConversationRunHistoryItem }[] = task.runs.map(
    (run) => ({ runId: run.run_id, history: run }),
  );
  if (selected && !runEntries.some((entry) => entry.runId === selected.runId))
    runEntries.push({ runId: selected.runId });
  const needsAction =
    task.effectsUnknown ||
    task.run?.status === 'suspended_approval' ||
    Boolean(task.run?.can_resume);
  const showReminderResult = Object.keys(task.reminderResults).length > 0;
  const otherBlockingRuns = task.runs.filter(
    (run) =>
      run.run_id !== selected?.runId &&
      (run.status === 'suspended_approval' || run.status === 'running'),
  );

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (scroll && following.current) scroll.scrollTop = scroll.scrollHeight;
  }, [task.messages, task.liveOriginal, transcript?.text, task.streaming, task.reading, task.run]);
  useLayoutEffect(() => {
    const scroll = viewport.current;
    const body = content.current;
    if (!scroll || !body) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(body);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="conversation-chat">
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewport}
          className="h-full overflow-y-auto overscroll-contain"
          data-testid="chat-scroll"
          onScroll={(event) => {
            following.current = isNearChatBottom(event.currentTarget);
            setShowLatest(!following.current);
          }}
        >
          <div
            ref={content}
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 pb-8 pt-6 sm:px-6 sm:pt-10"
          >
            <section
              className="min-w-0 flex-1 space-y-7"
              aria-label="会话消息"
              aria-busy={task.reading}
            >
              {!task.messages.length && !task.liveReply && !task.reading ? (
                <div
                  className="flex min-h-[30dvh] flex-col items-center justify-center gap-3 text-center"
                  data-testid="chat-greeting"
                >
                  <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                    今天有什么想聊的？
                  </h2>
                  <p className="text-sm text-muted-foreground">从一条消息开始。</p>
                </div>
              ) : null}
              {task.messages.length ? (
                <ol className="space-y-7" data-testid="chat-messages">
                  {task.messages.map((message) => {
                    const reference = messageRunReference(message, task.runs);
                    return (
                      <li
                        key={message.message_id}
                        className={`min-w-0 ${message.role === 'user' ? 'flex flex-col items-end' : ''}`}
                        data-message-role={message.role}
                      >
                        <span className="sr-only">{message.role === 'user' ? '你' : '助手'}</span>
                        {message.role === 'user' ? (
                          <Card
                            material="balanced"
                            size="sm"
                            className="max-w-[90%] px-4 text-base whitespace-pre-wrap leading-7 [overflow-wrap:anywhere]"
                          >
                            {message.content}
                          </Card>
                        ) : (
                          <AssistantMarkdown text={message.content} />
                        )}
                        {reference && selected ? (
                          <details className="mt-1 text-xs text-muted-foreground">
                            <summary className="min-h-8 content-center">消息详情</summary>
                            <Link
                              className="inline-flex min-h-11 items-center text-primary underline"
                              href={conversationHref(selected.conversationId, reference)}
                            >
                              查看关联运行
                            </Link>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              {task.reading && !task.messages.length ? (
                <p role="status" className="text-sm text-muted-foreground">
                  正在读取会话…
                </p>
              ) : null}
              {task.liveReply ? (
                <section id="run-reply" className="min-w-0 space-y-7" aria-label="当前回复">
                  {task.liveOriginal !== null ? (
                    <div className="flex justify-end" data-message-role="user">
                      <Card
                        material="balanced"
                        size="sm"
                        className="max-w-[90%] px-4 text-base whitespace-pre-wrap leading-7 [overflow-wrap:anywhere]"
                      >
                        {task.liveOriginal}
                      </Card>
                    </div>
                  ) : null}
                  <div className="min-w-0" data-message-role="assistant" aria-busy={task.streaming}>
                    {transcript?.text ? (
                      <AssistantMarkdown text={transcript.text} streaming={task.streaming} />
                    ) : null}
                    {task.streaming ? (
                      <p
                        role="status"
                        className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
                        data-testid="reply-waiting"
                      >
                        <span className="size-2 rounded-full bg-current" aria-hidden="true" />
                        {transcript?.text ? '正在回复…' : '正在思考…'}
                      </p>
                    ) : !transcript?.text ? (
                      <p className="text-sm text-muted-foreground">
                        尚未收到回复，请核对运行状态。
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : null}
              <span id="latest-reply" />
            </section>
            {otherBlockingRuns.length && selected ? (
              <div className="space-y-2 p-4 text-sm" data-testid="other-blocking-runs">
                <p>会话中还有未结束的运行，请先处理原等待点。</p>
                {otherBlockingRuns.map((run) => (
                  <Link
                    key={run.run_id}
                    className="flex min-h-11 items-center text-primary underline"
                    href={conversationHref(selected.conversationId, run.run_id)}
                  >
                    打开原运行 · {runStatusLabel[run.status]}
                  </Link>
                ))}
              </div>
            ) : null}
            <RunStatusPanel task={task} />
            {runEntries.length && selected ? (
              <details
                id="run-results"
                open={needsAction || showReminderResult || undefined}
                className="min-w-0 px-4 py-2"
                data-testid="run-results"
              >
                <summary className="min-h-11 content-center text-sm text-muted-foreground">
                  批准与结果 · {runEntries.length} 次运行
                </summary>
                <div className="space-y-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    助手文本不代表工具已执行。提醒可在此确认并继续原运行；文档批准后仍需明确继续。
                  </p>
                  {runEntries.map((entry) => {
                    const isSelected = entry.runId === selected.runId;
                    const reply = task.transcript.get(entry.runId);
                    const approvals = [...(reply?.approvals ?? [])];
                    const waiting = isSelected ? task.run?.waiting : null;
                    if (waiting) {
                      const kind =
                        'approval_kind' in waiting && waiting.approval_kind === 'document'
                          ? 'document'
                          : 'task';
                      if (
                        !approvals.some(
                          (item) => item.kind === kind && item.approvalId === waiting.approval_id,
                        )
                      )
                        approvals.push({ kind, approvalId: waiting.approval_id, seq: 0 });
                    }
                    return (
                      <details
                        className="min-w-0 border-t border-border pt-2"
                        open={(isSelected && (needsAction || showReminderResult)) || undefined}
                        key={entry.runId}
                      >
                        <summary className="min-h-11 content-center text-sm font-medium [overflow-wrap:anywhere]">
                          运行 {entry.runId.slice(0, 8)} ·{' '}
                          {isSelected && task.run
                            ? runStatusLabel[task.run.status]
                            : entry.history
                              ? runStatusLabel[entry.history.status]
                              : '状态尚未确认'}
                          {isSelected ? ' · 当前所选' : ''}
                        </summary>
                        <div className="space-y-4 pt-3">
                          <Link
                            className="inline-flex min-h-11 items-center text-sm text-primary underline"
                            href={conversationHref(selected.conversationId, entry.runId)}
                          >
                            读取此运行并操作原等待点
                          </Link>
                          <details className="text-sm">
                            <summary className="min-h-11 content-center">原话与运行文本</summary>
                            <div className="space-y-3 py-3">
                              {entry.history?.original.state === 'available' ? (
                                <>
                                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                                    {entry.history.original.message.content}
                                  </p>
                                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                    引用：{entry.history.original.message.message_id} ·{' '}
                                    {entry.history.original.source}
                                  </p>
                                </>
                              ) : entry.history ? (
                                <p className="text-muted-foreground">
                                  {entry.history.original.state === 'invalid_reference'
                                    ? '原话引用完整性异常，不猜测关联。'
                                    : '旧运行没有可信原话引用，消息仍独立展示。'}
                                </p>
                              ) : null}
                              {reply?.text ? <AssistantMarkdown text={reply.text} /> : null}
                            </div>
                          </details>
                          {approvals.length ? (
                            <ul className="divide-y divide-border">
                              {approvals.map((reference) => (
                                <ApprovalHistory
                                  key={`${reference.kind}:${reference.approvalId}`}
                                  reference={reference}
                                  conversationId={selected.conversationId}
                                  runId={entry.runId}
                                  onUnknownEffect={task.observeEffect}
                                  task={isSelected ? task : undefined}
                                />
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              当前读取范围尚无批准引用，不推断工具效果。
                            </p>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </div>
        </div>
        {showLatest ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <Button
              variant="glass"
              color="default"
              className="pointer-events-auto"
              data-testid="jump-latest"
              onClick={() => {
                following.current = true;
                setShowLatest(false);
                if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
              }}
            >
              <ArrowDown aria-hidden="true" />
              回到最新
            </Button>
          </div>
        ) : null}
      </div>
      <div
        className="shrink-0 bg-background px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
        data-testid="composer-dock"
      >
        <div className="mx-auto w-full max-w-3xl">
          <TaskComposer task={task} />
        </div>
      </div>
      <LeaveRunDialog task={task} />
    </div>
  );
}
