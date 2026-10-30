import { apiGet } from '@/lib/api';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { PageHeading } from '@/components/page';
import { ApprovalStatusFilter } from '@/features/approvals/ApprovalStatusFilter';
import ApprovalList from '@/features/approvals/ApprovalList';
import { ApprovalPageSchema, approvalFilter, approvalListPath } from '@/features/approvals/model';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<PageQuery>;
}) {
  const query = await searchParams;
  const status = approvalFilter(query.status);
  const result = await apiGet<unknown>(approvalListPath(status), pageReturnTo('/approvals', query));
  const parsed = result.ok ? ApprovalPageSchema.safeParse(result.data) : null;
  return (
    <section className="space-y-8">
      <PageHeading
        title="提醒确认"
        description="这里是提醒创建与取消提议。确认前不创建提醒、不排期；文档批准请从原会话的“修改与结果”进入。"
      />
      <ApprovalStatusFilter key={status} status={status} />
      <ApprovalList
        key={status}
        status={status}
        initial={parsed?.success ? parsed.data : null}
        initialError={
          !result.ok
            ? result.message
            : parsed && !parsed.success
              ? '提醒确认响应无法核验，未将错误当作空列表。'
              : null
        }
      />
    </section>
  );
}
