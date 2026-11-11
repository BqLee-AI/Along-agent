import AccountScreen from '@/features/account/view/AccountScreen';
import { loadAccountScreen } from '@/features/account/viewmodel/account-screen';
import type { PageQuery } from '@/shared/session/navigation';

export const dynamic = 'force-dynamic';

export default async function SetupPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  return <AccountScreen state={await loadAccountScreen('setup', query.returnTo)} />;
}
