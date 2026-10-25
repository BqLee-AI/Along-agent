import Chat from './Chat';

export const dynamic = 'force-dynamic';

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation_id?: string; run_id?: string }>;
}) {
  const query = await searchParams;
  return (
    <Chat
      key={`${query.conversation_id ?? ''}:${query.run_id ?? ''}`}
      conversationId={query.conversation_id}
      runId={query.run_id}
    />
  );
}
