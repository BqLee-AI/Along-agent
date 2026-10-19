import Link from 'next/link';
import { apiGet } from '../../lib/api';
import type { ApprovalListItem } from '../../lib/types';

export const dynamic = 'force-dynamic';

interface Page {
  items: ApprovalListItem[];
  next_cursor: string | null;
}

export default async function ApprovalsPage() {
  const result = await apiGet<Page>('/api/v1/approvals?limit=50');
  if (!result.ok) {
    return (
      <section>
        <h1>确认</h1>
        <p className="error">{result.message}</p>
      </section>
    );
  }
  return (
    <section>
      <h1>待确认</h1>
      <p className="subtitle">确认前不会创建提醒，也不会排期。</p>
      {result.data.items.length === 0 ? (
        <div className="panel">没有待确认的提议。</div>
      ) : (
        <ul className="card-list">
          {result.data.items.map((item) => (
            <li className="card" key={item.approval_id}>
              <div>
                <Link href={`/approvals/${item.approval_id}`}>{item.title}</Link>
                <span className="badge">{item.status}</span>
              </div>
              <span className="time">{item.expires_at}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
