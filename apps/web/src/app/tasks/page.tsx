import type { PageQuery } from '@/shared/session/navigation';
import { RemindersScreen } from '@/features/reminders/view/reminders-screen';

export const dynamic = 'force-dynamic';

export default async function TasksPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  return <RemindersScreen query={await searchParams} />;
}
