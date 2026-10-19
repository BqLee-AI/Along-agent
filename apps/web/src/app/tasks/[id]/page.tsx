import { apiGet } from "../../../lib/api";
import type { Me, TaskDetail, TaskEventItem } from "../../../lib/types";
import CancelAction from "./CancelAction";

export const dynamic = "force-dynamic";

interface EventsPage {
  items: TaskEventItem[];
  next_cursor: string | null;
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detailResult, eventsResult, meResult] = await Promise.all([
    apiGet<TaskDetail>(`/api/v1/tasks/${id}`),
    apiGet<EventsPage>(`/api/v1/tasks/${id}/events?limit=50`),
    apiGet<Me>("/api/v1/me"),
  ]);
  if (!detailResult.ok) {
    return (
      <section>
        <h1>任务</h1>
        <p className="error">{detailResult.message}</p>
      </section>
    );
  }
  const task = detailResult.data;
  const events = eventsResult.ok ? eventsResult.data.items : [];
  return (
    <section>
      <h1>任务 {task.task_id.slice(0, 8)}</h1>
      <p className="subtitle">
        {task.state} · {task.fire_at_local}（{task.timezone_id}）
      </p>
      <div className="panel">
        <dl>
          <dt className="muted">登记回执</dt>
          <dd>{task.schedule_receipt ?? "无（未确认调度成功）"}</dd>
          <dt className="muted">状态版本</dt>
          <dd>{task.state_version}</dd>
          <dt className="muted">创建时间</dt>
          <dd>{task.created_at}</dd>
          {task.recreated_from ? (
            <>
              <dt className="muted">重约自</dt>
              <dd>{task.recreated_from}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <CancelAction
        taskId={task.task_id}
        state={task.state}
        csrfToken={meResult.ok ? meResult.data.csrf_token : null}
      />
      <h2>事件账</h2>
      {events.length === 0 ? (
        <p className="muted">还没有记录到事件。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>记录时间（UTC）</th>
              <th>证据</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.event_id}>
                <td>{event.type}</td>
                <td>{event.recorded_at_utc}</td>
                <td>{event.evidence_ref || "服务端记录"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
