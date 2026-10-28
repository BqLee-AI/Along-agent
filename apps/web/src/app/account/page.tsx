import AccountScreen from '@/features/account/AccountScreen';
import type { PageQuery } from '../../lib/account-navigation';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  return <AccountScreen view="account" returnTo={query.returnTo} />;
}
