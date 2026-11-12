import type { PageQuery } from '@/shared/session/navigation';
import ApprovalsScreen from '@/features/approvals/view/approvals-screen';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<PageQuery>;
}) {
  return <ApprovalsScreen query={await searchParams} />;
}
