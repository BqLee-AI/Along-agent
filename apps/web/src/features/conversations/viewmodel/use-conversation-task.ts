'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
  DocumentApprovalDetailSchema,
  RunViewSchema,
} from '@along/contracts';
import type {
  ApprovalDetail,
  DocumentApprovalDetail,
  ConversationRunHistoryItem,
  MessageHistoryItem,
  RunView,
  WorkspaceSummary,
} from '@along/contracts';
import { AmbiguousTimeDetailsSchema } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import { z } from 'zod';
import { MeSchema } from '@/shared/session/identity';
import type { Me } from '@/shared/session/identity';
import type { ModelSelection, ProviderView } from '@along/contracts';
import { ApiReadError, readEnvelope } from '@/shared/http/client';
import { api, writeOptions } from '@/shared/http/eden';
import { readHistoryCollectionPage } from '@/shared/http/page';
import {
  collectRunTranscripts,
  consumeThreadStream,
  mergeThreadEvents,
  readHistoryEventPage,
  readRun,
  ResumeRequestSchema,
  runPath,
  requestUserPause,
  userPauseCanContinue,
  postRunStream,
  CompactRequestSchema,
  postCompact,
  readCompact,
  compactIsFinal,
  compactRetryEligible,
  handoffCompactStreams,
} from '@/features/conversations/model/conversation-run';
import type {
  CompactReceipt,
  CompactRequest,
  ResumeRequest,
} from '@/features/conversations/model/conversation-run';
import {
  conversationSendBlocked,
  clarificationReplyReference,
  selectResumeRequest,
  compactCommand,
  taskAdmission,
  taskSendEligibility,
} from '@/features/conversations/model/task';
import type { TaskIntent } from '@/features/conversations/model/task';
import type { RunTranscript } from '@/features/conversations/model/conversation-run';
import {
  confirmInlineReminder,
  inlineReminderWaiting,
} from '@/features/approvals/model/inline-reminder';
import {
  confirmInlineDocument,
  inlineDocumentWaiting,
} from '@/features/approvals/model/inline-document';
import { useConversationApprovalResults } from '@/features/approvals/viewmodel/use-conversation-approval-results';
import { useModelCatalog } from '@/features/model-settings/viewmodel/model-catalog-context';
import { useConversationComposer } from './use-conversation-composer';
import { useOfficeMaterials, type OfficeDraft } from './use-office-materials';
import type { OfficeSession } from '../model/office-materials';
import { useConversationNavigationGuard } from './use-conversation-navigation-guard';
import { useWorkspaceRegistration } from './use-workspace-registration';
import { useConversationFollow } from './use-conversation-follow';

type AmbiguousProposal = z.infer<typeof AmbiguousTimeDetailsSchema> & {
  raw_text: string;
  source_run_id: string;
};
type Identity = { conversationId: string; runId: string };
const PendingSendSchema = z
  .object({
    text: z.string(),
    body: z.record(z.unknown()),
    officeOwnerId: z.string().uuid().optional(),
  })
  .strict();

