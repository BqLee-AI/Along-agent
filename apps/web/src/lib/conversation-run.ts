import { EnvelopeSchema, RunViewSchema, type RunView } from '@along/contracts';
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

export async function readEnvelope(response: Response): Promise<unknown> {
  requireClientSession(response);
  const payload = EnvelopeSchema.parse(await response.json());
  if (!response.ok || payload.code !== 0) {
    const detail = payload.error;
    throw new Error(
      `${detail?.code ? `${detail.code}: ` : ''}${detail?.message ?? `请求失败（${response.status}）`}`,
    );
  }
  return payload.data;
}

export async function readRun(conversationId: string, runId: string): Promise<RunView> {
  const response = await fetch(runPath(conversationId, runId), { cache: 'no-store' });
  return RunViewSchema.parse(await readEnvelope(response));
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
