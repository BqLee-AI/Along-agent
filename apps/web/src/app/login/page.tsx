import AccountScreen from '../account/AccountScreen';
import type { PageQuery } from '../../lib/account-navigation';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const query = await searchParams;
  return <AccountScreen view="login" returnTo={query.returnTo} />;
}
