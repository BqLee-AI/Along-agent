import { z } from 'zod';
import HistoryList from './HistoryList';
import HistoryDetail from './HistoryDetail';
import type { PageQuery } from '../../lib/account-navigation';
import { ErrorNotice, PageHeading } from '@/components/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { taskIntentFromQuery } from '@/features/conversations/task-model';

export const dynamic = 'force-dynamic';

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<PageQuery>;
}) {
  const query = await searchParams;
  if (query.conversation_id === undefined && query.run_id === undefined)
    return (
      <HistoryList
        key={typeof query.intent === 'string' ? query.intent : ''}
        initialIntent={taskIntentFromQuery(query)}
      />
    );
  const identity = z
    .object({ conversation_id: z.string().uuid(), run_id: z.string().uuid().optional() })
    .safeParse(query);
  if (!identity.success) {
    return (
      <div className="space-y-8">
        <PageHeading title="会话历史" />
        <ErrorNotice message="会话 / 运行地址无效，未读取或执行任何操作。" />
        <Button
          variant="glass"
          color="default"
          role="link"
          nativeButton={false}
          render={<a href="/conversations" />}
        >
          返回会话列表
        </Button>
      </div>
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
