import { EnvelopeSchema, RunViewSchema, type Envelope, type RunView } from '@along/contracts';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import { z } from 'zod';
import { requireClientSession } from './account-navigation';

export const ConversationEventsSchema = z
  .object({
    conversation_id: z.string().uuid(),
    status: z.string(),
    confirmed_timezone_id: z.string().nullable(),
    anchor_received_at_utc: z.string().nullable(),
    events: z.array(ThreadEventSchema),
    next_after_seq: z.number().int().positive().nullable(),
  })
  .strict();

export const ResumeRequestSchema = z
  .object({
    checkpoint_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
  })
  .strict();
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export function runPath(conversationId: string, runId: string): string {
  return `/api/v1/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`;
}

export function conversationHref(conversationId: string, runId: string): string {
  return `/conversations?${new URLSearchParams({ conversation_id: conversationId, run_id: runId })}`;
}

export class ApiReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
    message: string,
  ) {
    super(
      `HTTP ${status}${code ? ` · ${code}` : ''}: ${message}${requestId ? `（request_id: ${requestId}）` : ''}`,
    );
    this.name = 'ApiReadError';
  }
}

export async function readEnvelope(response: Response): Promise<unknown> {
  requireClientSession(response);
  let payload: Envelope;
  try {
    payload = EnvelopeSchema.parse(await response.json());
  } catch {
    throw new ApiReadError(
      response.status,
      null,
      response.headers.get('x-request-id'),
      '响应不符合公开读取合同。',
    );
  }
  if (!response.ok || payload.code !== 0) {
    const detail = payload.error;
    throw new ApiReadError(
      response.status,
      detail?.code ?? null,
      payload.request_id,
      detail?.message ?? `请求失败（${response.status}）`,
    );
  }
  return payload.data;
}

export async function readRun(
  conversationId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunView> {
  const response = await fetch(runPath(conversationId, runId), { cache: 'no-store', signal });
  return RunViewSchema.parse(await readEnvelope(response));
}

export async function readHistoryCollectionPage<T>(
  url: string,
  schema: z.ZodType<{ items: T[]; next_cursor: string | null }>,
  signal?: AbortSignal,
): Promise<{ items: T[]; next_cursor: string | null }> {
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal });
  return schema.parse(await readEnvelope(response));
}

export async function readHistoryEventPage(
  url: string,
  conversationId: string,
  runId: string,
  afterSeq: number,
  signal?: AbortSignal,
): Promise<{ items: ThreadEvent[]; nextCursor: string | null }> {
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal });
  const page = ConversationEventsSchema.parse(await readEnvelope(response));
  if (
    page.conversation_id !== conversationId ||
    page.events.some(
      (event) => event.payload.run_id !== runId || event.payload.conversation_id !== conversationId,
    )
  ) {
    throw new Error('事件与指定会话 / Run 不匹配，未接纳此页。');
  }
  const complete = eventPageComplete(page.events.length, 200);
  if (!complete && (page.next_after_seq === null || page.next_after_seq <= afterSeq)) {
    throw new Error('事件页没有可继续的游标，尚未完整读取。');
  }
  return { items: page.events, nextCursor: complete ? null : String(page.next_after_seq) };
}

// One persisted seq identifies one event, including across resume attempts.
// Internal checkpoint gaps are legal; never infer missing events from seq + 1.
export function mergeThreadEvents(current: ThreadEvent[], incoming: ThreadEvent[]): ThreadEvent[] {
  const events = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) if (!events.has(event.seq)) events.set(event.seq, event);
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

export async function consumeThreadStream(
  response: Response,
  onEvent: (event: ThreadEvent) => void,
): Promise<void> {
  if (!response.ok) {
    await readEnvelope(response);
    return;
  }
  if (!response.body) throw new Error('响应没有事件流。请读取运行状态，不要重复发送原话。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) onEvent(ThreadEventSchema.parse(JSON.parse(data)));
        split = buffer.indexOf('\n\n');
      }
      if (done) {
        if (buffer.trim())
          throw new Error('事件流未完整结束。请读取原运行状态，不要重复发送原话。');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const runStatusLabel: Record<RunView['status'], string> = {
  running: '运行中（读取不会自动继续）',
  suspended_approval: '等待批准决议；流结束不代表完成',
  done: '已完成',
  failed: '运行失败',
  cancelled: '已停止；已发生的效果不会撤销',
};

export interface HistoryPageState<T> {
  target: string;
  request: number;
  items: T[];
  nextCursor: string | null;
  loaded: boolean;
  reading: boolean;
  resetting: boolean;
  error: string | null;
}

export type HistoryPageAction<T> =
  | { type: 'start'; target: string; request: number; reset: boolean }
  | { type: 'success'; target: string; request: number; items: T[]; nextCursor: string | null }
  | { type: 'failure'; target: string; request: number; error: string };

export function initialHistoryPage<T>(target: string): HistoryPageState<T> {
  return {
    target,
    request: 0,
    items: [],
    nextCursor: null,
    loaded: false,
    reading: false,
    resetting: false,
    error: null,
  };
}

// Each resource has its own reducer and request identity. Failed pages never
// advance a cursor; stale reads cannot replace a newly selected URL's facts.
export function historyPageReducer<T>(
  state: HistoryPageState<T>,
  action: HistoryPageAction<T>,
): HistoryPageState<T> {
  if (action.type === 'start') {
    const current = state.target === action.target ? state : initialHistoryPage<T>(action.target);
    return {
      ...current,
      request: action.request,
      reading: true,
      resetting: action.reset,
      error: null,
    };
  }
  if (state.target !== action.target || state.request !== action.request) return state;
  if (action.type === 'failure') return { ...state, reading: false, error: action.error };
  return {
    ...state,
    items: state.resetting ? action.items : [...state.items, ...action.items],
    nextCursor: action.nextCursor,
    loaded: true,
    reading: false,
    error: null,
  };
}

export function eventPageComplete(count: number, limit: number): boolean {
  return count < limit;
}

export interface HistoryApprovalReference {
  kind: 'task' | 'document';
  approvalId: string;
  seq: number;
}

export interface RunTranscript {
  text: string;
  approvals: HistoryApprovalReference[];
}

// Callers normalize persisted seq once with mergeThreadEvents before collecting.
// Map insertion order retains the first event's Run order for the chat log.
export function collectRunTranscripts(
  events: readonly ThreadEvent[],
  { includeText = true }: { includeText?: boolean } = {},
): Map<string, RunTranscript> {
  const transcripts = new Map<string, RunTranscript>();
  const seen = new Set<string>();
  for (const event of events) {
    const runId = event.payload.run_id;
    let transcript = transcripts.get(runId);
    if (!transcript) {
      transcript = { text: '', approvals: [] };
      transcripts.set(runId, transcript);
    }
    if (includeText && event.type === 'message.delta') transcript.text += event.payload.delta;
    if (event.type !== 'approval_required') continue;
    const approvalId = event.payload.approval_id;
    const kind = event.payload.card_id === `document-approval:${approvalId}` ? 'document' : 'task';
    const key = `${runId}:${kind}:${approvalId}`;
    if (!seen.has(key)) {
      seen.add(key);
      transcript.approvals.push({ kind, approvalId, seq: event.seq });
    }
  }
  return transcripts;
}
