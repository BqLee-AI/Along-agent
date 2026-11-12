import type { PageQuery } from '@/shared/session/navigation';
import { ReminderActivityScreen } from '@/features/reminders/view/reminder-activity-screen';

export const dynamic = 'force-dynamic';

export default async function ActivityPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  return <ReminderActivityScreen query={await searchParams} />;
}
