import AccountLinkPage from '@/features/account/view/AccountLinkPage';

export const dynamic = 'force-dynamic';
export const metadata = {
  referrer: 'no-referrer' as const,
  robots: { index: false, follow: false },
};

export default function VerifyContactPage() {
  return <AccountLinkPage purpose="contact" />;
}
