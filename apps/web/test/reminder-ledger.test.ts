import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  cancellationAllowed,
  cancelReceipt,
  checked,
  cursorPath,
  readNextPage,
  readReminder,
  TaskEventsPageSchema,
  TaskListPageSchema,
  taskEventsPath,
  taskFilter,
  taskListPath,
  type PageSnapshot,
} from '../src/features/reminders/data';
import type { TaskEventItem, TaskListItem } from '../src/lib/types';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const frozenLocal = '2026-11-01 01:30:00.123456';
const frozenUtc = '2026-11-01T05:30:00.123456Z';
const taskCursor = 'task+cursor/with=&opaque?';
const eventCursor = 'event+cursor/with=&opaque?';
const tasks: TaskListItem[] = Array.from({ length: 51 }, (_, index) => ({
  task_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  state: 'scheduled',
  fire_at_utc: frozenUtc,
  fire_at_local: frozenLocal,
  timezone_id: 'America/New_York',
  source_approval_id: null,
  schedule_receipt: index === 0 ? 'receipt/raw' : null,
}));
const events: TaskEventItem[] = Array.from({ length: 51 }, (_, index) => ({
  event_id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
  type: 'scheduled',
  recorded_at_utc: frozenUtc,
  state_version: index + 1,
  evidence_ref: index === 0 ? '  original evidence\nline two  ' : '',
}));

describe('bounded reminder GET consumers', () => {
  let server: Server;
  let base: string;
  const requests: {
    method: string | undefined;
    path: string;
    cursor: string | null;
    limit: string | null;
  }[] = [];
  const failedTail: Record<string, boolean> = {};

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://reminders.test');
      requests.push({
        method: request.method,
        path: url.pathname,
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit'),
      });
      let status = 200;
      let data: unknown;
      let code = 'NOT_READY';
      if (url.pathname === '/api/v1/tasks') {
        const tail = url.searchParams.get('cursor') === taskCursor;
        data = {
          items: tail ? tasks.slice(50) : tasks.slice(0, 50),
          next_cursor: tail ? null : taskCursor,
        };
        if (tail && !failedTail.tasks) {
          failedTail.tasks = true;
          status = 503;
        }
      } else if (url.pathname === `/api/v1/tasks/${taskId}/events`) {
        const tail = url.searchParams.get('cursor') === eventCursor;
        data = {
          items: tail ? [events[49], events[50]] : events.slice(0, 50),
          next_cursor: tail ? null : eventCursor,
        };
        if (tail && !failedTail.events) {
          failedTail.events = true;
          status = 403;
          code = 'FORBIDDEN';
        }
      } else if (url.pathname === '/empty') {
        data = { items: [], next_cursor: null };
      } else if (url.pathname === '/invalid') {
        data = { items: [{ ...events[0], state_version: 'not-a-number' }], next_cursor: null };
      } else if (url.pathname === '/unauthorized') {
        status = 401;
        code = 'UNAUTHORIZED';
      } else {
        status = 404;
        code = 'NOT_FOUND';
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          status === 200
            ? { code: 0, msg: 'ok', data, error: null, request_id: 'reminder-http' }
            : {
                code: status * 100,
                msg: 'failed',
                data: null,
                error: { code, message: 'Read unavailable', request_id: 'reminder-failure' },
                request_id: 'reminder-failure',
              },
        ),
      );
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing reminder HTTP address');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    const stopped = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await stopped;
  });

  it('reaches task 51 while a failed next page retains all accepted rows and its exact cursor', async () => {
    const path = `${base}${taskListPath('all')}`;
    const first = await readNextPage<TaskListItem>(
      path,
      { page: null, error: null },
      TaskListPageSchema,
      (item) => item.task_id,
    );
    expect(first.page?.items).toHaveLength(50);
    expect(first.page?.next_cursor).toBe(taskCursor);
    expect(first.page?.items[0]?.fire_at_local).toBe(frozenLocal);
    expect(first.page?.items[0]?.fire_at_utc).toBe(frozenUtc);
    expect(first.page?.items[0]?.timezone_id).toBe('America/New_York');
    const failed = await readNextPage(path, first, TaskListPageSchema, (item) => item.task_id);
    expect(failed.page).toBe(first.page);
    expect(failed.error).toMatchObject({
      status: 503,
      code: 'NOT_READY',
      requestId: 'reminder-failure',
    });
    expect(failed.page?.next_cursor).toBe(taskCursor);
    const last = await readNextPage(path, failed, TaskListPageSchema, (item) => item.task_id);
    expect(last.page?.items).toHaveLength(51);
    expect(last.page?.items[50]?.task_id).toBe(tasks[50]?.task_id);
    expect(last.page?.next_cursor).toBeNull();
    expect(last.error).toBeNull();
    const beforeEndRead = requests.length;
    expect(await readNextPage(path, last, TaskListPageSchema, (item) => item.task_id)).toBe(last);
    expect(requests.length).toBe(beforeEndRead);
    expect(requests.filter((request) => request.path === '/api/v1/tasks')).toEqual([
      { method: 'GET', path: '/api/v1/tasks', cursor: null, limit: '50' },
      { method: 'GET', path: '/api/v1/tasks', cursor: taskCursor, limit: '50' },
      { method: 'GET', path: '/api/v1/tasks', cursor: taskCursor, limit: '50' },
    ]);
  });

  it('reads only the selected task ledger, retries its unchanged cursor after 403, and deduplicates overlap', async () => {
    const path = `${base}${taskEventsPath(taskId)}`;
    const first = await readNextPage<TaskEventItem>(
      path,
      { page: null, error: null },
      TaskEventsPageSchema,
      (item) => item.event_id,
    );
    const failed = await readNextPage(path, first, TaskEventsPageSchema, (item) => item.event_id);
    expect(failed.error).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(failed.page).toBe(first.page);
    expect(failed.page?.next_cursor).toBe(eventCursor);
    const last = await readNextPage(path, failed, TaskEventsPageSchema, (item) => item.event_id);
    expect(last.page?.items.map((item) => item.event_id)).toEqual(
      events.map((item) => item.event_id),
    );
    expect(last.page?.items[0]?.evidence_ref).toBe('  original evidence\nline two  ');
    expect(last.page?.items[0]?.recorded_at_utc).toBe(frozenUtc);
    expect(last.page?.next_cursor).toBeNull();
    const eventRequests = requests.filter((request) => request.path.endsWith('/events'));
    expect(eventRequests).toHaveLength(3);
    expect(
      eventRequests.every(
        (request) => request.path === `/api/v1/tasks/${taskId}/events` && request.method === 'GET',
      ),
    ).toBe(true);
    expect(eventRequests.map((request) => request.cursor)).toEqual([
      null,
      eventCursor,
      eventCursor,
    ]);
  });

  it('does not mistake malformed responses for an empty last page or consume the accepted cursor', async () => {
    const current: PageSnapshot<TaskEventItem> = {
      page: { items: [events[0]!], next_cursor: eventCursor },
      error: null,
    };
    const failed = await readNextPage(
      `${base}/invalid?limit=50`,
      current,
      TaskEventsPageSchema,
      (item) => item.event_id,
    );
    expect(failed.page).toBe(current.page);
    expect(failed.error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(current.page?.next_cursor).toBe(eventCursor);
    const empty = await readNextPage<TaskEventItem>(
      `${base}/empty`,
      { page: null, error: null },
      TaskEventsPageSchema,
      (item) => item.event_id,
    );
    expect(empty).toEqual({ page: { items: [], next_cursor: null }, error: null });
  });

  it('preserves 401/404 identity rather than manufacturing empty records, and every read stays GET-only', async () => {
    const unauthorized = await readReminder(`${base}/unauthorized`, TaskListPageSchema);
    expect(unauthorized).toMatchObject({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      requestId: 'reminder-failure',
    });
    const missing = await readReminder(`${base}/missing`, TaskListPageSchema);
    expect(missing).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });
});

