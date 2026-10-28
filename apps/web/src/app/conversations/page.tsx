import { z } from 'zod';
import HistoryList from './HistoryList';
import HistoryDetail from './HistoryDetail';
import type { PageQuery } from '../../lib/account-navigation';

export const dynamic = 'force-dynamic';

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<PageQuery>;
}) {
  const query = await searchParams;
  if (query.conversation_id === undefined && query.run_id === undefined) return <HistoryList />;
  const identity = z
    .object({ conversation_id: z.string().uuid(), run_id: z.string().uuid().optional() })
    .safeParse(query);
  if (!identity.success) {
    return (
      <section className="conversation-history">
        <h1>会话历史</h1>
        <p className="error" role="alert">
          会话 / Run 地址无效，未读取或执行任何操作。
        </p>
        <a href="/conversations">返回会话列表</a>
      </section>
    );
  }
  const { conversation_id: conversationId, run_id: runId } = identity.data;
  return (
    <HistoryDetail
      key={`${conversationId}:${runId ?? ''}`}
      conversationId={conversationId}
      runId={runId ?? null}
    />
  );
}
