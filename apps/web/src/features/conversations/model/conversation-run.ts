import { RunViewSchema } from '@along/contracts';
import { RunModelSelectionSchema } from '@along/contracts';
import type { RunView } from '@along/contracts';
import { ThreadEventSchema } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import { z } from 'zod';
import { ApiReadError, readEnvelope } from '@/shared/http/client';
import { api, createBrowserApi, writeOptions } from '@/shared/http/eden';
import type { ApiClient } from '@/shared/http/eden';

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
export const CompactReceiptSchema = z
  .object({
    status: z.enum([
      'pending',
      'paused',
      'compacting',
      'published',
      'failed',
      'cancelled',
      'continued',
      'no_content',
    ]),
    run_id: z.string().uuid().nullable(),
    pause_id: z.string().uuid().nullable(),
    error_code: z.string().nullable().optional(),
    candidate_status: z.enum(['pending', 'saved', 'failed', 'cancelled']).nullable().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (
      value.status === 'no_content'
        ? value.run_id !== null || value.pause_id !== null
        : !value.run_id || !value.pause_id
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: '压缩回执身份不完整。' });
  });
export type CompactReceipt = z.infer<typeof CompactReceiptSchema>;

export function compactIsFinal(receipt: CompactReceipt): boolean {
  return ['continued', 'failed', 'cancelled', 'no_content'].includes(receipt.status);
}

export const CompactRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    runId: z.string().uuid().nullable(),
    key: z.string().uuid(),
    receipt: CompactReceiptSchema.nullable(),
  })
  .strict();
export type CompactRequest = z.infer<typeof CompactRequestSchema>;

/** Drop subscriptions from the old attempt only for the selected continued Run. */
export function handoffCompactStreams(
  request: CompactRequest,
  receipt: CompactReceipt,
  selected: { conversationId: string; runId: string } | null,
  admission: AbortController | null,
  follower: AbortController | null,
): boolean {
  if (
    receipt.status !== 'continued' ||
    !request.runId ||
    request.runId !== receipt.run_id ||
    selected?.conversationId !== request.conversationId ||
    selected.runId !== request.runId
  )
    return false;
  admission?.abort();
  follower?.abort();
  return true;
}

export function compactRetryEligible(request: CompactRequest | null): boolean {
  return Boolean(request && !request.receipt);
}

export async function postCompact(
  request: CompactRequest,
  csrf: string | null,
  signal: AbortSignal,
  fetchAction: typeof fetch = fetch,
) {
  const endpoint = createBrowserApi(fetchAction).api.v1.conversations({
    id: encodeURIComponent(request.conversationId),
  });
  const options = writeOptions(csrf, signal, request.key);
  const response = request.runId
    ? await endpoint
        .runs({ run: encodeURIComponent(request.runId) })
        .actions.compact.post({}, options)
    : await endpoint.actions.compact.post({}, options);
  const receipt = CompactReceiptSchema.parse(await readEnvelope(response));
  if (request.runId && receipt.run_id !== request.runId)
    throw new Error('压缩回执与原运行不匹配。');
  return receipt;
}

export async function readCompact(
  conversationId: string,
  runId: string,
  pauseId: string,
  signal: AbortSignal,
  fetchAction: typeof fetch = fetch,
) {
  const receipt = CompactReceiptSchema.parse(
    await readEnvelope(
      await createBrowserApi(fetchAction)
        .api.v1.conversations({ id: encodeURIComponent(conversationId) })
        .runs({ run: encodeURIComponent(runId) })
        .compacts({ pause: encodeURIComponent(pauseId) })
        .get({ fetch: { signal } }),
    ),
  );
  if (receipt.run_id !== runId || receipt.pause_id !== pauseId)
    throw new Error('压缩状态与原请求不匹配。');
  return receipt;
}

export function modelSelectionLabel(
  selection: z.infer<typeof RunModelSelectionSchema> | undefined,
): string {
  if (!selection) return '服务端未提供模型信息';
  if (selection.state === 'legacy_unavailable') return '历史模型信息不可还原';
  if (selection.state === 'not_applicable') return '此运行不使用模型';
  return `${selection.provider_name} · ${selection.model_id}`;
}

export function runPath(conversationId: string, runId: string): string {
  return `/api/v1/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`;
}

export function conversationHref(conversationId: string, runId: string): string {
  return `/conversations?${new URLSearchParams({ conversation_id: conversationId, run_id: runId })}`;
}

