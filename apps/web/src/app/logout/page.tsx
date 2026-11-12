import AccountScreen from '@/features/account/view/AccountScreen';
import { loadAccountScreen } from '@/features/account/viewmodel/account-screen';

export const dynamic = 'force-dynamic';

export default async function LogoutPage() {
  return <AccountScreen state={await loadAccountScreen('logout')} />;
}
