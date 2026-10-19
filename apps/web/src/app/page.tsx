import Link from "next/link";
import { apiGet } from "../lib/api";
import { describeCard } from "../lib/presentation";
import type { Brief } from "../lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const result = await apiGet<Brief>("/api/v1/brief");
  if (!result.ok) {
    return (
      <section>
        <h1>今日</h1>
        <p className="error">{result.message}</p>
      </section>
    );
  }
  const brief = result.data;
  return (
    <section>
      <h1>今日简报</h1>
      <p className="subtitle">
        {brief.date} · {brief.timezone_id} · 待确认 {brief.summary.pending_count} · 已记录触发{" "}
        {brief.summary.fired_count}
      </p>
      {brief.meta.timezone_note ? <p className="muted">{brief.meta.timezone_note}</p> : null}
      {brief.meta.brief_state === "stale" ? (
        <p className="error">
          简报可能过期，请 <Link href="/">刷新</Link> 重试。
        </p>
      ) : null}
      {brief.cards.length === 0 ? (
        <div className="panel">
          <p>今天没有需要处理的事项。</p>
          <p className="muted">你可以去对话页记录一条提醒。</p>
        </div>
      ) : (
        <ul className="card-list">
          {brief.cards.map((card) => {
            const view = describeCard(card);
            return (
              <li className="card" key={card.card_id}>
                <div>
                  {view.href ? <Link href={view.href}>{view.title}</Link> : view.title}
                  {view.status ? <span className="badge">{view.status}</span> : null}
                  {view.warning ? <p className="muted">{view.warning}</p> : null}
                </div>
                {view.time ? <span className="time">{view.time}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
