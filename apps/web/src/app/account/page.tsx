import AccountScreen from '@/features/account/view/AccountScreen';
import { loadAccountScreen } from '@/features/account/viewmodel/account-screen';
import type { PageQuery } from '@/shared/session/navigation';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  return (
    <AccountScreen
      state={await loadAccountScreen('account', query.returnTo)}
      requestedSection={query.section}
    />
  );
}
