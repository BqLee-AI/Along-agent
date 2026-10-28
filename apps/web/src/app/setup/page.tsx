import AccountScreen from '@/features/account/AccountScreen';
import type { PageQuery } from '../../lib/account-navigation';

export const dynamic = 'force-dynamic';

export default async function SetupPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  return <AccountScreen view="setup" returnTo={query.returnTo} />;
}
