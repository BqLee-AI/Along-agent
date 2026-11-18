import { EnvelopeSchema } from '@along/contracts';
import { z } from 'zod';
import { requireClientSession } from '@/shared/session/navigation';
import type { ApiResult } from '@/shared/http/result';
import { api } from '@/shared/http/eden';
import type { ApiClient, JsonCall, JsonResult } from '@/shared/http/eden';
import { TaskDetailSchema, TaskListItemSchema } from './types';

export const taskStates = [
  'all',
  'saved',
  'pending_schedule',
  'scheduled',
  'fired',
  'missed',
  'cancel_pending',
  'cancelled',
] as const;
export type TaskFilter = (typeof taskStates)[number];
const stateLabels: Record<string, string> = {
  all: '全部状态',
  saved: '已保存',
  pending_schedule: '待调度登记',
  scheduled: '已登记调度',
  fired: '已触发',
  missed: '已错过',
  cancel_pending: '取消待回执',
  cancelled: '已取消',
};
export function taskFilter(value: unknown): TaskFilter {
  return taskStates.includes(value as TaskFilter) ? (value as TaskFilter) : 'all';
}
export function taskStateLabel(state: string): string {
  return Object.hasOwn(stateLabels, state) ? stateLabels[state]! : state;
}
export function cancellationAllowed(state: string): boolean {
  return state === 'saved' || state === 'pending_schedule' || state === 'scheduled';
}
export const TaskListPageSchema = z
  .object({
    items: z.array(TaskListItemSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();
export const TaskEventsPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          event_id: z.string().uuid(),
          type: z.string(),
          recorded_at_utc: z.string(),
          state_version: z.number(),
          evidence_ref: z.string(),
        })
        .strict(),
    ),
    next_cursor: z.string().nullable(),
  })
  .strict();
const CancelReceiptSchema = z
  .object({
    task_id: z.string().uuid(),
    state: z.enum(['cancelled', 'cancel_pending']),
    duplicate: z.boolean(),
  })
  .strict();
export function cancelReceipt(data: unknown, taskId: string) {
  const parsed = CancelReceiptSchema.safeParse(data);
  return parsed.success && parsed.data.task_id === taskId ? parsed.data : null;
}
export type ResourceFailure = Extract<ApiResult<never>, { ok: false }>;
export type ReminderPage<T> = { items: T[]; next_cursor: string | null };
export type PageSnapshot<T> = { page: ReminderPage<T> | null; error: ResourceFailure | null };
export const invalidResponse: ResourceFailure = {
  ok: false,
  status: 200,
  code: 'INVALID_RESPONSE',
  requestId: null,
  message: '响应无法核验。',
};
export function checked<T>(result: ApiResult<unknown>, schema: z.ZodType<T>): ApiResult<T> {
  if (!result.ok) return result;
  const parsed = schema.safeParse(result.data);
  return parsed.success ? { ok: true, data: parsed.data } : invalidResponse;
}
export function snapshot<T>(result: ApiResult<ReminderPage<T>>): PageSnapshot<T> {
  return result.ok ? { page: result.data, error: null } : { page: null, error: result };
}
export type ReminderPageLoader<T> = (
  cursor: string | null,
  signal?: AbortSignal,
) => Promise<JsonResult<ReminderPage<T>>>;
export function taskListRequest(status: TaskFilter, client: ApiClient = api) {
  return (cursor: string | null, signal?: AbortSignal) =>
    client.api.v1.tasks.get({
      query: { status, limit: '50', ...(cursor !== null ? { cursor } : {}) },
      fetch: { signal },
    });
}
export function taskEventsRequest(id: string, client: ApiClient = api) {
  return (cursor: string | null, signal?: AbortSignal) =>
    client.api.v1.tasks({ id: encodeURIComponent(id) }).events.get({
      query: { limit: '50', ...(cursor !== null ? { cursor } : {}) },
      fetch: { signal },
    });
}
export function failureExplanation(error: ResourceFailure): string {
  if (error.status === 401) return '会话已失效，请重新登录。返回后仅重新读取，不会重放操作。';
  if (error.status === 403)
    return '当前请求无权执行。请重新读取身份或返回自己的任务范围；不会自动重试操作。';
  if (error.status === 404) return '未找到此资源，或当前接口不可读取。这不是空记录。';
  if (error.code === 'INVALID_RESPONSE') return '响应无法核验，先前内容保留，请重新读取此资源。';
  if (error.status === 0) return '暂时无法连接服务，先前内容保留。';
  return '此资源暂不可读取，先前内容保留。请重新读取；此错误不代表提醒已取消。';
}
export async function readReminder<T>(
  call: JsonCall<T>,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  try {
    const result = await call(api);
    const { response } = result;
    requireClientSession(response);
    const parsed = EnvelopeSchema.safeParse(result.error ? result.error.value : result.data);
    if (response.ok && parsed.success && parsed.data.code === 0) {
      const data = schema.safeParse(parsed.data.data);
      return data.success ? { ok: true, data: data.data } : invalidResponse;
    }
    return {
      ok: false,
      status: response.status,
      code: parsed.success ? (parsed.data.error?.code ?? null) : null,
      requestId: parsed.success ? parsed.data.request_id : response.headers.get('x-request-id'),
      message: '读取失败。',
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, status: 0, code: null, requestId: null, message: '无法连接服务。' };
  }
}
// Each invocation reads one bounded page. A failed read cannot consume its cursor.
export async function readNextPage<T>(
  load: ReminderPageLoader<T>,
  current: PageSnapshot<T>,
  schema: z.ZodType<ReminderPage<T>>,
  identity: (item: T) => string,
  signal?: AbortSignal,
): Promise<PageSnapshot<T>> {
  if (current.page && current.page.next_cursor === null) return current;
  const result = await readReminder(
    () => load(current.page?.next_cursor ?? null, signal),
    schema,
    signal,
  );
  if (!result.ok) return { page: current.page, error: result };
  const seen = new Set((current.page?.items ?? []).map(identity));
  const items = [...(current.page?.items ?? [])];
  for (const item of result.data.items) {
    if (!seen.has(identity(item))) {
      seen.add(identity(item));
      items.push(item);
    }
  }
  return { page: { items, next_cursor: result.data.next_cursor }, error: null };
}
export async function readTask(id: string, signal?: AbortSignal) {
  const result = await readReminder(
    (api) => api.api.v1.tasks({ id: encodeURIComponent(id) }).get({ fetch: { signal } }),
    TaskDetailSchema,
    signal,
  );
  return result.ok && result.data.task_id !== id ? invalidResponse : result;
}
