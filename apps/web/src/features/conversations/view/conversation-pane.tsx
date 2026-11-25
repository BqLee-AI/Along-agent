'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from '@/shell/view/workspace-link';
import { Brand } from '@/shared/ui/brand';
import { ArrowDown, Bell, MessageSquareText, PanelLeftOpen, Plus } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import type { TaskIntent } from '../model/task';
import { conversationHref, runStatusLabel } from '../model/conversation-run';
import { archivedReplyRuns } from '../model/presentation';
import { useConversationTask } from '../viewmodel/use-conversation-task';
import { useConversationPresentation } from '../viewmodel/use-conversation-presentation';
import { useConversationScroll } from '../viewmodel/use-conversation-scroll';
import { useComposerFocus } from '../viewmodel/use-composer-display';
import { useConversationHistory } from '../viewmodel/use-conversation-history';
import { ConversationHistory } from './conversation-history';
import { ConversationSidebar } from './conversation-sidebar';
import { MessageRow, StreamingMessage } from './conversation-messages';
import { RunResults } from './run-results';
import { LeaveRunDialog, RunStatusPanel, TaskComposer } from './task-views';

export interface ConversationPaneProps {
  conversationId?: string | null;
  runId?: string | null;
  initialIntent?: TaskIntent | null;
  headerActions?: ReactNode;
  /** Shows the persistent conversation list on wide screens. */
  sidebar?: boolean;
}

export default function ConversationPane({
  conversationId = null,
  runId = null,
  initialIntent = 'chat',
  headerActions,
  sidebar = false,
}: ConversationPaneProps) {
  const task = useConversationTask({ conversationId, runId, initialIntent });
  const history = useConversationHistory();
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
  const scroll = useConversationScroll(selected ? selected.conversationId : conversationId);
  const focusComposer = useComposerFocus();
  const startNewConversation = useCallback(() => {
    if (!task.selected && !task.active) {
      task.setInput('');
      task.clearFiles();
      task.setIntent('chat');
      focusComposer();
    }
  }, [task, focusComposer]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarShown = sidebar && sidebarOpen;
  const reduceMotion = useReducedMotion();
  const fileDragDepth = useRef(0);
  const [fileDrag, setFileDrag] = useState(false);
  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      <AnimatePresence initial={false}>
        {sidebarShown ? (
          <m.div
            key="conversation-sidebar"
            className="hidden shrink-0 overflow-hidden lg:block"
            initial={{ width: 0 }}
            animate={{ width: 256 }}
            exit={{ width: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.32, 0.72, 0, 1] }}
          >
            <ConversationSidebar
              history={history}
              activeId={selected ? selected.conversationId : conversationId}
              onNew={startNewConversation}
              onCollapse={() => setSidebarOpen(false)}
            />
          </m.div>
        ) : null}
      </AnimatePresence>
      <section
        className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-background [&_[data-slot=markdown]]:text-sm! [&_[data-slot=markdown]]:leading-6! [&_[data-slot=markdown]_a]:text-brand-ink!"
        data-testid="conversation-chat"
        aria-label="Along 对话"
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          fileDragDepth.current++;
          setFileDrag(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = task.active ? 'none' : 'copy';
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
          if (!task.active && event.dataTransfer.files.length) {
            void task.addFiles(Array.from(event.dataTransfer.files));
            focusComposer();
          }
        }}
      >
        {fileDrag && !task.active ? (
          <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand-ink bg-background/85 font-medium text-foreground">
            松开以添加文件
          </div>
        ) : null}
        <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            {sidebar && !sidebarOpen ? (
              <button
                type="button"
                className="hidden size-8 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring lg:inline-flex"
                aria-label="展开会话栏"
                title="展开会话栏"
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            <h1
              className={`text-sm leading-5 font-semibold max-[400px]:sr-only ${sidebar ? 'lg:sr-only' : ''}`}
            >
              <Brand height={20} />
            </h1>
          </div>
          <nav
            className="chat-dock relative flex shrink-0 items-center gap-0.5 rounded-full p-1"
            aria-label="会话操作"
          >
            <div className={sidebar ? 'contents lg:hidden' : 'contents'}>
              <ConversationHistory history={history} />
              <Link
                href="/conversations"
                onClick={startNewConversation}
                aria-label="新对话"
                className="inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-control px-2 text-[13px] text-secondary-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-lg:min-h-11 max-lg:min-w-11"
              >
                <Plus className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">新对话</span>
              </Link>
            </div>
            {headerActions}
          </nav>
        </header>
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
                {!task.messages.length && !task.liveReply && !task.reading ? (
                  <div
                    className="relative flex min-h-[min(56dvh,520px)] flex-col items-center justify-center gap-6 py-10 text-center"
                    data-testid="chat-greeting"
                  >
                    <div aria-hidden="true" className="relative">
                      <Brand height={28} />
                    </div>
                    <h2 className="relative text-2xl leading-8 font-semibold tracking-tight">
                      你好，想聊点什么？
                    </h2>
                    <div className="relative flex flex-wrap items-center justify-center gap-2">
                      {[
                        {
                          intent: 'chat',
                          title: '梳理一个想法',
                          input: '我想和你一起梳理一个想法。',
                          icon: MessageSquareText,
                        },
                        { intent: 'reminder', title: '安排提醒', input: '', icon: Bell },
                      ].map(({ intent, title, input, icon: Icon }) => (
                        <button
                          key={intent}
                          type="button"
                          className="inline-flex h-9 items-center gap-2 rounded-full border-0 bg-transparent px-4 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 motion-reduce:transition-none max-lg:min-h-11"
                          disabled={task.active || task.reading}
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
          <div className="mx-auto w-full max-w-[720px]">
            <TaskComposer task={task} />
          </div>
        </div>
        <LeaveRunDialog task={task} />
      </section>
    </div>
  );
}
