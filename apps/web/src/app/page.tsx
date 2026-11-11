import type { PageQuery } from '@/shared/session/navigation';
import { TodayWorkspaceScreen } from '@/features/brief/view/today-workspace-screen';

export const dynamic = 'force-dynamic';

export default async function HomePage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  return <TodayWorkspaceScreen query={await searchParams} />;
}
