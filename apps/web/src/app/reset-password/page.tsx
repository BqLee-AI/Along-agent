import AccountLink from '@/features/account/AccountLink';
export const dynamic = 'force-dynamic';
export const metadata = {
  referrer: 'no-referrer' as const,
  robots: { index: false, follow: false },
};
export default function ResetPasswordPage() {
  return <AccountLink purpose="reset" />;
}
