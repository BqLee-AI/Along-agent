'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
  DocumentApprovalDetailSchema,
  type ApprovalDetail,
  type ConversationRunHistoryItem,
  type MessageHistoryItem,
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
  readHistoryCollectionPage,
  readHistoryEventPage,
  readRun,
  ResumeRequestSchema,
  runPath,
  type ResumeRequest,
} from '@/lib/conversation-run';
import {
  conversationSendBlocked,
  clarificationReplyReference,
  taskAdmission,
  taskSendEligibility,
  type TaskIntent,
} from './task-model';
import type { RunTranscript } from '@/lib/conversation-run';
import { isSameReadingPage, watchHistoryNavigation } from '@/lib/stream-navigation';
import { confirmInlineReminder, inlineReminderWaiting } from './inline-reminder';

type AmbiguousProposal = z.infer<typeof AmbiguousTimeDetailsSchema> & {
  raw_text: string;
  source_run_id: string;
};
type Identity = { conversationId: string; runId: string };
const PendingSendSchema = z.object({ text: z.string(), body: z.record(z.unknown()) }).strict();

export interface ConversationTask {
  input: string;
  setInput: (value: string) => void;
  intent: TaskIntent;
  setIntent: (value: TaskIntent) => void;
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  setWorkspaceId: (value: string) => void;
  workspaceState: 'loading' | 'ready' | 'error';
  workspaceError: string | null;
  readWorkspaces: () => Promise<void>;
  events: ThreadEvent[];
  messages: MessageHistoryItem[];
  runs: ConversationRunHistoryItem[];
  liveReply: boolean;
  liveOriginal: string | null;
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
  clarificationReply: boolean;
  setClarificationReply: (value: boolean) => void;
  canReplyToClarification: boolean;
  setFoldChoice: (value: 'first' | 'second' | '') => void;
  eligibility: { allowed: boolean; reason: string | null };
  active: boolean;
  effectsUnknown: boolean;
  observeEffect: (approvalId: string, unknown: boolean) => void;
  transcript: Map<string, RunTranscript>;
  send: (retry?: boolean) => Promise<void>;
  reminderResults: Record<string, ApprovalDetail>;
  reminderError: { approvalId: string; message: string } | null;
  confirmReminder: (detail: ApprovalDetail) => Promise<void>;
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
  initialIntent = 'chat',
}: {
  conversationId?: string | null;
  runId?: string | null;
  initialIntent?: TaskIntent | null;
}): ConversationTask {
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<TaskIntent>(initialIntent ?? 'chat');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceState, setWorkspaceState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [messages, setMessages] = useState<MessageHistoryItem[]>([]);
  const [runs, setRuns] = useState<ConversationRunHistoryItem[]>([]);
  const [historyReady, setHistoryReady] = useState(!conversationId);
  const [liveReply, setLiveReply] = useState(false);
  const [liveOriginal, setLiveOriginal] = useState<string | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [selected, setSelected] = useState<Identity | null>(
    conversationId && runId ? { conversationId, runId } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(Boolean(conversationId));
  const [stopping, setStopping] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [retryResume, setRetryResume] = useState<ResumeRequest | null>(null);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [ambiguousProposal, setAmbiguousProposal] = useState<AmbiguousProposal | null>(null);
  const [foldChoice, setFoldChoice] = useState<'first' | 'second' | ''>('');
  const [clarificationReply, setClarificationReply] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reminderResults, setReminderResults] = useState<Record<string, ApprovalDetail>>({});
  const [reminderError, setReminderError] = useState<ConversationTask['reminderError']>(null);
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
  const reminderController = useRef<AbortController | null>(null);
  const pendingSend = useRef<z.infer<typeof PendingSendSchema> | null>(null);
  const pendingStorage = useRef<string | null>(null);
  const cursors = useRef(new Map<string, number>());
  const eventsRef = useRef<ThreadEvent[]>([]);
  const selectionVersion = useRef(0);
  useEffect(() => {
    setClarificationReply(false);
  }, [run?.run_id, intent]);
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
    if (conversationRef.current && conversationRef.current !== cid)
      throw new Error('发送回执与原会话不匹配，未接纳新运行。');
    if (text !== undefined && event.type === 'thread.started' && !selectedRef.current) {
      selectedRef.current = { conversationId: cid, runId: rid };
      conversationRef.current = cid;
      setSelected(selectedRef.current);
      pendingSend.current = null;
      if (pendingStorage.current) sessionStorage.removeItem(pendingStorage.current);
      pendingStorage.current = null;
      setSendUncertain(false);
      window.history.replaceState(window.history.state, '', conversationHref(cid, rid));
    }
    if (conversationRef.current !== cid) return;
    cursors.current.set(rid, Math.max(cursors.current.get(rid) ?? 0, event.seq));
    eventsRef.current = mergeThreadEvents(eventsRef.current, [event]);
    setEvents(eventsRef.current);
    if (
      event.protocol_version === 'v2' &&
      (event.type === 'thread.completed' ||
        event.type === 'thread.failed' ||
        event.type === 'thread.cancelled') &&
      event.payload.goal_result?.status === 'unknown'
    ) {
      unknownRef.current = true;
      setEffectsUnknown(true);
    }
    if (event.type === 'thread.failed') {
      const detail = event.payload.error;
      if (detail.code === 'TOOL_EFFECT_UNKNOWN') {
        unknownRef.current = true;
        setEffectsUnknown(true);
      }
      if (selectedRef.current?.runId !== rid) return;
      setError(`${detail.code}: ${detail.message}`);
      if (text !== undefined && detail.code === 'AMBIGUOUS_LOCAL_TIME' && detail.details) {
        const parsed = AmbiguousTimeDetailsSchema.safeParse(detail.details);
        if (parsed.success) {
          setAmbiguousProposal({ ...parsed.data, raw_text: text, source_run_id: rid });
          setFoldChoice('');
        }
      }
    }
  }

  async function refresh(clearError = false) {
    const cid = conversationRef.current;
    if (!cid || !mounted.current) return;
    readRef.current?.abort();
    const request = new AbortController();
    readRef.current = request;
    const version = selectionVersion.current;
    const valid = () =>
      mounted.current && !request.signal.aborted && version === selectionVersion.current;
    setReading(true);
    if (clearError) setError(null);
    try {
      const history: ConversationRunHistoryItem[] = [];
      let next: string | null = null;
      do {
        const query = new URLSearchParams({ limit: '50' });
        if (next !== null) query.set('cursor', next);
        const page = await readHistoryCollectionPage(
          `/api/v1/conversations/${encodeURIComponent(cid)}/runs?${query}`,
          ConversationRunPageSchema,
          request.signal,
        );
        if (!valid()) return;
        if (page.items.some((item) => item.conversation_id !== cid))
          throw new Error('运行列表会话归属不匹配，未接纳此页。');
        history.push(...page.items);
        next = page.next_cursor;
      } while (next !== null);
      let target = selectedRef.current;
      if (!target && history.length && !pendingSend.current) {
        target = { conversationId: cid, runId: history[history.length - 1]!.run_id };
        selectedRef.current = target;
        setSelected(target);
      }
      // Read every indexed Run: a selected completed Run cannot bypass another
      // suspended Run or an unknown document effect in this conversation.
      for (const item of history) {
        let after = cursors.current.get(item.run_id) ?? 0;
        for (;;) {
          const query = new URLSearchParams({
            run_id: item.run_id,
            after_seq: String(after),
            limit: '200',
          });
          const page = await readHistoryEventPage(
            `/api/v1/conversations/${encodeURIComponent(cid)}?${query}`,
            cid,
            item.run_id,
            after,
            request.signal,
          );
          if (!valid()) return;
          for (const event of page.items) acceptEvent(event);
          if (page.nextCursor === null) break;
          after = Number(page.nextCursor);
        }
      }
      const transcripts = collectRunTranscripts(eventsRef.current);
      for (const [rid, transcript] of transcripts) {
        for (const approval of transcript.approvals) {
          if (approval.kind !== 'document') continue;
          const detail = DocumentApprovalDetailSchema.parse(
            await readEnvelope(
              await fetch(`/api/v1/document-approvals/${encodeURIComponent(approval.approvalId)}`, {
                cache: 'no-store',
                signal: request.signal,
              }),
            ),
          );
          if (!valid()) return;
          if (
            detail.approval_id !== approval.approvalId ||
            detail.conversation_id !== cid ||
            detail.run_id !== rid
          )
            throw new Error('文档效果与原运行不匹配，不能确认发送资格。');
          if (detail.effect.status === 'unknown') {
            unknownRef.current = true;
            setEffectsUnknown(true);
          }
        }
      }
      let replyPending = false;
      if (target) {
        const current = await readRun(cid, target.runId, request.signal);
        if (!valid()) return;
        if (current.conversation_id !== cid || current.run_id !== target.runId)
          throw new Error('运行身份不匹配，未接纳状态。');
        setRun(current);
        if (current.goal_result?.status === 'unknown') {
          unknownRef.current = true;
          setEffectsUnknown(true);
        }
        replyPending = current.status === 'running' || current.status === 'suspended_approval';
        const indexed = history.find((item) => item.run_id === current.run_id);
        if (
          current.authorization_revision === 'delegation/1' &&
          ['blocked', 'partial'].includes(current.goal_result?.status ?? '') &&
          current.goal_result?.clarification?.kind === 'time' &&
          indexed?.original.state === 'available'
        ) {
          const ambiguities = new Map(
            (current.reminder_time_errors ?? [])
              .filter((item) => item.error.code === 'AMBIGUOUS_LOCAL_TIME')
              .map((item) => [JSON.stringify(item.error.details), item.error.details]),
          );
          if (ambiguities.size === 1) {
            const details = AmbiguousTimeDetailsSchema.safeParse(ambiguities.values().next().value);
            if (details.success)
              setAmbiguousProposal({
                ...details.data,
                raw_text: indexed.original.message.content,
                source_run_id: current.run_id,
              });
          }
        }
        if (indexed) indexed.status = current.status;
        const stored = sessionStorage.getItem(`run-resume:${cid}:${target.runId}`);
        if (stored) {
          const parsed = ResumeRequestSchema.safeParse(JSON.parse(stored));
          if (parsed.success) setRetryResume(parsed.data);
        }
      }
      // Suspended attempts have accepted deltas but no archived assistant yet.
      // Only a terminal archive replaces that cumulative run transcript.
      if (!streamRef.current) {
        const archive: MessageHistoryItem[] = [];
        next = null;
        do {
          const query = new URLSearchParams({ limit: '50' });
          if (next !== null) query.set('cursor', next);
          const page = await readHistoryCollectionPage(
            `/api/v1/conversations/${encodeURIComponent(cid)}/messages?${query}`,
            ConversationMessagePageSchema,
            request.signal,
          );
          if (!valid()) return;
          archive.push(...page.items);
          next = page.next_cursor;
        } while (next !== null);
        setMessages(archive);
        setLiveReply(Boolean(replyPending && target && transcripts.get(target.runId)?.text));
        setLiveOriginal(null);
      }
      setRuns(history);
      setHistoryReady(true);
      setReadError(null);
    } catch (failure) {
      if (valid())
        setReadError(failure instanceof Error ? failure.message : '无法读取会话与运行状态。');
    } finally {
      if (valid()) setReading(false);
    }
  }

  async function stream(url: string, body: object, text?: string) {
    const request = new AbortController();
    streamRef.current = request;
    const version = selectionVersion.current;
    setStreaming(true);
    setLiveReply(true);
    setLiveOriginal(text ?? null);
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
          if (rejected) {
            pendingSend.current = null;
            if (pendingStorage.current) sessionStorage.removeItem(pendingStorage.current);
            pendingStorage.current = null;
            setLiveReply(false);
            setLiveOriginal(null);
          }
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

  const active = conversationSendBlocked({
    busy: busy || stopping,
    reading,
    readError,
    ready: historyReady,
    selected: Boolean(selected),
    run,
    runs,
    sendUncertain,
    effectsUnknown,
  });
  const eligibility = taskSendEligibility({
    intent,
    text: ambiguousProposal?.raw_text ?? input,
    busy: active,
    workspaceState,
    workspaceId,
    workspaces,
  });
  const canReplyToClarification = Boolean(clarificationReplyReference(run, intent, true));

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
        const me = await loadMe(authentication.signal);
        if (!mounted.current || authentication.signal.aborted) return;
        const proposal = ambiguousProposal;
        const text = proposal?.raw_text ?? input;
        pending = {
          text,
          body: {
            raw_text: text,
            conversation_id: conversationRef.current ?? undefined,
            confirmed_timezone:
              proposal?.timezone_id ?? (intent === 'chat' ? undefined : me.confirmed_timezone),
            fold_choice: proposal ? foldChoice : undefined,
            clarification_of_run_id:
              proposal?.source_run_id ??
              (clarificationReply && canReplyToClarification ? run?.run_id : undefined),
            ...taskAdmission(intent),
            ...(intent === 'document' ? { workspace_id: workspaceId } : {}),
            idempotency_key: crypto.randomUUID(),
          },
        };
        pendingSend.current = pending;
      }
      const storageKey =
        pendingStorage.current ?? `conversation-send:${conversationRef.current ?? 'new'}`;
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
      pendingStorage.current = storageKey;
      selectionVersion.current++;
      readRef.current?.abort();
      selectedRef.current = null;
      setSelected(null);
      setRun(null);
      setReadError(null);
      setReading(false);
      setRetryResume(null);
      setAmbiguousProposal(null);
      setSendUncertain(false);
      setClarificationReply(false);
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

  async function resume(expected?: { target: Identity; checkpointId: string; approvalId: string }) {
    const target = selectedRef.current;
    if (!target || busyRef.current || stopRef.current || unknownRef.current) return;
    if (
      expected &&
      (target.conversationId !== expected.target.conversationId ||
        target.runId !== expected.target.runId)
    )
      return;
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
      if (
        expected &&
        (!inlineReminderWaiting(current, expected.approvalId) ||
          current.waiting?.checkpoint_id !== expected.checkpointId)
      ) {
        await refresh();
        return;
      }
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

  async function confirmReminder(detail: ApprovalDetail) {
    const target = selectedRef.current;
    const waiting = run?.waiting;
    if (
      !target ||
      !waiting ||
      !inlineReminderWaiting(run, detail.approval_id) ||
      busyRef.current ||
      stopRef.current ||
      unknownRef.current ||
      streamRef.current
    )
      return;
    const version = selectionVersion.current;
    const controller = new AbortController();
    reminderController.current = controller;
    busyRef.current = true;
    setBusy(true);
    setReminderError(null);
    let confirmed = false;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      version === selectionVersion.current &&
      !stopRef.current;
    try {
      const current = await readRun(target.conversationId, target.runId, controller.signal);
      if (!valid()) return;
      if (
        current.conversation_id !== target.conversationId ||
        current.run_id !== target.runId ||
        !inlineReminderWaiting(current, detail.approval_id) ||
        current.waiting?.checkpoint_id !== waiting.checkpoint_id
      )
        throw new Error('原提醒等待点已改变；未提交确认，请读取最新状态。');
      const me = await loadMe(controller.signal);
      if (!valid()) return;
      const approved = await confirmInlineReminder({
        initial: detail,
        run: current,
        csrf: me.csrf_token,
        signal: controller.signal,
      });
      if (!valid()) return;
      setReminderResults((previous) => ({ ...previous, [detail.approval_id]: approved }));
      confirmed = true;
    } catch (failure) {
      if (valid())
        setReminderError({
          approvalId: detail.approval_id,
          message: `${failure instanceof Error ? failure.message : '确认结果尚未核验。'} 先读取原提议；重试只核对原请求，不换键、不重新创建。`,
        });
    } finally {
      if (reminderController.current === controller) reminderController.current = null;
      busyRef.current = false;
      if (mounted.current && version === selectionVersion.current) setBusy(false);
    }
    // Only this still-active click can continue this exact reminder checkpoint.
    // The existing resume path persists/reuses its own idempotency key.
    if (confirmed && valid())
      await resume({
        target,
        checkpointId: waiting.checkpoint_id,
        approvalId: detail.approval_id,
      });
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
      reminderController.current?.abort();
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
    const storageKey = `conversation-send:${conversationId ?? 'new'}`;
    const stored = sessionStorage.getItem(storageKey);
    if (stored) {
      setSendUncertain(true);
      pendingStorage.current = storageKey;
      try {
        const pending = PendingSendSchema.parse(JSON.parse(stored));
        if (pending.body.conversation_id !== (conversationId ?? undefined))
          throw new Error('原发送的会话身份不匹配。');
        pendingSend.current = pending;
        setInput(pending.text);
      } catch (failure) {
        setError(
          `原发送结果未知，不能创建另一条消息。${failure instanceof Error ? failure.message : '原请求记录无法读取。'}`,
        );
      }
    }
    void refresh();
    return () => {
      mounted.current = false;
      selectionVersion.current++;
      streamRef.current?.abort();
      readRef.current?.abort();
      workspaceRef.current?.abort();
      cancelRef.current?.abort();
      sendRef.current?.abort();
      reminderController.current?.abort();
      meRef.current = null;
    };
    // Each mounted instance owns one URL identity; route parents key it accordingly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (intent === 'document' && !workspaceRef.current) void readWorkspaces();
    // Workspace registration is only a prerequisite of the explicit document shortcut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

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
    messages,
    runs,
    liveReply,
    liveOriginal,
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
    clarificationReply,
    setClarificationReply,
    canReplyToClarification,
    setFoldChoice,
    eligibility,
    active,
    effectsUnknown,
    observeEffect,
    transcript,
    send,
    reminderResults,
    reminderError,
    confirmReminder,
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
