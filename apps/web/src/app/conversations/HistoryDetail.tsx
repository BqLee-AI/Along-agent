'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
  type MessageHistoryItem,
  type ConversationRunHistoryItem,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { PageHeading, EmptyState, ErrorNotice } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useConversationTask } from '@/features/conversations/use-conversation-task';
import { LeaveRunDialog, RunStatusPanel } from '@/features/conversations/task-views';
import {
  collectRunTranscripts,
  conversationHref,
  mergeThreadEvents,
  readHistoryCollectionPage,
  readHistoryEventPage,
  runStatusLabel,
} from '../../lib/conversation-run';
import ApprovalHistory from './ApprovalHistory';
import Chat from './Chat';
import { ReadControls, useHistoryPage } from './HistoryResource';

function MessageArchive({ conversationId }: { conversationId: string }) {
  const loader = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor !== null) query.set('cursor', cursor);
      const page = await readHistoryCollectionPage(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
        ConversationMessagePageSchema,
        signal,
      );
      return { items: page.items, nextCursor: page.next_cursor };
    },
    [conversationId],
  );
  const { state, read } = useHistoryPage<MessageHistoryItem>(`messages:${conversationId}`, loader);
  return (
    <details className="rounded-xl border border-border bg-card p-4 md:p-6">
      <summary className="cursor-pointer font-medium">会话消息档案 · 已存原文</summary>
      <div className="mt-6 space-y-4">
        <p className="text-muted-foreground">
          已存 user / assistant 原文，不含
          system；不声明与所选运行的对应关系。最终助手档案不重复拼到运行回复，也不代表另一次输出。
        </p>
        {state.loaded && !state.reading && !state.error && !state.items.length ? (
          <EmptyState title="没有可见的已存消息" />
        ) : null}
        <div className="divide-y divide-border">
          {state.items.map((message) => (
            <article className="min-w-0 space-y-3 py-6" key={message.message_id}>
              <h3 className="font-semibold">
                {message.role === 'user' ? '用户原话档案' : '助手最终文本档案（未声明运行关联）'}
              </h3>
              <time className="text-sm text-muted-foreground" dateTime={message.created_at}>
                {message.created_at}
              </time>
              <pre className="whitespace-pre-wrap font-sans text-base leading-7 [overflow-wrap:anywhere]">
                {message.content}
              </pre>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer py-2">消息技术信息</summary>
                <p className="font-mono [overflow-wrap:anywhere]">{message.message_id}</p>
              </details>
            </article>
          ))}
        </div>
        <ReadControls state={state} read={read} label="消息档案" />
      </div>
    </details>
  );
}

