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
  TaskListPageSchema,
  TaskEventsPageSchema,
} from './data';

export async function loadReminders(query: PageQuery) {
  const status = taskFilter(Array.isArray(query.status) ? query.status[0] : query.status);
  const returnTo = pageReturnTo('/tasks', query);
  const result = checked(
    await apiGet((api) => api.api.v1.tasks.get({ query: { status, limit: '50' } }), returnTo),
    TaskListPageSchema,
  );
  return { status, returnTo, initial: snapshot(result) };
}

export async function loadReminderDetail(id: string, query: PageQuery) {
  const returnTo = pageReturnTo(`/tasks/${encodeURIComponent(id)}`, query);
  const [detailResponse, eventsResponse, identityResponse] = await Promise.all([
    apiGet((api) => api.api.v1.tasks({ id: encodeURIComponent(id) }).get(), returnTo),
    apiGet(
      (api) =>
        api.api.v1.tasks({ id: encodeURIComponent(id) }).events.get({ query: { limit: '50' } }),
      returnTo,
    ),
    apiGet((api) => api.api.v1.me.get(), returnTo),
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
    apiGet((api) => api.api.v1.tasks.get({ query: { status: 'all', limit: '50' } }), returnTo),
    selectedId
      ? apiGet((api) => api.api.v1.tasks({ id: encodeURIComponent(selectedId) }).get(), returnTo)
      : Promise.resolve(null),
  ]);
  const parsedDetail = detailResponse ? checked(detailResponse, TaskDetailSchema) : null;
  const detail =
    parsedDetail?.ok && parsedDetail.data.task_id !== selectedId ? invalidResponse : parsedDetail;
  const events =
    selectedId && detail?.ok
      ? snapshot(
          checked(
            await apiGet(
              (api) =>
                api.api.v1
                  .tasks({ id: encodeURIComponent(selectedId) })
                  .events.get({ query: { limit: '50' } }),
              returnTo,
            ),
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