export async function readRun(
  conversationId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunView> {
  const response = await api.api.v1
    .conversations({ id: encodeURIComponent(conversationId) })
    .runs({ run: encodeURIComponent(runId) })
    .get({ fetch: { signal } });
  return RunViewSchema.parse(await readEnvelope(response));
}

export async function requestUserPause(
  conversationId: string,
  runId: string,
  key: string,
  csrf: string | null,
  signal: AbortSignal,
  fetchAction: typeof fetch = fetch,
) {
  const response = await createBrowserApi(fetchAction)
    .api.v1.conversations({ id: encodeURIComponent(conversationId) })
    .runs({ run: encodeURIComponent(runId) })
    .actions.pause.post({ reason: 'user', purpose: 'none' }, writeOptions(csrf, signal, key));
  return z
    .object({ status: z.enum(['pending', 'paused']), pause_id: z.string().uuid() })
    .strict()
    .parse(await readEnvelope(response));
}
export function postRunStream(
  url: string,
  body: object,
  csrf: string | null,
  signal: AbortSignal,
  idempotencyKey?: string,
  fetchAction: typeof fetch = fetch,
): Promise<Response> {
  return fetchAction(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(csrf !== null ? { 'x-csrf-token': csrf } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

export function userPauseCanContinue(run: RunView | null): boolean {
  return (
    run?.status === 'paused' &&
    run.pause?.status === 'paused' &&
    run.pause.reason === 'user' &&
    run.pause.purpose === 'none'
  );
}

export async function readHistoryEventPage(
  conversationId: string,
  runId: string,
  afterSeq: number,
  signal?: AbortSignal,
  client: ApiClient = api,
): Promise<{ items: ThreadEvent[]; nextCursor: string | null }> {
  const response = await client.api.v1
    .conversations({ id: encodeURIComponent(conversationId) })
    .get({
      query: { run_id: runId, after_seq: String(afterSeq), limit: '200' },
      fetch: { signal },
    });
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

// Following is read-only: an interrupted subscription never retries admission or resume.
export async function followRunEvents({
  conversationId,
  runId,
  signal,
  cursor,
  onEvent,
  readStatus,
  fetchEvents = fetch,
  retryDelay = 500,
}: {
  conversationId: string;
  runId: string;
  signal: AbortSignal;
  cursor: () => number;
  onEvent: (event: ThreadEvent) => void;
  readStatus: () => Promise<RunView['status']>;
  fetchEvents?: (url: string, init: RequestInit) => Promise<Response>;
  retryDelay?: number;
}): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    try {
      const query = new URLSearchParams({ after_seq: String(cursor()) });
      const response = await fetchEvents(`${runPath(conversationId, runId)}/events?${query}`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        signal,
      });
      await consumeThreadStream(response, (event) => {
        if (event.payload.conversation_id !== conversationId || event.payload.run_id !== runId)
          throw new Error('订阅事件与指定会话 / Run 不匹配。');
        if (event.seq > cursor()) onEvent(event);
      });
      if (signal.aborted) return;
      // A card alone is not proof that the attempt has actually suspended.
      if ((await readStatus()) !== 'running') return;
      failure = new Error('运行仍在进行，但事件连接已断开。');
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiReadError && [401, 403, 404].includes(error.status)) throw error;
      failure = error;
    }
    if (attempt < 2) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, retryDelay * 2 ** attempt);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
      await promise;
    }
  }
  if (!signal.aborted) throw failure ?? new Error('事件连接已断开。');
}

export const runStatusLabel: Record<RunView['status'], string> = {
  running: '运行中（读取不会自动继续）',
  suspended_approval: '运行已挂起；请核对决议与继续资格',
  paused: '已暂停；等待明确继续',
  done: '运行已结束（不等于目标完成）',
  failed: '运行失败',
  cancelled: '已停止；已发生的效果不会撤销',
};

export function eventPageComplete(count: number, limit: number): boolean {
  return count < limit;
}

export interface HistoryApprovalReference {
  kind: 'task' | 'document';
  approvalId: string;
  seq: number;
}

export interface RunTranscript extends Pick<
  RunView,
  'authorization_revision' | 'execution_lifecycle' | 'goal_result'
> {
  text: string;
  approvals: HistoryApprovalReference[];
  usage?: { iterations: number; tokens: number | null };
}

// Callers normalize persisted seq once with mergeThreadEvents before collecting.
// Map insertion order retains the first event's Run order for the chat log.
export function collectRunTranscripts(
  events: readonly ThreadEvent[],
  {
    includeText = true,
    previous,
  }: { includeText?: boolean; previous?: ReadonlyMap<string, RunTranscript> } = {},
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
    if (event.protocol_version === 'v2') {
      if (event.type === 'thread.started') {
        if (event.payload.authorization_revision !== undefined)
          transcript.authorization_revision = event.payload.authorization_revision;
        if (event.payload.execution_lifecycle !== undefined)
          transcript.execution_lifecycle = event.payload.execution_lifecycle;
      } else if (
        event.type === 'thread.completed' ||
        event.type === 'thread.failed' ||
        event.type === 'thread.cancelled'
      ) {
        transcript.goal_result = event.payload.goal_result;
        transcript.usage = event.payload.usage;
      }
    }
    if (event.type !== 'approval_required') continue;
    const approvalId = event.payload.approval_id;
    const kind = event.payload.card_id === `document-approval:${approvalId}` ? 'document' : 'task';
    const key = `${runId}:${kind}:${approvalId}`;
    if (!seen.has(key)) {
      seen.add(key);
      transcript.approvals.push({ kind, approvalId, seq: event.seq });
    }
  }
  if (previous) {
    for (const [runId, transcript] of transcripts) {
      const prior = previous.get(runId);
      if (!prior || prior.approvals.length !== transcript.approvals.length) continue;
      const sameApprovals = prior.approvals.every((item, index) => {
        const next = transcript.approvals[index]!;
        return (
          item.kind === next.kind && item.approvalId === next.approvalId && item.seq === next.seq
        );
      });
      if (sameApprovals) {
        transcript.approvals = prior.approvals;
        if (
          prior.text === transcript.text &&
          prior.authorization_revision === transcript.authorization_revision &&
          prior.execution_lifecycle === transcript.execution_lifecycle &&
          prior.goal_result === transcript.goal_result &&
          prior.usage === transcript.usage
        )
          transcripts.set(runId, prior);
      }
    }
  }
  return transcripts;
}
