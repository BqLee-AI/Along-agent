'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RunViewSchema,
  workspaceSummarySchema,
  type RunView,
  type WorkspaceSummary,
} from '@along/contracts';
import { AmbiguousTimeDetailsSchema, type ThreadEvent } from '@along/stream-protocol';
import { z } from 'zod';
import { MeSchema, type Me } from '@/lib/types';
import {
  ApiReadError,
  collectRunTranscripts,
  consumeThreadStream,
  conversationHref,
  mergeThreadEvents,
  readEnvelope,
  readHistoryEventPage,
  readRun,
  ResumeRequestSchema,
  runPath,
  type ResumeRequest,
} from '@/lib/conversation-run';
import { taskExecution, taskSendEligibility, type TaskIntent } from './task-model';
import type { RunTranscript } from '@/lib/conversation-run';
import { isSameReadingPage, watchHistoryNavigation } from '@/lib/stream-navigation';

type AmbiguousProposal = z.infer<typeof AmbiguousTimeDetailsSchema> & { raw_text: string };
type Identity = { conversationId: string; runId: string };

export interface ConversationTask {
  input: string;
  setInput: (value: string) => void;
  intent: TaskIntent | null;
  setIntent: (value: TaskIntent) => void;
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  setWorkspaceId: (value: string) => void;
  workspaceState: 'loading' | 'ready' | 'error';
  workspaceError: string | null;
  readWorkspaces: () => Promise<void>;
  events: ThreadEvent[];
  original: string;
  run: RunView | null;
  selected: Identity | null;
  error: string | null;
  readError: string | null;
  busy: boolean;
  reading: boolean;
  stopping: boolean;
  streaming: boolean;
  retryResume: ResumeRequest | null;
  sendUncertain: boolean;
  ambiguousProposal: AmbiguousProposal | null;
  foldChoice: 'first' | 'second' | '';
  setFoldChoice: (value: 'first' | 'second' | '') => void;
  eligibility: { allowed: boolean; reason: string | null };
  active: boolean;
  effectsUnknown: boolean;
  observeEffect: (approvalId: string, unknown: boolean) => void;
  transcript: Map<string, RunTranscript>;
  send: (retry?: boolean) => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: (clearError?: boolean) => Promise<void>;
  leaving: boolean;
  setLeaving: (value: boolean) => void;
  leave: () => void;
}

