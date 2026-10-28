'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import {
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
  type MessageHistoryItem,
  type ConversationRunHistoryItem,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
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
    <details className="panel">
      <summary>已存消息档案（包含最终 assistant 文本，未声明 Run 关联）</summary>
      <p className="muted">
        这里只展示已存 user / assistant 原文，不含 system。最终 assistant 档案不再次拼入下方 Run
        回复，也不代表另一次输出。
      </p>
      {state.loaded && !state.reading && !state.error && !state.items.length ? (
        <p>当前没有可见的已存消息。</p>
      ) : null}
      {state.items.map((message) => (
        <article className="panel" key={message.message_id}>
          <h3>
            {message.role === 'user' ? '用户原话档案' : '最终 assistant 档案（未声明 Run 关联）'}
          </h3>
          <p className="muted">
            <time dateTime={message.created_at}>{message.created_at}</time> · {message.message_id}
          </p>
          <pre className="echo">{message.content}</pre>
        </article>
      ))}
      <ReadControls state={state} read={read} label="消息档案" />
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
      ) {
        throw new Error('指定 Run 读取不符合精确点查合同，未确认原文关联。');
      }
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
  const events = useMemo(() => mergeThreadEvents([], replies.state.items), [replies.state.items]);
  const transcript = useMemo(
    () => collectRunTranscripts(events).get(runId) ?? { text: '', approvals: [] },
    [events, runId],
  );
  const run = original.state.items[0];
  return (
    <section aria-label="指定 Run 历史">
      <h2>指定 Run {runId}</h2>
      <div className="panel">
        <h3>可信关联的原话</h3>
        {run ? (
          <>
            <p>
              {runStatusLabel[run.status]} · {run.execution}
            </p>
            <p className="muted">
              建立：{run.created_at} · 结束：{run.ended_at ?? '尚无结束记录'}
            </p>
            {run.original.state === 'available' ? (
              <>
                <pre className="echo">{run.original.message.content}</pre>
                <p className="muted">
                  真实消息 {run.original.message.message_id} · {run.original.message.created_at} ·
                  引用来源：{run.original.source}
                </p>
              </>
            ) : run.original.state === 'legacy_unavailable' ? (
              <p>旧数据没有可信原话引用。可展开消息档案读取原文，但不会猜测哪条消息属于此 Run。</p>
            ) : (
              <p className="error" role="alert">
                原话引用完整性异常（invalid_reference）。此部分历史不完整，不会按时间或内容猜测关联。
              </p>
            )}
          </>
        ) : null}
        <ReadControls state={original.state} read={original.read} label="Run 原话与索引" />
      </div>
      <div className="panel">
        <h3>原 Run 的已存回复（跨全部 attempt）</h3>
        {transcript.text ? (
          <pre className="echo">{transcript.text}</pre>
        ) : replies.state.loaded ? (
          <p>
            {replies.state.error || replies.state.reading || replies.state.nextCursor !== null
              ? '当前获取的部分尚无可见回复；本次事件读取尚未确认完整。'
              : '本次读取范围没有可见回复。'}
          </p>
        ) : null}
        <ReadControls state={replies.state} read={replies.read} label="Run 事件与回复" />
        <p className="muted">
          回复按持久 seq 去重、合并所有 attempt
          的已接受增量。满页需继续读取；一次空页也可能是确认当前末尾所必需。
        </p>
        {events.length ? (
          <details>
            <summary>查看获取的外部事件序列（{events.length} 条）</summary>
            <ol>
              {events.map((event) => (
                <li key={event.seq}>
                  seq {event.seq} · {event.type}
                  {event.type === 'thread.failed'
                    ? ` · ${event.payload.error.code}: ${event.payload.error.message}`
                    : ''}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      <h3>此 Run 读取到的批准及真实结果</h3>
      {replies.state.error ||
      replies.state.reading ||
      !replies.state.loaded ||
      replies.state.nextCursor !== null ? (
        <p className="notice">批准索引尚未完整读取；以下仅为本次获取事件中的批准，不代表全部。</p>
      ) : null}
      {replies.state.loaded && !transcript.approvals.length ? (
        <p>
          {replies.state.nextCursor === null && !replies.state.error && !replies.state.reading
            ? '本次读取范围没有批准事件。'
            : '当前获取的部分尚无批准，不能推断没有批准。'}
        </p>
      ) : null}
      <ul className="card-list">
        {transcript.approvals.map((reference) => (
          <ApprovalHistory
            key={`${reference.kind}:${reference.approvalId}`}
            reference={reference}
            conversationId={conversationId}
            runId={runId}
          />
        ))}
      </ul>
      <details className="panel">
        <summary>当前 Run 状态与显式操作（不会自动继续）</summary>
        <Chat conversationId={conversationId} runId={runId} controlsOnly />
      </details>
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
        throw new Error('Run 列表会话归属不匹配，未接纳此页。');
      return { items: page.items, nextCursor: page.next_cursor };
    },
    [conversationId],
  );
  const { state, read } = useHistoryPage<ConversationRunHistoryItem>(
    `runs:${conversationId}`,
    loader,
  );
  return (
    <section className="conversation-history">
      <nav aria-label="会话历史位置">
        <Link className="history-link" href="/conversations">
          全部会话
        </Link>
      </nav>
      <h1>会话历史</h1>
      <p className="subtitle">
        会话 {conversationId}。历史恢复只读取；各部分独立读取，不表示原子完整快照或当前动作授权。
      </p>
      <MessageArchive conversationId={conversationId} />
      <h2>全部 Run（按建立时间从早到晚）</h2>
      {state.loaded && !state.reading && !state.error && !state.items.length ? (
        <p>当前会话没有已存 Run。</p>
      ) : null}
      <ul className="card-list">
        {state.items.map((run) => (
          <li className="panel" key={run.run_id}>
            <Link
              className="history-link"
              href={conversationHref(conversationId, run.run_id)}
              aria-current={run.run_id === runId ? 'page' : undefined}
            >
              Run {run.run_id}
            </Link>
            <p>
              {runStatusLabel[run.status]} · {run.execution} · {run.created_at}
            </p>
          </li>
        ))}
      </ul>
      <ReadControls state={state} read={read} label="Run 列表" />
      {runId ? (
        <RunHistory key={runId} conversationId={conversationId} runId={runId} />
      ) : (
        <p>选择一个 Run 读取可信原话、全部回复与批准结果；消息档案也可独立展开。</p>
      )}
      <div className="panel">
        <button type="button" disabled={composing} onClick={() => setComposing(true)}>
          在此会话发送新消息
        </button>
        <p className="muted">
          这不是历史恢复。只有明确点击发送才创建新的执行；请先读取原 Run
          状态，避免重复提交同一目标。
        </p>
        {composing ? <Chat conversationId={conversationId} /> : null}
      </div>
    </section>
  );
}
