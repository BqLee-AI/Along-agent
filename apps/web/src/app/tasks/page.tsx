import Link from 'next/link';
import { apiGet } from '../../lib/api';
import type { TaskListItem } from '../../lib/types';

export const dynamic = 'force-dynamic';

interface Page {
  items: TaskListItem[];
  next_cursor: string | null;
}

export default async function TasksPage() {
  const result = await apiGet<Page>('/api/v1/tasks?status=all&limit=50');
  if (!result.ok) {
    return (
      <section>
        <h1>任务</h1>
        <p className="error">{result.message}</p>
      </section>
    );
  }
  return (
    <section>
      <h1>任务</h1>
      <p className="subtitle">时间按创建时冻结的本地文本展示，不换算。</p>
      {result.data.items.length === 0 ? (
        <div className="panel">还没有任务。确认一条提议后才会创建。</div>
      ) : (
        <ul className="card-list">
          {result.data.items.map((task) => (
            <li className="card" key={task.task_id}>
              <div>
                <Link href={`/tasks/${task.task_id}`}>{task.task_id.slice(0, 8)}</Link>
                <span className="badge">{task.state}</span>
                {task.schedule_receipt ? null : <span className="badge">无登记回执</span>}
              </div>
              <span className="time">
                {task.fire_at_local} · {task.timezone_id}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
