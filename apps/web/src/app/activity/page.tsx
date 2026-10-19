import Link from 'next/link';
import { apiGet } from '../../lib/api';
import type { TaskEventItem, TaskListItem } from '../../lib/types';

export const dynamic = 'force-dynamic';

interface TaskPage {
  items: TaskListItem[];
  next_cursor: string | null;
}

interface EventPage {
  items: TaskEventItem[];
  next_cursor: string | null;
}

interface Row extends TaskEventItem {
  taskId: string;
  taskState: string;
}

export default async function ActivityPage() {
  const tasksResult = await apiGet<TaskPage>('/api/v1/tasks?status=all&limit=50');
  if (!tasksResult.ok) {
    return (
      <section>
        <h1>活动</h1>
        <p className="error">{tasksResult.message}</p>
      </section>
    );
  }
  const pages = await Promise.all(
    tasksResult.data.items.map(async (task) => ({
      task,
      events: await apiGet<EventPage>(`/api/v1/tasks/${task.task_id}/events?limit=50`),
    })),
  );
  const rows: Row[] = [];
  for (const { task, events } of pages) {
    if (!events.ok) continue;
    for (const event of events.data.items) {
      rows.push({ ...event, taskId: task.task_id, taskState: task.state });
    }
  }
  rows.sort((a, b) => (a.recorded_at_utc < b.recorded_at_utc ? 1 : -1));
  return (
    <section>
      <h1>活动账</h1>
      <p className="subtitle">
        只读展示服务端记录到的事件。没有外部凭据的行显示“服务端记录”，不声称用户已读。
      </p>
      {rows.length === 0 ? (
        <div className="panel">还没有记录到活动。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>任务</th>
              <th>记录时间（UTC）</th>
              <th>证据</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.event_id}>
                <td>{row.type}</td>
                <td>
                  <Link href={`/tasks/${row.taskId}`}>{row.taskId.slice(0, 8)}</Link>
                  <span className="badge">{row.taskState}</span>
                </td>
                <td>{row.recorded_at_utc}</td>
                <td>{row.evidence_ref || '服务端记录'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