export interface ConversationTask {
  input: string;
  setInput: (value: string) => void;
  intent: TaskIntent;
  setIntent: (value: TaskIntent) => void;
  office?: OfficeDraft;
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  setWorkspaceId: (value: string) => void;
  workspaceState: 'loading' | 'ready' | 'error';
  workspaceError: string | null;
  readWorkspaces: () => Promise<void>;
  modelProviders: ProviderView[];
  defaultSelection: ModelSelection | null;
  modelSelection: ModelSelection | null;
  setModelSelection: (value: ModelSelection | null) => void;
  modelState: 'loading' | 'ready' | 'error';
  modelError: string | null;
  readModels: () => Promise<void>;
  events: ThreadEvent[];
  messages: MessageHistoryItem[];
  runs: ConversationRunHistoryItem[];
  officeHistoryReadError?: boolean;
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
  documentResults: Record<string, DocumentApprovalDetail>;
  documentError: { approvalId: string; message: string } | null;
  confirmDocument: (detail: DocumentApprovalDetail) => Promise<void>;
  resume: () => Promise<void>;
  pause: () => Promise<void>;
  continuePaused: () => Promise<void>;
  pauseBusy: boolean;
  compactStatus: {
    phase: 'submitting' | 'waiting' | 'uncertain' | 'read_error' | 'done';
    receipt: CompactReceipt | null;
    message: string | null;
  } | null;
  compactBusy: boolean;
  compactAvailable: boolean;
  retryCompact: () => Promise<void>;
  compactRetryAllowed: boolean;
  refreshCompact: () => void;
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
  officeSession,
}: {
  conversationId?: string | null;
  runId?: string | null;
  initialIntent?: TaskIntent | null;
  officeSession?: OfficeSession;
}): ConversationTask {
  const {
    input,
    setInput,
    intent,
    setIntent,
    workspaceId,
    setWorkspaceId,
    modelSelection,
    setModelSelection,
  } = useConversationComposer(initialIntent);
  const office = useOfficeMaterials({
    session: intent === 'office' ? officeSession : undefined,
    conversationId,
    runId,
  });
  const { workspaces, workspaceState, workspaceError, readWorkspaces } = useWorkspaceRegistration(
    intent,
    setWorkspaceId,
  );
  const {
    snapshot: modelCatalog,
    state: modelState,
    error: modelError,
    refresh: readModels,
  } = useModelCatalog();
  const modelProviders = modelCatalog.items;
  const defaultSelection = modelCatalog.default_selection;
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [messages, setMessages] = useState<MessageHistoryItem[]>([]);
  const [runs, setRuns] = useState<ConversationRunHistoryItem[]>([]);
  const [officeHistoryReadError, setOfficeHistoryReadError] = useState(false);
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
  const [pauseBusy, setPauseBusy] = useState(false);
  const [compactStatus, setCompactStatus] = useState<ConversationTask['compactStatus']>(null);
  const [compactGeneration, setCompactGeneration] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [retryResume, setRetryResume] = useState<ResumeRequest | null>(null);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [ambiguousProposal, setAmbiguousProposal] = useState<AmbiguousProposal | null>(null);
  const [foldChoice, setFoldChoice] = useState<'first' | 'second' | ''>('');
  const [clarificationReply, setClarificationReply] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const {
    reminderResults,
    setReminderResults,
    reminderError,
    setReminderError,
    documentResults,
    setDocumentResults,
    documentError,
    setDocumentError,
    resetApprovalResults,
  } = useConversationApprovalResults();
  const leaveAction = useRef<(() => void) | null>(null);
  const selectedRef = useRef(selected);
  const conversationRef = useRef(conversationId);
  const meRef = useRef<Me | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const pauseActionRef = useRef(false);
  const pauseController = useRef<AbortController | null>(null);
  const compactRequest = useRef<CompactRequest | null>(null);
  const compactController = useRef<AbortController | null>(null);
  const compactLock = useRef(false);
  const streamRef = useRef<AbortController | null>(null);
  const followRef = useRef<AbortController | null>(null);
  const followed = useRef<string | null>(null);
  const [followGeneration, setFollowGeneration] = useState(0);
  const readRef = useRef<AbortController | null>(null);
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
    const me = MeSchema.parse(await readEnvelope(await api.api.v1.me.get({ fetch: { signal } })));
    if (mounted.current && !signal?.aborted) meRef.current = me;
    return me;
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
      if (pendingSend.current?.body.office_materials) {
        office.reset();
        setIntent('chat');
      }
      pendingSend.current = null;
      if (pendingStorage.current) sessionStorage.removeItem(pendingStorage.current);
      pendingStorage.current = null;
      setSendUncertain(false);
      const destination = new URL(window.location.href);
      destination.searchParams.set('conversation_id', cid);
      destination.searchParams.set('run_id', rid);
      // Passing Next's internal history state would skip its URL-state synchronization.
      window.history.replaceState(null, '', destination);
      const version = selectionVersion.current;
      void readRun(cid, rid)
        .then((current) => {
          if (
            mounted.current &&
            version === selectionVersion.current &&
            current.conversation_id === cid &&
            current.run_id === rid
          )
            setRun(current);
        })
        .catch(() => {
          if (mounted.current && version === selectionVersion.current)
            setReadError('运行状态读取失败，请重新读取会话。');
        });
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
    const history: ConversationRunHistoryItem[] = [];
    let historyLoaded = false;
    const archiveRead = streamRef.current ? null : readArchive(cid);
    async function readArchive(conversation: string) {
      const items: MessageHistoryItem[] = [];
      try {
        let next: string | null = null;
        do {
          const query: { limit: string; cursor?: string } = {
            limit: '50',
            ...(next !== null ? { cursor: next } : {}),
          };
          const page = await readHistoryCollectionPage(
            api.api.v1
              .conversations({ id: encodeURIComponent(conversation) })
              .messages.get({ query, fetch: { signal: request.signal } }),
            ConversationMessagePageSchema,
          );
          if (!valid()) return null;
          items.push(...page.items);
          next = page.next_cursor;
        } while (next !== null);
        setMessages(items);
        return { items, error: null };
      } catch (failure) {
        if (valid() && items.length) {
          const readIds = new Set(items.map((item) => item.message_id));
          setMessages((known) => [
            ...items,
            ...known.filter((item) => !readIds.has(item.message_id)),
          ]);
        }
        return {
          items,
          error: failure instanceof Error ? failure.message : '无法完整读取会话消息。',
        };
      }
    }
    try {
      let next: string | null = null;
      do {
        const query: { limit: string; cursor?: string } = {
          limit: '50',
          ...(next !== null ? { cursor: next } : {}),
        };
        const page = await readHistoryCollectionPage(
          api.api.v1
            .conversations({ id: encodeURIComponent(cid) })
            .runs.get({ query, fetch: { signal: request.signal } }),
          ConversationRunPageSchema,
        );
        if (!valid()) return;
        if (page.items.some((item) => item.conversation_id !== cid))
          throw new Error('运行列表会话归属不匹配，未接纳此页。');
        history.push(...page.items);
        next = page.next_cursor;
      } while (next !== null);
      // Keep independently verified file results even if a later event read fails.
      setRuns(history);
      historyLoaded = true;
      setOfficeHistoryReadError(false);
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
          const page = await readHistoryEventPage(cid, item.run_id, after, request.signal);
          if (!valid()) return;
          for (const event of page.items) acceptEvent(event);
          if (page.nextCursor === null) break;
          after = Number(page.nextCursor);
        }
        if (item.run_id !== target?.runId) {
          const historical = await readRun(cid, item.run_id, request.signal);
          if (!valid()) return;
          if (historical.conversation_id !== cid || historical.run_id !== item.run_id)
            throw new Error('历史运行身份不匹配，不能确认发送资格。');
          if (historical.document_effects?.some((effect) => effect.status === 'unknown')) {
            unknownRef.current = true;
            setEffectsUnknown(true);
          }
        }
      }
      const transcripts = collectRunTranscripts(eventsRef.current);
      for (const [rid, transcript] of transcripts) {
        for (const approval of transcript.approvals) {
          if (approval.kind !== 'document') continue;
          const detail = DocumentApprovalDetailSchema.parse(
            await readEnvelope(
              await api.api.v1['document-approvals']({
                id: encodeURIComponent(approval.approvalId),
              }).get({ fetch: { signal: request.signal } }),
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
        if (
          current.goal_result?.status === 'unknown' ||
          current.document_effects?.some((effect) => effect.status === 'unknown')
        ) {
          unknownRef.current = true;
          setEffectsUnknown(true);
        }
        replyPending =
          current.status === 'running' ||
          current.status === 'suspended_approval' ||
          current.status === 'paused' ||
          (current.authorization_revision === 'delegation/1' &&
            (current.status === 'done' || current.status === 'cancelled') &&
            current.goal_result === null);
        const indexed = history.find((item) => item.run_id === current.run_id);
        if (
          current.authorization_revision === 'delegation/1' &&
          ['blocked', 'partial'].includes(current.goal_result?.status ?? '') &&
          current.goal_result?.clarification?.kind === 'time' &&
          !indexed?.office_materials &&
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
        if (indexed && indexed.status !== current.status) {
          setRuns(
            history.map((item) =>
              item.run_id === current.run_id ? { ...item, status: current.status } : item,
            ),
          );
        }
        const stored = sessionStorage.getItem(`run-resume:${cid}:${target.runId}`);
        if (stored) {
          const parsed = ResumeRequestSchema.safeParse(JSON.parse(stored));
          if (parsed.success) setRetryResume(parsed.data);
        }
      }
      // Keep released deltas visible unless a visible terminal archive replaces them.
      const archive = await archiveRead;
      if (!valid()) return;
      if (archive?.error) throw new Error(archive.error);
      if (archive && !streamRef.current) {
        setLiveReply(
          Boolean(
            replyPending &&
            target &&
            transcripts.get(target.runId)?.text &&
            !archive.items.some((message) => message.source_run_id === target.runId),
          ),
        );
        setLiveOriginal(null);
      }
      setHistoryReady(true);
      setReadError(null);
    } catch (failure) {
      if (valid()) {
        if (!historyLoaded) {
          setOfficeHistoryReadError(true);
          if (history.length) {
            const readIds = new Set(history.map((item) => item.run_id));
            setRuns((known) => [...history, ...known.filter((item) => !readIds.has(item.run_id))]);
          }
        }
        setReadError(failure instanceof Error ? failure.message : '无法读取会话与运行状态。');
      }
    } finally {
      await archiveRead;
      if (valid()) setReading(false);
    }
  }

  async function stream(
    url: string,
    body: object,
    text?: string,
    idempotencyKey?: string,
    officeAdmission?: { csrfToken: string; key: string },
  ) {
    const request = new AbortController();
    followRef.current?.abort();
    followed.current = null;
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
      const csrf = officeAdmission?.csrfToken ?? (await loadMe(request.signal)).csrf_token;
      if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
        return false;
      const response = await postRunStream(
        url,
        body,
        csrf,
        request.signal,
        officeAdmission?.key ?? idempotencyKey,
      );
      if (idempotencyKey && response.ok && selectedRef.current) {
        const target = selectedRef.current;
        const current = await readRun(target.conversationId, target.runId, request.signal);
        if (current.conversation_id !== target.conversationId || current.run_id !== target.runId)
          throw new Error('运行身份不匹配。');
        if (mounted.current && version === selectionVersion.current) setRun(current);
      }
      await consumeThreadStream(response, (event) => {
        if (
          idempotencyKey &&
          selectedRef.current &&
          (event.payload.conversation_id !== selectedRef.current.conversationId ||
            event.payload.run_id !== selectedRef.current.runId)
        )
          throw new Error('继续事件与原运行不匹配。');
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
          if (officeAdmission && event.type === 'thread.started') accepted = true;
        }
      });
      if (!request.signal.aborted && !expectedEof) {
        const target = selectedRef.current;
        const current =
          target && (await readRun(target.conversationId, target.runId, request.signal));
        if (
          !current ||
          current.conversation_id !== target?.conversationId ||
          current.run_id !== target.runId ||
          current.status !== 'paused'
        )
          throw new Error('执行连接提前结束，未收到终态或挂起状态。');
      }
      accepted ||= !failedEvent;
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
    busy: busy || stopping || Boolean(compactStatus && compactStatus.phase !== 'done'),
    reading,
    readError,
    ready: historyReady,
    selected: Boolean(selected),
    run,
    runs,
    sendUncertain,
    effectsUnknown,
  });
  const baseEligibility = taskSendEligibility({
    intent,
    text: ambiguousProposal?.raw_text ?? input,
    busy: active,
    workspaceState,
    workspaceId,
    workspaces,
  });
  const officeBlockedReason =
    intent === 'office'
      ? officeSession
        ? office.blockedReason
        : '当前会话未开启上传资料处理。'
      : null;
  const eligibility =
    baseEligibility.allowed && officeBlockedReason
      ? { allowed: false, reason: officeBlockedReason }
      : baseEligibility;
  const officeSource = runs.find((item) => item.run_id === run?.run_id)?.office_materials;
  const clarificationRunId = clarificationReplyReference(run, intent, true);
  const canReplyToClarification = Boolean(
    historyReady &&
    clarificationRunId &&
    (!officeSource ||
      (officeSession &&
        !officeHistoryReadError &&
        run?.goal_result?.clarification?.kind === 'timezone' &&
        runs.at(-1)?.run_id === clarificationRunId &&
        officeSource.inputs.length > 0 &&
        officeSource.inputs.every((input) => input.status === 'available'))),
  );

  function finishCompact(request: CompactRequest, receipt: CompactReceipt) {
    if (request.runId && request.runId !== receipt.run_id)
      throw new Error('压缩回执与原运行不匹配。');
    sessionStorage.removeItem(`conversation-compact:${request.conversationId}`);
    compactRequest.current = null;
    setCompactStatus({ phase: 'done', receipt, message: null });
    if (
      handoffCompactStreams(
        request,
        receipt,
        selectedRef.current,
        streamRef.current,
        followRef.current,
      )
    ) {
      // Reconnect read-only from the persisted cursor after dropping the old attempt.
      followed.current = null;
      setFollowGeneration((generation) => generation + 1);
    }
    void refresh();
  }

  async function compact(retry = false) {
    const cid = conversationRef.current;
    if (!cid || compactLock.current || stopRef.current || unknownRef.current || sendUncertain) {
      if (!cid) setError('请先打开一个已有会话，再使用 /compact。');
      return;
    }
    if (retry && !compactRetryEligible(compactRequest.current)) return;
    if (!retry && compactRequest.current) return;
    const selectedTarget = selectedRef.current;
    const runId =
      selectedTarget && (streamRef.current || run?.status === 'running')
        ? selectedTarget.runId
        : null;
    const request = retry
      ? compactRequest.current!
      : {
          conversationId: cid,
          runId,
          key: crypto.randomUUID(),
          receipt: null,
        };
    if (request.conversationId !== cid) return;
    const storageKey = `conversation-compact:${cid}`;
    compactRequest.current = request;
    sessionStorage.setItem(storageKey, JSON.stringify(request));
    compactLock.current = true;
    const controller = new AbortController();
    compactController.current = controller;
    const version = selectionVersion.current;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      conversationRef.current === cid &&
      selectionVersion.current === version;
    setCompactStatus({ phase: 'submitting', receipt: null, message: null });
    setError(null);
    try {
      const me = await loadMe(controller.signal);
      if (!valid()) return;
      const receipt = await postCompact(request, me.csrf_token, controller.signal);
      if (!valid()) return;
      const next = { ...request, receipt };
      compactRequest.current = next;
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      if (compactIsFinal(receipt)) {
        finishCompact(request, receipt);
      } else setCompactStatus({ phase: 'waiting', receipt, message: null });
      setInput((draft) => (compactCommand(draft) === 'compact' ? '' : draft));
    } catch (failure) {
      if (!valid()) return;
      const rejected =
        failure instanceof ApiReadError && [400, 401, 403, 404, 409, 422].includes(failure.status);
      if (rejected) {
        sessionStorage.removeItem(storageKey);
        compactRequest.current = null;
      }
      setCompactStatus({
        phase: rejected ? 'done' : 'uncertain',
        receipt: null,
        message: `${failure instanceof Error ? failure.message : '压缩请求结果未知。'}${rejected ? '' : ' 原请求结果未知，请勿发起新请求。'}`,
      });
    } finally {
      if (compactController.current === controller) {
        compactController.current = null;
        compactLock.current = false;
      }
    }
  }

  async function send(retry = false) {
    const command = compactCommand(retry ? (pendingSend.current?.text ?? '') : input);
    if (command) {
      if (retry || command === 'invalid') {
        setError(' /compact 不接受参数，也不能作为普通消息重试。'.trim());
      } else {
        await compact();
      }
      return;
    }
    if (
      busyRef.current ||
      unknownRef.current ||
      (!retry && !eligibility.allowed) ||
      (retry && !pendingSend.current) ||
      (ambiguousProposal && !foldChoice)
    )
      return;
    if (!retry && clarificationReply && !canReplyToClarification) {
      setError('原澄清暂不可续办，请重新读取原运行。');
      return;
    }
    const officeContinuation =
      !retry && Boolean(officeSource && clarificationReply && clarificationRunId);
    const officeSelection = !retry && intent === 'office' ? office.submission() : null;
    if (!retry && intent === 'office' && !officeSelection) {
      setError('所选资料暂不可提交，请检查暂存状态。');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const authentication = new AbortController();
    sendRef.current = authentication;
    try {
      let pending = retry ? pendingSend.current : null;
      let officeAdmission: { csrfToken: string; key: string } | undefined;
      const newOfficeAdmission = officeSelection !== null || officeContinuation;
      const officeOwnerId = newOfficeAdmission ? officeSession?.ownerId : pending?.officeOwnerId;
      let officeActor: Me | null = null;
      if (officeOwnerId || pending?.body.office_materials) {
        const actor = MeSchema.parse(
          await readEnvelope(await api.api.v1.me.get({ fetch: { signal: authentication.signal } })),
        );
        if (!mounted.current || authentication.signal.aborted) return;
        if (officeSelection) {
          const current = office.submission();
          if (
            !current ||
            current.draft_id !== officeSelection.draft_id ||
            current.notes_attachment_id !== officeSelection.notes_attachment_id ||
            current.tasks_attachment_id !== officeSelection.tasks_attachment_id
          )
            throw new Error('原资料草稿已切换或失效，未发送。');
        }
        if (
          !actor.csrf_token ||
          actor.user.id !== officeOwnerId ||
          (newOfficeAdmission && actor.csrf_token !== officeSession?.csrfToken)
        ) {
          if (officeSelection) office.reset();
          throw new Error('当前登录与原资料请求不匹配，请核实登录后重新选择资料。');
        }
        officeActor = actor;
      }
      if (!pending) {
        const me = officeActor ?? (await loadMe(authentication.signal));
        if (!mounted.current || authentication.signal.aborted) return;
        const proposal = ambiguousProposal;
        const text = proposal?.raw_text ?? input;
        pending = {
          text,
          ...(officeOwnerId ? { officeOwnerId } : {}),
          body: {
            raw_text: text,
            conversation_id: conversationRef.current ?? undefined,
            confirmed_timezone:
              proposal?.timezone_id ?? (intent === 'chat' ? undefined : me.confirmed_timezone),
            fold_choice: proposal ? foldChoice : undefined,
            clarification_of_run_id:
              proposal?.source_run_id ??
              (clarificationReply && canReplyToClarification ? clarificationRunId : undefined),
            ...taskAdmission(intent),
            ...(intent === 'document' ? { workspace_id: workspaceId } : {}),
            ...(officeSelection ? { office_materials: officeSelection } : {}),
            ...(intent !== 'reminder' && modelSelection
              ? {
                  model_selection: {
                    provider_id: modelSelection.provider_id,
                    model_id: modelSelection.model_id,
                  },
                }
              : {}),
            idempotency_key: crypto.randomUUID(),
          },
        };
        pendingSend.current = pending;
      }
      if (officeActor?.csrf_token) {
        officeAdmission = {
          csrfToken: officeActor.csrf_token,
          key: z.string().uuid().parse(pending.body.idempotency_key),
        };
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
      const submittedText = pending.text;
      // The message is shown and persisted as pending, so the composer is free for the next draft.
      setInput((draft) => (draft === submittedText ? '' : draft));
      const accepted = await stream(
        '/api/v1/conversations/messages',
        pending.body,
        pending.text,
        undefined,
        officeAdmission,
      );
      // A request the server rejected was never sent: give the draft back instead of losing it.
      if (
        mounted.current &&
        !authentication.signal.aborted &&
        !accepted &&
        !pendingSend.current &&
        (!pending.body.office_materials || officeSession)
      ) {
        if (pending.body.office_materials) setIntent('office');
        setInput((draft) => (draft === '' ? submittedText : draft));
      }
    } catch (failure) {
      if (mounted.current && !authentication.signal.aborted)
        setError(failure instanceof Error ? failure.message : '发送失败，请核实身份。');
    } finally {
      if (sendRef.current === authentication) {
        busyRef.current = false;
        if (mounted.current && !authentication.signal.aborted) setBusy(false);
      }
    }
  }

  async function resume(expected?: {
    target: Identity;
    checkpointId: string;
    approvalId: string;
    kind?: 'document';
  }) {
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
        (!(expected.kind === 'document'
          ? inlineDocumentWaiting(current, expected.approvalId)
          : inlineReminderWaiting(current, expected.approvalId)) ||
          current.waiting?.checkpoint_id !== expected.checkpointId)
      ) {
        if (expected.kind === 'document')
          setError('授权已记录，但原等待点已变化；本次未继续，请读取最新状态。');
        await refresh(false);
        return;
      }
      if (expected?.kind === 'document' && !current.can_resume) {
        setError('授权已记录，但当前等待点不可继续；本次未继续。');
        return;
      }
      const request = selectResumeRequest(current, retryResume);
      if (!request) {
        setError('当前不可继续，请读取最新状态。此资格值不表示尚未批准。');
        return;
      }
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

  async function confirmDocument(detail: DocumentApprovalDetail) {
    const target = selectedRef.current;
    const waiting = run?.waiting;
    if (
      !target ||
      !waiting ||
      !inlineDocumentWaiting(run, detail.approval_id) ||
      target.conversationId !== detail.conversation_id ||
      target.runId !== detail.run_id ||
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
    setDocumentError(null);
    let confirmed = false;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      version === selectionVersion.current &&
      !stopRef.current &&
      !unknownRef.current;
    try {
      const current = await readRun(target.conversationId, target.runId, controller.signal);
      if (!valid()) return;
      if (
        current.conversation_id !== target.conversationId ||
        current.run_id !== target.runId ||
        !inlineDocumentWaiting(current, detail.approval_id) ||
        current.waiting?.checkpoint_id !== waiting.checkpoint_id
      )
        throw new Error('原文档等待点已改变；未提交授权。');
      const me = await loadMe(controller.signal);
      if (!valid()) return;
      const approved = await confirmInlineDocument({
        initial: detail,
        run: current,
        csrf: me.csrf_token,
        signal: controller.signal,
      });
      if (!valid()) return;
      setDocumentResults((previous) => ({ ...previous, [detail.approval_id]: approved }));
      confirmed = true;
    } catch (failure) {
      if (valid())
        setDocumentError({
          approvalId: detail.approval_id,
          message: `${failure instanceof Error ? failure.message : '授权结果尚未核验。'} 请读取原批准；重试只核对原请求，不换键。`,
        });
    } finally {
      if (reminderController.current === controller) reminderController.current = null;
      busyRef.current = false;
      if (mounted.current && version === selectionVersion.current) setBusy(false);
    }
    if (confirmed && valid())
      await resume({
        target,
        checkpointId: waiting.checkpoint_id,
        approvalId: detail.approval_id,
        kind: 'document',
      });
  }

  async function pause() {
    const target = selectedRef.current;
    if (
      !target ||
      pauseActionRef.current ||
      stopRef.current ||
      run?.status !== 'running' ||
      !run.can_pause ||
      run.pause
    )
      return;
    pauseActionRef.current = true;
    setPauseBusy(true);
    setError(null);
    const version = selectionVersion.current;
    const controller = new AbortController();
    pauseController.current = controller;
    const valid = () =>
      mounted.current && !controller.signal.aborted && version === selectionVersion.current;
    try {
      const me = await loadMe(controller.signal);
      if (!valid()) return;
      const storageKey = `run-pause:${target.conversationId}:${target.runId}:${run.attempt_id}`;
      const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      await requestUserPause(
        target.conversationId,
        target.runId,
        key,
        me.csrf_token,
        controller.signal,
      );
      if (valid()) await refresh();
    } catch (failure) {
      if (valid()) {
        setError(
          `${failure instanceof Error ? failure.message : '暂停请求失败。'} 请读取运行状态，重试使用原请求键。`,
        );
        await refresh();
      }
    } finally {
      if (pauseController.current === controller) {
        pauseController.current = null;
        pauseActionRef.current = false;
        if (mounted.current && version === selectionVersion.current) setPauseBusy(false);
      }
    }
  }

  async function continuePaused() {
    const target = selectedRef.current;
    if (
      !target ||
      busyRef.current ||
      pauseActionRef.current ||
      stopRef.current ||
      unknownRef.current ||
      streamRef.current ||
      !userPauseCanContinue(run)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const version = selectionVersion.current;
    const controller = new AbortController();
    pauseController.current = controller;
    const valid = () =>
      mounted.current && !controller.signal.aborted && version === selectionVersion.current;
    try {
      const current = await readRun(target.conversationId, target.runId, controller.signal);
      if (!valid()) return;
      if (
        current.conversation_id !== target.conversationId ||
        current.run_id !== target.runId ||
        !userPauseCanContinue(current) ||
        current.pause?.pause_id !== run?.pause?.pause_id
      )
        throw new Error('暂停点已变化或不可继续，请读取最新状态。');
      setRun(current);
      const pauseId = current.pause!.pause_id;
      const storageKey = `run-continue:${target.conversationId}:${target.runId}:${pauseId}`;
      const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      await stream(
        `${runPath(target.conversationId, target.runId)}/actions/continue`,
        { pause_id: pauseId },
        undefined,
        key,
      );
    } catch (failure) {
      if (valid())
        setError(`${failure instanceof Error ? failure.message : '继续失败。'} 请读取原运行状态。`);
    } finally {
      if (pauseController.current === controller) {
        pauseController.current = null;
        busyRef.current = false;
        if (mounted.current && version === selectionVersion.current) setBusy(false);
      }
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
          await api.api.v1
            .conversations({ id: encodeURIComponent(target.conversationId) })
            .runs({ run: encodeURIComponent(target.runId) })
            .actions.cancel.post(
              { idempotency_key: key, reason: 'user_requested' },
              writeOptions(me.csrf_token, request.signal),
            ),
        ),
      );
      if (!mounted.current || request.signal.aborted || version !== selectionVersion.current)
        return;
      if (cancelled.conversation_id !== target.conversationId || cancelled.run_id !== target.runId)
        throw new Error('停止回执身份不匹配。');
      setRun(cancelled);
      // Abort only after the server accepts cancellation, never as a fake receipt.
      pauseController.current?.abort();
      reminderController.current?.abort();
      followRef.current?.abort();
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

  function restorePendingSend(id: string | null) {
    const storageKey = `conversation-send:${id ?? 'new'}`;
    const stored = sessionStorage.getItem(storageKey);
    if (!stored) return;
    setSendUncertain(true);
    pendingStorage.current = storageKey;
    try {
      const pending = PendingSendSchema.parse(JSON.parse(stored));
      if (pending.body.conversation_id !== (id ?? undefined))
        throw new Error('原发送的会话身份不匹配。');
      pendingSend.current = pending;
      // A recovered office request needs fresh owner verification before showing its original text.
      if (!pending.officeOwnerId && !pending.body.office_materials) setInput(pending.text);
    } catch (failure) {
      setError(
        `原发送结果未知，不能创建另一条消息。${failure instanceof Error ? failure.message : '原请求记录无法读取。'}`,
      );
    }
  }

  useEffect(() => {
    mounted.current = true;
    restorePendingSend(conversationId);
    void refresh();
    return () => {
      mounted.current = false;
      selectionVersion.current++;
      streamRef.current?.abort();
      followRef.current?.abort();
      readRef.current?.abort();
      cancelRef.current?.abort();
      pauseController.current?.abort();
      sendRef.current?.abort();
      reminderController.current?.abort();
      meRef.current = null;
    };
    // The persistent pane owns the controller; URL selection changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sameConversation = conversationRef.current === conversationId;
    if (sameConversation && (!runId || selectedRef.current?.runId === runId)) {
      if (!conversationId) setIntent(initialIntent ?? 'chat');
      return;
    }
    selectionVersion.current++;
    streamRef.current?.abort();
    streamRef.current = null;
    readRef.current?.abort();
    cancelRef.current?.abort();
    pauseController.current?.abort();
    pauseActionRef.current = false;
    setPauseBusy(false);
    sendRef.current?.abort();
    reminderController.current?.abort();
    selectedRef.current = conversationId && runId ? { conversationId, runId } : null;
    conversationRef.current = conversationId;
    eventsRef.current = [];
    cursors.current.clear();
    pendingSend.current = null;
    pendingStorage.current = null;
    busyRef.current = false;
    stopRef.current = false;
    unknownRef.current = false;
    leaveAllowed.current = false;
    setSelected(selectedRef.current);
    setEvents([]);
    setMessages([]);
    setRuns([]);
    setOfficeHistoryReadError(false);
    setRun(null);
    setInput('');
    setIntent(initialIntent ?? 'chat');
    setHistoryReady(!conversationId);
    setReading(Boolean(conversationId));
    setStreaming(false);
    setBusy(false);
    setStopping(false);
    setLiveReply(false);
    setLiveOriginal(null);
    setError(null);
    setReadError(null);
    setRetryResume(null);
    setSendUncertain(false);
    setEffectsUnknown(false);
    resetApprovalResults();
    setAmbiguousProposal(null);
    setFoldChoice('');
    setLeaving(false);
    restorePendingSend(conversationId);
    void refresh();
    // Refs distinguish an accepted new-send URL update from an explicit selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, runId, initialIntent]);

  useEffect(() => {
    compactController.current?.abort();
    compactController.current = null;
    compactLock.current = false;
    compactRequest.current = null;
    setCompactStatus(null);
    if (!conversationId) return;
    const stored = sessionStorage.getItem(`conversation-compact:${conversationId}`);
    if (!stored) return;
    try {
      const request = CompactRequestSchema.parse(JSON.parse(stored));
      if (request.conversationId !== conversationId) throw new Error('压缩请求会话不匹配。');
      if (request.runId && request.receipt && request.runId !== request.receipt.run_id)
        throw new Error('压缩回执与原运行不匹配。');
      if (request.receipt && compactIsFinal(request.receipt)) {
        finishCompact(request, request.receipt);
      } else {
        compactRequest.current = request;
        setCompactStatus(
          request.receipt
            ? { phase: 'waiting', receipt: request.receipt, message: null }
            : { phase: 'uncertain', receipt: null, message: '原压缩请求结果未知；不会自动重试。' },
        );
      }
    } catch {
      setCompactStatus({
        phase: 'uncertain',
        receipt: null,
        message: '原压缩请求记录无法读取，不能安全重试。',
      });
    }
    return () => {
      compactController.current?.abort();
    };
  }, [conversationId, runId]);

  useEffect(() => {
    const request = compactRequest.current;
    const receipt = request?.receipt;
    if (compactStatus?.phase !== 'waiting' || !request || !receipt?.run_id || !receipt.pause_id)
      return;
    const controller = new AbortController();
    const cid = request.conversationId;
    const version = selectionVersion.current;
    let timer = 0;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      conversationRef.current === cid &&
      version === selectionVersion.current;
    const poll = async () => {
      try {
        const current = await readCompact(
          cid,
          receipt.run_id!,
          receipt.pause_id!,
          controller.signal,
        );
        if (!valid()) return;
        const next = { ...request, receipt: current };
        compactRequest.current = next;
        sessionStorage.setItem(`conversation-compact:${cid}`, JSON.stringify(next));
        if (compactIsFinal(current)) {
          finishCompact(request, current);
          return;
        }
        setCompactStatus({ phase: 'waiting', receipt: current, message: null });
        timer = window.setTimeout(() => void poll(), 1500);
      } catch (failure) {
        if (valid())
          setCompactStatus({
            phase: 'read_error',
            receipt: compactRequest.current?.receipt ?? receipt,
            message: `${failure instanceof Error ? failure.message : '读取压缩状态失败。'} 本次只读查询未继续运行。`,
          });
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // Polling is read-only and tied to the original operation identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversationId,
    runId,
    compactStatus?.phase,
    compactStatus?.receipt?.pause_id,
    compactGeneration,
  ]);

  useConversationFollow({
    selected,
    run,
    streaming,
    generation: followGeneration,
    followRef,
    followed,
    mounted,
    selectionVersion,
    cursors,
    acceptEvent,
    setLiveReply,
    setRun,
    refresh,
    setReadError,
  });

  useEffect(() => {
    if (
      !selected ||
      run?.run_id !== selected.runId ||
      (run.pause?.status !== 'pending' &&
        !(
          run.status === 'paused' &&
          run.pause?.reason === 'runtime' &&
          run.pause.purpose === 'automatic_compact'
        ))
    )
      return;
    const controller = new AbortController();
    const version = selectionVersion.current;
    const automatic = run.pause?.reason === 'runtime' && run.pause.purpose === 'automatic_compact';
    let timer = 0;
    const poll = async () => {
      try {
        const current = await readRun(selected.conversationId, selected.runId, controller.signal);
        if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current)
          return;
        if (
          current.conversation_id !== selected.conversationId ||
          current.run_id !== selected.runId
        )
          throw new Error('运行身份不匹配。');
        if (automatic && current.status === 'running' && !current.pause) {
          // Drop the old attempt's streams and reconnect read-only from the
          // persisted cursor. The accepted admission is never sent again.
          streamRef.current?.abort();
          followRef.current?.abort();
          followRef.current = null;
          followed.current = null;
          setFollowGeneration((generation) => generation + 1);
        }
        setRun(current);
        if (automatic && current.status !== 'running' && current.status !== 'paused') {
          void refresh();
          return;
        }
        if (
          current.pause?.status === 'pending' ||
          (current.status === 'paused' &&
            current.pause?.reason === 'runtime' &&
            current.pause.purpose === 'automatic_compact')
        )
          timer = window.setTimeout(() => void poll(), 1500);
        else if (!automatic) void refresh();
      } catch (failure) {
        if (mounted.current && !controller.signal.aborted && version === selectionVersion.current) {
          setReadError(failure instanceof Error ? failure.message : '暂停状态读取失败。');
          timer = window.setTimeout(() => void poll(), 1500);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    selected?.conversationId,
    selected?.runId,
    run?.run_id,
    run?.status,
    run?.pause?.status,
    run?.pause?.reason,
    run?.pause?.purpose,
  ]);

  const previousTranscript = useRef<Map<string, RunTranscript>>(new Map());
  const transcript = useMemo(() => {
    const next = collectRunTranscripts(events, { previous: previousTranscript.current });
    previousTranscript.current = next;
    return next;
  }, [events]);
  const lifecycle =
    run?.execution_lifecycle ??
    (selected ? transcript.get(selected.runId)?.execution_lifecycle : undefined);

  useConversationNavigationGuard({
    streaming,
    lifecycle,
    conversation: conversationRef,
    selected: selectedRef,
    leaveAllowed,
    leaveAction,
    setLeaving,
  });

  return {
    input,
    setInput: (text) => {
      setInput(text);
      setAmbiguousProposal(null);
      setFoldChoice('');
    },
    intent,
    ...(officeSession ? { office } : {}),
    setIntent: (next) => {
      if (next === 'office' && !officeSession) return;
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
    modelProviders,
    defaultSelection,
    modelSelection,
    setModelSelection,
    modelState,
    modelError,
    readModels,
    events,
    messages,
    runs,
    officeHistoryReadError,
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
    documentResults,
    documentError,
    confirmDocument,
    resume,
    pause,
    continuePaused,
    pauseBusy,
    compactStatus,
    compactBusy: compactStatus?.phase === 'submitting',
    compactAvailable:
      !stopping &&
      !pauseBusy &&
      !sendUncertain &&
      !effectsUnknown &&
      (!compactStatus || compactStatus.phase === 'done') &&
      (!streaming || Boolean(selected)),
    compactRetryAllowed:
      compactStatus?.phase === 'uncertain' && compactRetryEligible(compactRequest.current),
    retryCompact: async () => {
      await compact(true);
    },
    refreshCompact: () => {
      if (compactRequest.current?.receipt)
        setCompactStatus({
          phase: 'waiting',
          receipt: compactRequest.current.receipt,
          message: null,
        });
      setCompactGeneration((value) => value + 1);
    },
    stop,
    refresh: async (clearError) => {
      await refresh(clearError);
      if (mounted.current) setFollowGeneration((value) => value + 1);
    },
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
