import ReminderApprovalScreen from '@/features/approvals/view/reminder-approval-screen';
import type { PageQuery } from '@/shared/session/navigation';

export const dynamic = 'force-dynamic';

export default async function ApprovalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageQuery>;
}) {
  const { id } = await params;
  return <ReminderApprovalScreen id={id} query={await searchParams} />;
}
