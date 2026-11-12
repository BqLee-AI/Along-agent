import 'server-only';

import { apiGet } from '@/shared/http/server';
import { pageReturnTo } from '@/shared/session/navigation';
import type { PageQuery } from '@/shared/session/navigation';
import { MeSchema } from '@/shared/session/identity';
import { TaskDetailSchema } from './types';
import {
  checked,
  invalidResponse,
  snapshot,
  taskFilter,
  taskListPath,
  taskPath,
  taskEventsPath,
  TaskListPageSchema,
  TaskEventsPageSchema,
} from './data';

export async function loadReminders(query: PageQuery) {
  const status = taskFilter(Array.isArray(query.status) ? query.status[0] : query.status);
  const returnTo = pageReturnTo('/tasks', query);
  const result = checked(await apiGet<unknown>(taskListPath(status), returnTo), TaskListPageSchema);
  return { status, returnTo, initial: snapshot(result) };
}

export async function loadReminderDetail(id: string, query: PageQuery) {
  const returnTo = pageReturnTo(`/tasks/${encodeURIComponent(id)}`, query);
  const [detailResponse, eventsResponse, identityResponse] = await Promise.all([
    apiGet<unknown>(taskPath(id), returnTo),
    apiGet<unknown>(taskEventsPath(id), returnTo),
    apiGet<unknown>('/api/v1/me', returnTo),
  ]);
  const parsedDetail = checked(detailResponse, TaskDetailSchema);
  const detail =
    parsedDetail.ok && parsedDetail.data.task_id !== id ? invalidResponse : parsedDetail;
  return {
    returnTo,
    detail,
    events: snapshot(checked(eventsResponse, TaskEventsPageSchema)),
    me: checked(identityResponse, MeSchema),
  };
}

export async function loadReminderActivity(query: PageQuery) {
  const selectedId = Array.isArray(query.task_id) ? query.task_id[0] : query.task_id;
  const returnTo = pageReturnTo('/activity', query);
  // Read a deep-linked task directly, even outside the loaded index. Never fan out event reads.
  const [taskResponse, detailResponse] = await Promise.all([
    apiGet<unknown>(taskListPath('all'), returnTo),
    selectedId ? apiGet<unknown>(taskPath(selectedId), returnTo) : Promise.resolve(null),
  ]);
  const parsedDetail = detailResponse ? checked(detailResponse, TaskDetailSchema) : null;
  const detail =
    parsedDetail?.ok && parsedDetail.data.task_id !== selectedId ? invalidResponse : parsedDetail;
  const events =
    selectedId && detail?.ok
      ? snapshot(
          checked(
            await apiGet<unknown>(taskEventsPath(selectedId), returnTo),
            TaskEventsPageSchema,
          ),
        )
      : null;
  return {
    selectedId,
    returnTo,
    initial: snapshot(checked(taskResponse, TaskListPageSchema)),
    detail,
    events,
  };
}