describe('reminder state and presentation boundaries', () => {
  it('requires an accepted cancellation receipt for this task, and keeps pending distinct from completed', () => {
    expect(
      cancelReceipt({ task_id: taskId, state: 'cancel_pending', duplicate: false }, taskId)?.state,
    ).toBe('cancel_pending');
    expect(
      cancelReceipt({ task_id: taskId, state: 'cancelled', duplicate: true }, taskId)?.state,
    ).toBe('cancelled');
    expect(
      cancelReceipt({ task_id: otherId, state: 'cancelled', duplicate: false }, taskId),
    ).toBeNull();
    expect(
      cancelReceipt({ task_id: taskId, state: 'scheduled', duplicate: false }, taskId),
    ).toBeNull();
    expect(cancelReceipt({ task_id: taskId, duplicate: false }, taskId)).toBeNull();
    for (const state of ['saved', 'pending_schedule', 'scheduled'])
      expect(cancellationAllowed(state)).toBe(true);
    for (const state of [
      'fired',
      'missed',
      'cancel_pending',
      'cancelled',
      'unknown',
      'future_state',
    ])
      expect(cancellationAllowed(state)).toBe(false);
  });

  it('keeps filters finite and opaque resource cursors isolated without rewriting frozen fields or inventing a title', () => {
    expect(taskFilter('scheduled')).toBe('scheduled');
    expect(taskFilter(['scheduled'])).toBe('all');
    expect(taskFilter('unknown')).toBe('all');
    const list = checked(
      { ok: true, data: { items: [tasks[0]], next_cursor: taskCursor } },
      TaskListPageSchema,
    );
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.items[0]).not.toHaveProperty('title');
      expect(list.data.items[0]?.fire_at_local).toBe(frozenLocal);
    }
    expect(
      new URL(
        cursorPath(`http://reminders.test${taskEventsPath(taskId)}`, eventCursor),
      ).searchParams.get('cursor'),
    ).toBe(eventCursor);
    expect(
      new URL(`http://reminders.test${taskListPath('scheduled')}`).searchParams.get('status'),
    ).toBe('scheduled');
  });
});
