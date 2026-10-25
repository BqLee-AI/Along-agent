'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  ExecutionKindSchema,
  RunViewSchema,
  type ExecutionKind,
  type RunView,
} from '@along/contracts';
import { AmbiguousTimeDetailsSchema, type ThreadEvent } from '@along/stream-protocol';
import { z } from 'zod';
import { MeSchema, type Me } from '../../lib/types';
import {
  consumeThreadStream,
  ConversationEventsSchema,
  ResumeRequestSchema,
  conversationHref,
  mergeThreadEvents,
  readEnvelope,
  readRun,
  runPath,
  runStatusLabel,
  type ResumeRequest,
} from '../../lib/conversation-run';

type AmbiguousTimeDetails = z.infer<typeof AmbiguousTimeDetailsSchema>;
type FoldCandidate = AmbiguousTimeDetails['candidates'][number];
interface AmbiguousProposal extends AmbiguousTimeDetails {
  raw_text: string;
}

export default function Chat({
  conversationId = null,
  runId = null,
}: {
  conversationId?: string | null;
  runId?: string | null;
}) {
  const [input, setInput] = useState('');
  const [execution, setExecution] = useState<ExecutionKind>('business');
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [userTexts, setUserTexts] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [selected, setSelected] = useState<{ conversationId: string; runId: string } | null>(
    conversationId && runId ? { conversationId, runId } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [retryResume, setRetryResume] = useState<ResumeRequest | null>(null);
  const [ambiguousProposal, setAmbiguousProposal] = useState<AmbiguousProposal | null>(null);
  const busyRef = useRef(false);
  const conversationRef = useRef(conversationId);
  const selectedRef = useRef(selected);
  const csrfRef = useRef<Me | null>(null);
  const streamRef = useRef<AbortController | null>(null);
  const cursorRef = useRef(0);
  const seenRef = useRef(new Set<number>());
  const cancelKeyRef = useRef<string | null>(null);

  async function loadMe(): Promise<Me> {
    if (!csrfRef.current) {
      csrfRef.current = MeSchema.parse(
        await readEnvelope(await fetch('/api/v1/me', { cache: 'no-store' })),
      );
    }
    return csrfRef.current;
  }

  function selectRun(cid: string, rid: string): void {
    const next = { conversationId: cid, runId: rid };
    conversationRef.current = cid;
    selectedRef.current = next;
    setSelected(next);
    setRun(null);
    setRetryResume(null);
    cancelKeyRef.current = null;
    window.history.replaceState(null, '', conversationHref(cid, rid));
  }

  function applyEvent(event: ThreadEvent, rawText?: string): void {
    if (seenRef.current.has(event.seq)) return;
    seenRef.current.add(event.seq);
    cursorRef.current = Math.max(cursorRef.current, event.seq);
    setEvents((current) => mergeThreadEvents(current, [event]));
    if (event.type === 'thread.started' && rawText !== undefined) {
      const cid = event.payload.conversation_id;
      const rid = event.payload.run_id;
      if (typeof cid === 'string' && typeof rid === 'string') {
        selectRun(cid, rid);
        setUserTexts((current) => ({ ...current, [rid]: rawText }));
      }
    }
    if (event.type === 'thread.failed') {
      const detail = event.payload.error;
      setError(`${detail.code}: ${detail.message}`);
      if (rawText !== undefined && detail?.code === 'AMBIGUOUS_LOCAL_TIME' && detail.details) {
        setAmbiguousProposal({
          ...AmbiguousTimeDetailsSchema.parse(detail.details),
          raw_text: rawText,
        });
      }
    }
  }

  async function refresh(): Promise<void> {
    const target = selectedRef.current;
    if (!target) return;
    setReading(true);
    try {
      // GET only reads projections. It never starts or resumes execution.
      for (;;) {
        const response = await fetch(
          `/api/v1/conversations/${encodeURIComponent(target.conversationId)}?after_seq=${cursorRef.current}&limit=200`,
          { cache: 'no-store' },
        );
        const data = ConversationEventsSchema.parse(await readEnvelope(response));
        for (const event of data.events) applyEvent(event);
        if (data.events.length < 200 || data.next_after_seq === null) break;
      }
      const view = await readRun(target.conversationId, target.runId);
      if (selectedRef.current?.runId !== target.runId) return;
      setRun(view);
      setExecution(view.execution);
      const stored = sessionStorage.getItem(`run-resume:${target.conversationId}:${target.runId}`);
      if (stored) {
        setRetryResume(ResumeRequestSchema.parse(JSON.parse(stored)));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法读取运行状态。');
    } finally {
      setReading(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => streamRef.current?.abort();
    // Initial URL identities are immutable for this mounted conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function stream(url: string, body: object, rawText?: string): Promise<boolean> {
    const controller = new AbortController();
    streamRef.current = controller;
    try {
      const me = await loadMe();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(me.csrf_token !== null ? { 'x-csrf-token': me.csrf_token } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      await consumeThreadStream(response, (event) => applyEvent(event, rawText));
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          failure instanceof Error
            ? failure.message
            : '连接中断，请读取原运行状态，不要重新发送原话。',
        );
      }
      return false;
    } finally {
      streamRef.current = null;
      await refresh();
    }
  }

  async function send(candidate?: FoldCandidate): Promise<void> {
    const proposal = candidate ? ambiguousProposal : null;
    const text = proposal?.raw_text ?? input;
    if (text.trim() === '' || busyRef.current || (candidate && !proposal)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    if (!candidate) setAmbiguousProposal(null);
    try {
      const me = await loadMe();
      // A new send has no Run authority until its own thread.started arrives.
      selectedRef.current = null;
      setSelected(null);
      setRun(null);
      setRetryResume(null);
      cancelKeyRef.current = null;
      const accepted = await stream(
        '/api/v1/conversations/messages',
        {
          raw_text: text,
          conversation_id: conversationRef.current ?? undefined,
          confirmed_timezone: proposal?.timezone_id ?? me.confirmed_timezone,
          fold_choice: candidate?.fold_choice,
          execution,
          idempotency_key: crypto.randomUUID(),
        },
        text,
      );
      if (accepted && !candidate) setInput('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '请先登录。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function resume(): Promise<void> {
    const target = selectedRef.current;
    if (!target || busyRef.current || stopping) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const current = await readRun(target.conversationId, target.runId);
      setRun(current);
      let request = retryResume;
      if (current.can_resume && current.waiting) {
        if (request?.checkpoint_id !== current.waiting.checkpoint_id) {
          request = {
            checkpoint_id: current.waiting.checkpoint_id,
            idempotency_key: crypto.randomUUID(),
          };
        }
      } else if (!request) {
        setError('原运行尚不可继续。若决议早于挂起，请稍后读取状态；pending 不能继续。');
        return;
      }
      if (!request) return;
      sessionStorage.setItem(
        `run-resume:${target.conversationId}:${target.runId}`,
        JSON.stringify(request),
      );
      setRetryResume(request);
      // Retain exactly this checkpoint/key after a lost response. No message,
      // approval confirmation, successor selection or new Run is created here.
      await stream(`${runPath(target.conversationId, target.runId)}/actions/resume`, request);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '继续结果未知，请读取原运行后重试继续。',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    const target = selectedRef.current;
    if (!target || stopping) return;
    setStopping(true);
    setError(null);
    try {
      const me = await loadMe();
      const storageKey = `run-cancel:${target.conversationId}:${target.runId}`;
      const key = cancelKeyRef.current ?? sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      cancelKeyRef.current = key;
      sessionStorage.setItem(storageKey, key);
      const cancelled = RunViewSchema.parse(
        await readEnvelope(
          await fetch(`${runPath(target.conversationId, target.runId)}/actions/cancel`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(me.csrf_token !== null ? { 'x-csrf-token': me.csrf_token } : {}),
            },
            body: JSON.stringify({ idempotency_key: key, reason: 'user_requested' }),
          }),
        ),
      );
      setRun(cancelled);
      // Commit cancellation first; aborting transport alone is not a stop receipt.
      streamRef.current?.abort();
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '停止结果未知。请读取原运行状态或重试停止。',
      );
    } finally {
      setStopping(false);
    }
  }

  const transcript = useMemo(() => {
    const turns = new Map<string, { text: string; approvalId: string | null }>();
    for (const event of events) {
      const rid = event.payload.run_id;
      if (typeof rid !== 'string') continue;
      let turn = turns.get(rid);
      if (!turn) {
        turn = { text: '', approvalId: null };
        turns.set(rid, turn);
      }
      if (event.type === 'message.delta' && typeof event.payload.delta === 'string')
        turn.text += event.payload.delta;
      if (event.type === 'approval_required' && typeof event.payload.approval_id === 'string')
        turn.approvalId = event.payload.approval_id;
    }
    return [...turns.entries()];
  }, [events]);
  const approvalId =
    run?.waiting?.approval_id ??
    transcript.find(([rid]) => rid === selected?.runId)?.[1].approvalId;
  const active =
    busy ||
    Boolean(selected && !run) ||
    run?.status === 'running' ||
    run?.status === 'suspended_approval';

  return (
    <section>
      <h1>对话</h1>
      <p className="subtitle">说清楚日期、时间和时区。确认前不会创建提醒，也不会排期。</p>
      <div className="chat-log" aria-label="对话记录">
        {transcript.map(([rid, turn]) => (
          <Fragment key={rid}>
            {userTexts[rid] ? <div className="bubble user">{userTexts[rid]}</div> : null}
            {turn.text ? <div className="bubble assistant">{turn.text}</div> : null}
          </Fragment>
        ))}
      </div>
      {selected ? (
        <div className="panel" aria-label="原运行状态" aria-busy={reading}>
          <p role="status">
            {run ? runStatusLabel[run.status] : '正在读取原运行状态；尚未确认结果。'}
          </p>
          <p className="muted">
            Run {selected.runId}
            {run ? ` · ${run.execution} · attempt ${run.attempt_no}` : ''}
          </p>
          {run?.status === 'suspended_approval' && !run.can_resume ? (
            <p>仍在等待原批准决议。批准、拒绝或修改后，读取状态并显式继续。</p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={reading || busy}
              onClick={() => {
                setError(null);
                void refresh();
              }}
            >
              读取运行状态
            </button>
            <button
              type="button"
              disabled={busy || reading || stopping || (!run?.can_resume && !retryResume)}
              onClick={() => void resume()}
            >
              {busy ? '处理中…' : run?.can_resume ? '继续原运行' : '重试原继续请求（不重复确认）'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={stopping || !active}
              onClick={() => void stop()}
            >
              {stopping ? '正在停止…' : '停止原运行'}
            </button>
          </div>
          <p className="muted">
            刷新或重新打开此地址只读已保存的事件，不会自动继续。连接中断不是完成或停止回执。
          </p>
        </div>
      ) : null}
      {approvalId && selected ? (
        <p>
          原提议：
          <a
            href={`/approvals/${encodeURIComponent(approvalId)}?${new URLSearchParams({ conversation_id: selected.conversationId, run_id: selected.runId })}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            去确认（新标签页）
          </a>
          <span className="muted">
            {' '}
            请保留此页，等待原运行保存等待点；决议后读取状态并显式继续。
          </span>
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {ambiguousProposal ? (
        <div aria-label="重复时刻选择" aria-busy={busy}>
          <p>
            当地时间 {ambiguousProposal.wall_time}（{ambiguousProposal.timezone_id}
            ）出现两次。请选择一次重新提议，选择不会确认或创建提醒。
          </p>
          <div className="actions">
            {ambiguousProposal.candidates.map((candidate) => (
              <button
                key={candidate.fold_choice}
                type="button"
                disabled={busy}
                onClick={() => void send(candidate)}
              >
                {candidate.fold_choice === 'first' ? '第一次' : '第二次'}（偏移{' '}
                {candidate.offset_seconds > 0 ? '+' : ''}
                {candidate.offset_seconds} 秒）
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="execution">执行方式</label>
        <select
          id="execution"
          value={execution}
          disabled={busy || Boolean(run && active)}
          onChange={(event) => setExecution(ExecutionKindSchema.parse(event.target.value))}
        >
          <option value="business">业务（默认）</option>
          <option value="harness">仓颉 Harness</option>
        </select>
        <p className="muted">仓颉依赖未就绪会明确报错，不会自动切换到业务。</p>
        <textarea
          rows={3}
          aria-label="提醒原文（日期、时间和时区）"
          disabled={Boolean(active)}
          value={input}
          placeholder="例如：明天 9:20 提醒我喝水（Asia/Shanghai）"
          onChange={(event) => {
            setInput(event.target.value);
            setAmbiguousProposal(null);
          }}
        />
        <div className="actions">
          <button type="submit" disabled={Boolean(active) || input.trim() === ''}>
            {busy ? '处理中…' : '发送'}
          </button>
        </div>
      </form>
    </section>
  );
}
