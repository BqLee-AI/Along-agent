import DocumentApprovalScreen from '@/features/approvals/view/document-approval-screen';
import type { PageQuery } from '@/shared/session/navigation';

export const dynamic = 'force-dynamic';

export default async function DocumentApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageQuery>;
}) {
  const { id } = await params;
  return <DocumentApprovalScreen id={id} query={await searchParams} />;
}
