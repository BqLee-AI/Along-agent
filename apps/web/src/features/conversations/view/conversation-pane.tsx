'use client';

import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from '@/shell/view/workspace-link';
import { ArrowDown, Bell, MessageSquareText } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import type { TaskIntent } from '../model/task';
import type { PersonalBot } from '../model/personal-bot';
import { conversationHref, runStatusLabel } from '../model/conversation-run';
import { archivedReplyRuns } from '../model/presentation';
import { useConversationTask } from '../viewmodel/use-conversation-task';
import { useConversationPresentation } from '../viewmodel/use-conversation-presentation';
import { useConversationScroll } from '../viewmodel/use-conversation-scroll';
import { useComposerFocus } from '../viewmodel/use-composer-display';
import { MessageRow, StreamingMessage } from './conversation-messages';
import { RunResults } from './run-results';
import { LeaveRunDialog, RunStatusPanel, TaskComposer } from './task-views';

interface ConversationPaneProps {
  bot: PersonalBot;
  conversationId: string;
  runId: string | null;
  initialIntent: TaskIntent | null;
  creatingConversation: boolean;
  header: (blockNewConversation: boolean) => ReactNode;
}

export default function ConversationPane({
  bot,
  conversationId,
  runId,
  initialIntent,
  creatingConversation,
  header,
}: ConversationPaneProps) {
  const task = useConversationTask({
    botId: bot.id,
    conversationId,
    runId,
    initialIntent,
    toolIds: bot.config.tool_ids,
    workspaceIds: bot.config.workspace_ids,
  });
  const { entries, blockedRuns, needsAction, showReminderResult } =
    useConversationPresentation(task);
  const selected = task.selected;
  const currentRun = task.run?.run_id === selected?.runId ? task.run : null;
  const runsById = useMemo(() => new Map(task.runs.map((run) => [run.run_id, run])), [task.runs]);
  const replyRuns = useMemo(
    () => archivedReplyRuns(task.messages, task.transcript),
    [task.messages, task.transcript],
  );
  const transcript = selected ? task.transcript.get(selected.runId) : null;
  const goalResult = currentRun?.goal_result ?? transcript?.goal_result;
  const replyText = goalResult ? goalResult.answer : transcript?.text;
  const scroll = useConversationScroll(conversationId);
  const focusComposer = useComposerFocus();
  const fileDragDepth = useRef(0);
  const [fileDrag, setFileDrag] = useState(false);
  return (
    <section
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-background [&_[data-slot=markdown]]:text-sm! [&_[data-slot=markdown]]:leading-6! [&_[data-slot=markdown]_a]:text-brand-ink!"
      data-testid="conversation-chat"
      aria-label={`与 ${bot.config.name} 的对话`}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        fileDragDepth.current++;
        setFileDrag(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = task.active || creatingConversation ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
        if (!fileDragDepth.current) setFileDrag(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        fileDragDepth.current = 0;
        setFileDrag(false);
        if (!task.active && !creatingConversation && event.dataTransfer.files.length) {
          void task.addFiles(Array.from(event.dataTransfer.files));
          focusComposer();
        }
      }}
    >
      {fileDrag && !task.active && !creatingConversation ? (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand-ink bg-background/85 font-medium text-foreground">
          松开以添加文件
        </div>
      ) : null}
      {header(task.admitting || task.streaming)}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroll.viewport}
          onScroll={scroll.onScroll}
          className="h-full overflow-y-auto overscroll-contain px-4 sm:px-6"
          data-testid="chat-scroll"
        >
          <div
            ref={scroll.content}
            className="mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-8 pt-6 pb-8"
          >
            <section
              className="min-w-0 flex-1 space-y-8 text-sm leading-6"
              aria-label="会话消息"
              aria-busy={task.reading}
            >
              {!task.messages.length && !task.liveReply && !task.reading && !task.readError ? (
                <div
                  className="relative flex min-h-[min(56dvh,520px)] flex-col items-center justify-center gap-6 py-10 text-center"
                  data-testid="chat-greeting"
                >
                  <h2 className="relative text-2xl leading-8 font-semibold tracking-tight">
                    与 {bot.config.name} 开始对话
                  </h2>
                  {bot.config.introduction ? (
                    <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                      {bot.config.introduction}
                    </p>
                  ) : null}
                  <div className="relative flex flex-wrap items-center justify-center gap-2">
                    {[
                      {
                        intent: 'chat',
                        title: '梳理一个想法',
                        input: '我想和你一起梳理一个想法。',
                        icon: MessageSquareText,
                      },
                      { intent: 'reminder', title: '安排提醒', input: '', icon: Bell },
                    ]
                      .filter(({ intent }) => intent === 'chat' || task.reminderAllowed)
                      .map(({ intent, title, input, icon: Icon }) => (
                        <button
                          key={intent}
                          type="button"
                          className="inline-flex h-9 items-center gap-2 rounded-full border-0 bg-transparent px-4 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 motion-reduce:transition-none max-lg:min-h-11"
                          disabled={task.active || creatingConversation}
                          onClick={() => {
                            task.setIntent(intent as TaskIntent);
                            if (input && !task.input.trim()) task.setInput(input);
                            focusComposer();
                          }}
                        >
                          <Icon className="size-4 shrink-0 text-brand-ink" aria-hidden="true" />
                          {title}
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}
              {task.messages.length ? (
                <ol className="space-y-6" data-testid="chat-messages">
                  {task.messages.map((message) => {
                    const runId = replyRuns.get(message.message_id);
                    const run = runId
                      ? currentRun?.run_id === runId
                        ? currentRun
                        : runsById.get(runId)
                      : undefined;
                    return (
                      <MessageRow
                        key={message.message_id}
                        message={message}
                        run={run}
                        facts={runId ? task.transcript.get(runId) : undefined}
                      />
                    );
                  })}
                </ol>
              ) : null}
              {task.reading && !task.messages.length ? (
                <p role="status" className="text-sm leading-[22px] text-secondary-foreground">
                  正在读取会话…
                </p>
              ) : null}
              {task.liveReply ? (
                <StreamingMessage
                  run={currentRun ?? (selected ? runsById.get(selected.runId) : undefined)}
                  facts={transcript ?? undefined}
                  original={task.liveOriginal}
                  text={replyText ?? ''}
                  streaming={task.streaming}
                  answerFinal={Boolean(goalResult)}
                />
              ) : null}
              <span id="latest-reply" />
            </section>
            {blockedRuns.length && selected ? (
              <div
                className="space-y-2 border-t border-separator pt-4 text-sm leading-[22px]"
                data-testid="other-blocking-runs"
              >
                <p>会话中还有未结束的运行，请先处理原等待点。</p>
                {blockedRuns.map((run) => (
                  <Link
                    key={run.run_id}
                    className="flex min-h-11 items-center text-brand-ink underline"
                    href={conversationHref(selected.conversationId, run.run_id)}
                  >
                    打开原运行 · {runStatusLabel[run.status]}
                  </Link>
                ))}
              </div>
            ) : null}
            <RunStatusPanel task={task} />
            <RunResults
              task={task}
              conversationId={selected?.conversationId ?? conversationId}
              entries={entries}
              needsAction={needsAction}
              showReminderResult={showReminderResult}
            />
          </div>
        </div>
        {scroll.showLatest ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <Button
              variant="glass"
              color="default"
              className="pointer-events-auto"
              data-testid="jump-latest"
              onClick={scroll.jumpLatest}
            >
              <ArrowDown aria-hidden="true" />
              回到最新
            </Button>
          </div>
        ) : null}
      </div>
      <div
        className="shrink-0 px-3 pt-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
        data-testid="composer-dock"
      >
        <fieldset className="mx-auto w-full max-w-[720px]" disabled={creatingConversation}>
          <TaskComposer task={task} botName={bot.config.name} />
        </fieldset>
      </div>
      <LeaveRunDialog task={task} />
    </section>
  );
}
