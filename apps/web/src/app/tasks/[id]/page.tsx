import type { PageQuery } from '@/shared/session/navigation';
import { ReminderDetailScreen } from '@/features/reminders/view/reminder-detail-screen';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageQuery>;
}) {
  return <ReminderDetailScreen id={(await params).id} query={await searchParams} />;
}