function RunHistory({ conversationId, runId }: { conversationId: string; runId: string }) {
  const originalLoader = useCallback(
    async (_cursor: string | null, signal: AbortSignal) => {
      const query = new URLSearchParams({ run_id: runId });
      const page = await readHistoryCollectionPage(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/runs?${query}`,
        ConversationRunPageSchema,
        signal,
      );
      if (
        page.items.length !== 1 ||
        page.items[0]?.run_id !== runId ||
        page.items[0].conversation_id !== conversationId ||
        page.next_cursor !== null
      )
        throw new Error('指定运行读取不符合精确点查合同，未确认原文关联。');
      return { items: page.items, nextCursor: null };
    },
    [conversationId, runId],
  );
  const original = useHistoryPage<ConversationRunHistoryItem>(
    `original:${conversationId}:${runId}`,
    originalLoader,
  );
  const eventLoader = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const query = new URLSearchParams({ run_id: runId, after_seq: cursor ?? '0', limit: '200' });
      return readHistoryEventPage(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}?${query}`,
        conversationId,
        runId,
        Number(cursor ?? 0),
        signal,
      );
    },
    [conversationId, runId],
  );
  const replies = useHistoryPage<ThreadEvent>(`events:${conversationId}:${runId}`, eventLoader);
  const task = useConversationTask({ conversationId, runId, controlsOnly: true });
  const events = useMemo(
    () => mergeThreadEvents(replies.state.items, task.events),
    [replies.state.items, task.events],
  );
  const transcript = useMemo(
    () => collectRunTranscripts(events).get(runId) ?? { text: '', approvals: [] },
    [events, runId],
  );
  const unknownEvent = events.some(
    (event) => event.type === 'thread.failed' && event.payload.error.code === 'TOOL_EFFECT_UNKNOWN',
  );
  useEffect(() => {
    if (unknownEvent) task.observeEffect('external-event', true);
  }, [unknownEvent, task.observeEffect]);
  const approvals = [...transcript.approvals];
  if (task.run?.waiting) {
    const waiting = task.run.waiting;
    const kind =
      'approval_kind' in waiting && waiting.approval_kind === 'document' ? 'document' : 'task';
    if (!approvals.some((item) => item.kind === kind && item.approvalId === waiting.approval_id))
      approvals.push({ kind, approvalId: waiting.approval_id, seq: 0 });
  }
  const run = original.state.items[0];
  const incomplete =
    replies.state.error ||
    replies.state.reading ||
    !replies.state.loaded ||
    replies.state.nextCursor !== null;
  return (
    <section
      aria-label="指定运行阅读稿"
      className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_280px]"
    >
      <article className="min-w-0 max-w-[720px] space-y-8 xl:col-start-1 xl:row-start-1">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">可信关联的原话</h2>
          {run ? (
            <>
              <p className="text-sm text-muted-foreground">
                建立：{run.created_at} · 结束：{run.ended_at ?? '尚无结束记录'}
              </p>
              {run.original.state === 'available' ? (
                <>
                  <pre className="whitespace-pre-wrap font-sans text-base leading-7 [overflow-wrap:anywhere]">
                    {run.original.message.content}
                  </pre>
                  <details className="text-sm text-muted-foreground">
                    <summary className="cursor-pointer py-2">原话引用信息</summary>
                    <p className="font-mono [overflow-wrap:anywhere]">
                      {run.original.message.message_id}
                    </p>
                    <p>
                      {run.original.message.created_at} · {run.original.source}
                    </p>
                  </details>
                </>
              ) : run.original.state === 'legacy_unavailable' ? (
                <Alert>
                  <AlertDescription>
                    旧数据没有可信原话引用。可从消息档案读取原文，但不会猜测哪条消息属于此运行。
                  </AlertDescription>
                </Alert>
              ) : (
                <ErrorNotice message="原话引用完整性异常（invalid_reference），此部分历史不完整；不会按时间或内容猜测关联。" />
              )}
            </>
          ) : null}
          <ReadControls state={original.state} read={original.read} label="原话与运行索引" />
        </section>
        <div className="xl:hidden">
          <RunStatusPanel task={task} />
        </div>
        <section id="run-reply" className="space-y-4 border-t border-border pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">助手回复 · 当前获取的执行轮次</h2>
            {task.streaming && transcript.text ? (
              <a className="min-h-11 py-2 text-primary underline" href="#latest-reply">
                有新内容，查看末尾 ↓
              </a>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            助手文本不作为文件保存、核对或提醒登记的系统回执。
          </p>
          {transcript.text ? (
            <pre className="whitespace-pre-wrap font-sans text-base leading-7 [overflow-wrap:anywhere]">
              {transcript.text}
            </pre>
          ) : replies.state.loaded ? (
            <p className="text-muted-foreground">
              {incomplete
                ? '当前获取的部分尚无可见回复；事件尚未完整读取。'
                : '本次读取范围没有可见回复。'}
            </p>
          ) : null}
          <span id="latest-reply" />
          <ReadControls state={replies.state} read={replies.read} label="运行事件与回复" />
          <p className="text-sm text-muted-foreground">
            按持久 seq 去重，合并所有 attempt
            的已接受增量。满页请继续读取；空页也可能是确认当前末尾所必需。
          </p>
          {events.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer py-2 font-medium">
                读取到的外部事件（{events.length} 条）
              </summary>
              <ol className="divide-y divide-border">
                {events.map((event) => (
                  <li className="min-h-14 py-3 [overflow-wrap:anywhere]" key={event.seq}>
                    <span className="font-mono">
                      seq {event.seq} · {event.type}
                    </span>
                    {event.type === 'thread.failed' ? (
                      <p>
                        {event.payload.error.code}: {event.payload.error.message}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
        <section id="run-results" className="space-y-4 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">当前获取的修改与结果</h2>
          <p className="text-sm text-muted-foreground">
            每项批准单独读取并核对；一项已保存并核对，不表示整个运行的所有修改都成功。打开批准新标签保留当前执行连接。
          </p>
          {incomplete ? (
            <Alert>
              <AlertDescription>
                批准索引尚未完整读取；以下只是已获取事件和原等待点中的批准，不代表全部。
              </AlertDescription>
            </Alert>
          ) : null}
          {replies.state.loaded && !approvals.length ? (
            <p className="text-muted-foreground">
              {incomplete ? '当前部分尚无批准，不能推断没有批准。' : '本次读取范围没有批准事件。'}
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {approvals.map((reference) => (
              <ApprovalHistory
                key={`${reference.kind}:${reference.approvalId}`}
                reference={reference}
                conversationId={conversationId}
                runId={runId}
                onUnknownEffect={task.observeEffect}
              />
            ))}
          </ul>
        </section>
      </article>
      <aside className="hidden min-w-0 xl:col-start-2 xl:row-start-1 xl:block">
        <RunStatusPanel task={task} />
      </aside>
      <LeaveRunDialog task={task} />
    </section>
  );
}

export default function HistoryDetail({
  conversationId,
  runId,
}: {
  conversationId: string;
  runId: string | null;
}) {
  const [composing, setComposing] = useState(false);
  const loader = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor !== null) query.set('cursor', cursor);
      const page = await readHistoryCollectionPage(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/runs?${query}`,
        ConversationRunPageSchema,
        signal,
      );
      if (page.items.some((run) => run.conversation_id !== conversationId))
        throw new Error('运行列表会话归属不匹配，未接纳此页。');
      return { items: page.items, nextCursor: page.next_cursor };
    },
    [conversationId],
  );
  const { state, read } = useHistoryPage<ConversationRunHistoryItem>(
    `runs:${conversationId}`,
    loader,
  );
  return (
    <div className="space-y-8">
      <nav aria-label="会话位置" className="flex flex-wrap gap-4 text-sm">
        <Link
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          href="/conversations"
        >
          全部会话
        </Link>
        {runId ? (
          <Link
            className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            href={`/conversations?${new URLSearchParams({ conversation_id: conversationId })}`}
          >
            此会话的运行列表
          </Link>
        ) : null}
      </nav>
      <PageHeading
        title={`会话 ${conversationId.slice(0, 8)}`}
        description="历史默认只读。原话、运行、回复、批准和消息档案独立读取，不表示原子快照，也不代表当前动作授权。"
      />
      <section className="space-y-4" aria-label="运行导航">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">运行 · 按建立时间从早到晚</h2>
          {runId ? <Badge variant="outline">当前运行 {runId.slice(0, 8)}</Badge> : null}
        </div>
        {runId ? (
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer font-medium">选择其他运行（仅已加载范围）</summary>
            <RunIndex conversationId={conversationId} runId={runId} items={state.items} />
            <ReadControls state={state} read={read} label="运行列表" />
          </details>
        ) : (
          <>
            <RunIndex conversationId={conversationId} runId={runId} items={state.items} />
            <ReadControls state={state} read={read} label="运行列表" />
          </>
        )}
        {state.loaded && !state.reading && !state.error && !state.items.length ? (
          <EmptyState title="此会话没有已存运行" description="消息档案仍可独立读取。" />
        ) : null}
      </section>
      {runId ? (
        <RunHistory
          key={`${conversationId}:${runId}`}
          conversationId={conversationId}
          runId={runId}
        />
      ) : (
        <p className="text-muted-foreground">
          选择一个运行，读取可信原话、全部回复与逐项批准结果；不会自动选中或执行最后一次运行。
        </p>
      )}
      <MessageArchive conversationId={conversationId} />
      <section className="space-y-4 border-t border-border pt-6">
        {runId ? (
          <Button variant="outline" asChild>
            <Link
              href={`/conversations?${new URLSearchParams({ conversation_id: conversationId })}`}
            >
              返回会话并发起新任务
            </Link>
          </Button>
        ) : (
          <Button
            variant="outline"
            type="button"
            disabled={composing}
            onClick={() => setComposing(true)}
          >
            在此会话发起新任务
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          这不是历史恢复。请先核对原运行；只有明确提交才创建新执行，避免重复提交同一目标。
        </p>
        {!runId && composing ? <Chat conversationId={conversationId} /> : null}
      </section>
    </div>
  );
}

function RunIndex({
  conversationId,
  runId,
  items,
}: {
  conversationId: string;
  runId: string | null;
  items: ConversationRunHistoryItem[];
}) {
  return (
    <ul className="divide-y divide-border">
      {items.map((run) => (
        <li
          className={`min-w-0 py-4 [overflow-wrap:anywhere] ${run.run_id === runId ? 'border-l-2 border-primary pl-4' : ''}`}
          key={run.run_id}
        >
          <Link
            className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
            href={conversationHref(conversationId, run.run_id)}
            aria-current={run.run_id === runId ? 'page' : undefined}
          >
            {run.original.state === 'available'
              ? run.original.message.content.split(/\r?\n/, 1)[0] ||
                `运行 ${run.run_id.slice(0, 8)}`
              : `运行 ${run.run_id.slice(0, 8)} · 原话未可靠关联`}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {runStatusLabel[run.status]} · {run.execution === 'harness' ? '资料处理' : '提醒提议'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            建立：{run.created_at} · 辅助短号 {run.run_id.slice(0, 8)}
          </p>
        </li>
      ))}
    </ul>
  );
}