export function useConversationTask({
  conversationId = null,
  runId = null,
  initialIntent = null,
  controlsOnly = false,
}: {
  conversationId?: string | null;
  runId?: string | null;
  initialIntent?: TaskIntent | null;
  controlsOnly?: boolean;
}): ConversationTask {
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<TaskIntent | null>(initialIntent);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceState, setWorkspaceState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [original, setOriginal] = useState('');
  const [run, setRun] = useState<RunView | null>(null);
  const [selected, setSelected] = useState<Identity | null>(
    conversationId && runId ? { conversationId, runId } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [retryResume, setRetryResume] = useState<ResumeRequest | null>(null);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [ambiguousProposal, setAmbiguousProposal] = useState<AmbiguousProposal | null>(null);
  const [foldChoice, setFoldChoice] = useState<'first' | 'second' | ''>('');
  const [leaving, setLeaving] = useState(false);
  const leaveAction = useRef<(() => void) | null>(null);
  const selectedRef = useRef(selected);
  const conversationRef = useRef(conversationId);
  const meRef = useRef<Me | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const streamRef = useRef<AbortController | null>(null);
  const readRef = useRef<AbortController | null>(null);
  const workspaceRef = useRef<AbortController | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const sendRef = useRef<AbortController | null>(null);
  const pendingSend = useRef<{ body: object; text: string } | null>(null);
  const cursor = useRef(0);
  const selectionVersion = useRef(0);
  const leaveAllowed = useRef(false);
  const [effectsUnknown, setEffectsUnknown] = useState(false);
  const unknownRef = useRef(false);
  const observeEffect = useCallback((_approvalId: string, unknown: boolean) => {
    if (!unknown || !mounted.current) return;
    unknownRef.current = true;
    setEffectsUnknown(true);
  }, []);

  async function loadMe(signal?: AbortSignal) {
    if (meRef.current) return meRef.current;
    const me = MeSchema.parse(
      await readEnvelope(await fetch('/api/v1/me', { cache: 'no-store', signal })),
    );
    if (mounted.current && !signal?.aborted) meRef.current = me;
    return me;
  }

  async function readWorkspaces() {
    workspaceRef.current?.abort();
    const request = new AbortController();
    workspaceRef.current = request;
    setWorkspaceState('loading');
    setWorkspaceError(null);
    try {
      const data = await readEnvelope(
        await fetch('/api/v1/workspaces', { cache: 'no-store', signal: request.signal }),
      );
      const items = z
        .object({ items: z.array(workspaceSummarySchema) })
        .strict()
        .parse(data).items;
      if (!mounted.current || request.signal.aborted) return;
      setWorkspaces(items);
      setWorkspaceState('ready');
      setWorkspaceId((id) => (items.some((item) => item.workspace_id === id) ? id : ''));
    } catch (failure) {
      if (!mounted.current || request.signal.aborted) return;
      setWorkspaceState('error');
      setWorkspaceError(failure instanceof Error ? failure.message : '资料登记读取失败。');
    }
  }

  function acceptEvent(event: ThreadEvent, text?: string) {
    if (!mounted.current) return;
    const { conversation_id: cid, run_id: rid } = event.payload;
    if (text !== undefined && event.type === 'thread.started' && !selectedRef.current) {
      selectedRef.current = { conversationId: cid, runId: rid };
      conversationRef.current = cid;
      setSelected(selectedRef.current);
      setOriginal(text);
      pendingSend.current = null;
      setSendUncertain(false);
      window.history.replaceState(null, '', conversationHref(cid, rid));
    }
    const target = selectedRef.current;
    if (!target || target.conversationId !== cid || target.runId !== rid) return;
    cursor.current = Math.max(cursor.current, event.seq);
    setEvents((current) => mergeThreadEvents(current, [event]));
    if (event.type === 'thread.failed') {
      const detail = event.payload.error;
      setError(`${detail.code}: ${detail.message}`);
      if (detail.code === 'TOOL_EFFECT_UNKNOWN') {
        unknownRef.current = true;
        setEffectsUnknown(true);
      }
      if (text !== undefined && detail.code === 'AMBIGUOUS_LOCAL_TIME' && detail.details) {
        const parsed = AmbiguousTimeDetailsSchema.safeParse(detail.details);
        if (parsed.success) {
          setAmbiguousProposal({ ...parsed.data, raw_text: text });
          setFoldChoice('');
        }
      }
    }
  }

  async function refresh(clearError = false) {
    const target = selectedRef.current;
    if (!target || !mounted.current) return;
    readRef.current?.abort();
    const request = new AbortController();
    readRef.current = request;
    const version = selectionVersion.current;
    setReading(true);
    if (clearError) setError(null);
    try {
      if (!controlsOnly) {
        for (;;) {
          const query = new URLSearchParams({
            run_id: target.runId,
            after_seq: String(cursor.current),
            limit: '200',
          });
          const page = await readHistoryEventPage(
            `/api/v1/conversations/${encodeURIComponent(target.conversationId)}?${query}`,
            target.conversationId,
            target.runId,
            cursor.current,
            request.signal,
          );
          if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
            return;
          for (const event of page.items) acceptEvent(event);
          if (page.nextCursor === null) break;
        }
      }
      const current = await readRun(target.conversationId, target.runId, request.signal);
      if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
        return;
      if (current.conversation_id !== target.conversationId || current.run_id !== target.runId)
        throw new Error('运行身份不匹配，未接纳状态。');
      setRun(current);
      setReadError(null);
      const stored = sessionStorage.getItem(`run-resume:${target.conversationId}:${target.runId}`);
      if (stored) {
        const parsed = ResumeRequestSchema.safeParse(JSON.parse(stored));
        if (parsed.success) setRetryResume(parsed.data);
      }
    } catch (failure) {
      if (mounted.current && !request.signal.aborted && version === selectionVersion.current)
        setReadError(failure instanceof Error ? failure.message : '无法读取运行状态。');
    } finally {
      if (mounted.current && !request.signal.aborted && version === selectionVersion.current)
        setReading(false);
    }
  }

  async function stream(url: string, body: object, text?: string) {
    const request = new AbortController();
    streamRef.current = request;
    const version = selectionVersion.current;
    setStreaming(true);
    let accepted = false;
    let failedEvent = false;
    let expectedEof = false;
    leaveAllowed.current = false;
    try {
      const me = await loadMe(request.signal);
      if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
        return false;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(me.csrf_token !== null ? { 'x-csrf-token': me.csrf_token } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      await consumeThreadStream(response, (event) => {
        if (mounted.current && !request.signal.aborted && version === selectionVersion.current) {
          if (event.type === 'thread.failed') failedEvent = true;
          if (
            event.type === 'approval_required' ||
            event.type === 'thread.completed' ||
            event.type === 'thread.failed' ||
            event.type === 'thread.cancelled'
          )
            expectedEof = true;
          acceptEvent(event, text);
        }
      });
      if (!request.signal.aborted && !expectedEof)
        throw new Error('执行连接提前结束，未收到终态或批准挂起事件。');
      accepted = !failedEvent;
    } catch (failure) {
      if (mounted.current && !request.signal.aborted && version === selectionVersion.current) {
        const rejected =
          failure instanceof ApiReadError && [400, 401, 403, 404, 422].includes(failure.status);
        setError(
          `${failure instanceof Error ? failure.message : '连接中断。'}${rejected ? ' 原请求未被接受；请核对输入、权限或资源后明确提交。' : ' 请读取原运行事实；连接中断不等于完成或取消。'}`,
        );
        if (text !== undefined && !selectedRef.current) {
          setSendUncertain(!rejected);
          if (rejected) pendingSend.current = null;
        }
      }
    } finally {
      if (mounted.current && version === selectionVersion.current) {
        if (streamRef.current === request) streamRef.current = null;
        setStreaming(false);
        setLeaving(false);
        leaveAction.current = null;
        // A normal suspended-approval EOF is not a cancellation receipt.
        await refresh();
      }
    }
    return accepted;
  }

  const active = busy || run?.status === 'running' || run?.status === 'suspended_approval';
  const eligibility = taskSendEligibility({
    intent,
    text: ambiguousProposal?.raw_text ?? input,
    busy: active || sendUncertain || effectsUnknown,
    workspaceState,
    workspaceId,
    workspaces,
  });

  async function send(retry = false) {
    if (
      busyRef.current ||
      unknownRef.current ||
      (!retry && !eligibility.allowed) ||
      (retry && !pendingSend.current) ||
      (ambiguousProposal && !foldChoice)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const authentication = new AbortController();
    sendRef.current = authentication;
    try {
      let pending = retry ? pendingSend.current : null;
      if (!pending) {
        if (!intent) return;
        const me = await loadMe(authentication.signal);
        if (!mounted.current || authentication.signal.aborted) return;
        const proposal = ambiguousProposal;
        const text = proposal?.raw_text ?? input;
        pending = {
          text,
          body: {
            raw_text: text,
            conversation_id: conversationRef.current ?? undefined,
            confirmed_timezone: proposal?.timezone_id ?? me.confirmed_timezone,
            fold_choice: proposal ? foldChoice : undefined,
            execution: taskExecution(intent),
            ...(intent === 'document' ? { workspace_id: workspaceId } : {}),
            idempotency_key: crypto.randomUUID(),
          },
        };
        pendingSend.current = pending;
      }
      selectionVersion.current++;
      readRef.current?.abort();
      selectedRef.current = null;
      setSelected(null);
      setRun(null);
      setReadError(null);
      setEvents([]);
      unknownRef.current = false;
      setEffectsUnknown(false);
      setReading(false);
      cursor.current = 0;
      setRetryResume(null);
      setAmbiguousProposal(null);
      setSendUncertain(false);
      const accepted = await stream('/api/v1/conversations/messages', pending.body, pending.text);
      if (mounted.current && accepted) setInput('');
    } catch (failure) {
      if (mounted.current && !authentication.signal.aborted)
        setError(failure instanceof Error ? failure.message : '发送失败，请核实身份。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function resume() {
    const target = selectedRef.current;
    if (!target || busyRef.current || stopRef.current || unknownRef.current) return;
    const version = selectionVersion.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const requestController = new AbortController();
    readRef.current?.abort();
    readRef.current = requestController;
    try {
      const current = await readRun(target.conversationId, target.runId, requestController.signal);
      if (
        !mounted.current ||
        requestController.signal.aborted ||
        version !== selectionVersion.current
      )
        return;
      if (current.conversation_id !== target.conversationId || current.run_id !== target.runId)
        throw new Error('运行身份不匹配。');
      setRun(current);
      let request = retryResume;
      if (current.can_resume && current.waiting) {
        if (request?.checkpoint_id !== current.waiting.checkpoint_id)
          request = {
            checkpoint_id: current.waiting.checkpoint_id,
            idempotency_key: crypto.randomUUID(),
          };
      } else if (!request || !['running', 'suspended_approval'].includes(current.status)) {
        setError('当前不可继续，请读取最新状态。此资格值不表示尚未批准。');
        return;
      }
      if (!request) return;
      sessionStorage.setItem(
        `run-resume:${target.conversationId}:${target.runId}`,
        JSON.stringify(request),
      );
      setRetryResume(request);
      await stream(`${runPath(target.conversationId, target.runId)}/actions/resume`, request);
    } catch (failure) {
      if (
        mounted.current &&
        !requestController.signal.aborted &&
        version === selectionVersion.current
      )
        setError(failure instanceof Error ? failure.message : '继续结果待确认，请读取原运行。');
    } finally {
      busyRef.current = false;
      if (mounted.current && version === selectionVersion.current) setBusy(false);
    }
  }

  async function stop() {
    const target = selectedRef.current;
    if (!target || stopRef.current) return;
    stopRef.current = true;
    setStopping(true);
    setError(null);
    const version = selectionVersion.current;
    const request = new AbortController();
    cancelRef.current = request;
    try {
      const me = await loadMe(request.signal);
      if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
        return;
      const storageKey = `run-cancel:${target.conversationId}:${target.runId}`;
      const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
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
            signal: request.signal,
          }),
        ),
      );
      if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
        return;
      if (cancelled.conversation_id !== target.conversationId || cancelled.run_id !== target.runId)
        throw new Error('停止回执身份不匹配。');
      setRun(cancelled);
      // Abort only after the server accepts cancellation, never as a fake receipt.
      streamRef.current?.abort();
      await refresh();
    } catch (failure) {
      if (mounted.current && !request.signal.aborted && version === selectionVersion.current)
        setError(
          `${failure instanceof Error ? failure.message : '停止响应丢失。'} 停止结果待确认，请读取原运行。`,
        );
    } finally {
      stopRef.current = false;
      if (mounted.current && version === selectionVersion.current) setStopping(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!controlsOnly) void readWorkspaces();
    void refresh();
    return () => {
      mounted.current = false;
      selectionVersion.current++;
      streamRef.current?.abort();
      readRef.current?.abort();
      workspaceRef.current?.abort();
      cancelRef.current?.abort();
      sendRef.current?.abort();
      meRef.current = null;
    };
    // Each mounted instance owns one URL identity; route parents key it accordingly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!streaming) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (leaveAllowed.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (isSameReadingPage(destination.href, location.href)) return;
      event.preventDefault();
      event.stopPropagation();
      leaveAction.current = () => window.location.assign(destination.href);
      setLeaving(true);
    };
    const unwatchHistory = watchHistoryNavigation((action) => {
      leaveAction.current = action;
      setLeaving(true);
    });
    document.addEventListener('click', click, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      document.removeEventListener('click', click, true);
      window.removeEventListener('beforeunload', unload);
      unwatchHistory();
    };
  }, [streaming]);

  const transcript = useMemo(() => collectRunTranscripts(events), [events]);
  return {
    input,
    setInput: (text) => {
      setInput(text);
      setAmbiguousProposal(null);
      setFoldChoice('');
    },
    intent,
    setIntent: (next) => {
      setIntent(next);
      setAmbiguousProposal(null);
      setFoldChoice('');
    },
    workspaces,
    workspaceId,
    setWorkspaceId,
    workspaceState,
    workspaceError,
    readWorkspaces,
    events,
    original,
    run,
    selected,
    error,
    readError,
    busy,
    reading,
    stopping,
    streaming,
    retryResume,
    sendUncertain,
    ambiguousProposal,
    foldChoice,
    setFoldChoice,
    eligibility,
    active,
    effectsUnknown,
    observeEffect,
    transcript,
    send,
    resume,
    stop,
    refresh,
    leaving,
    setLeaving,
    leave: () => {
      leaveAllowed.current = true;
      streamRef.current?.abort();
      setLeaving(false);
      leaveAction.current?.();
    },
  };
}
