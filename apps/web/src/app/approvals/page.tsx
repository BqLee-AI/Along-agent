import { apiGet } from '@/lib/api';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { PageHeading } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import ApprovalList from '@/features/approvals/ApprovalList';
import {
  ApprovalPageSchema,
  approvalFilter,
  approvalListPath,
  approvalStatusLabels,
} from '@/features/approvals/model';

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
      <form className="flex flex-wrap items-end gap-3" method="GET">
        <div className="grid gap-2">
          <Label htmlFor="approval-status">提议状态</Label>
          <select
            id="approval-status"
            name="status"
            defaultValue={status}
            className="h-11 rounded-lg border border-input bg-card px-3 text-base"
          >
            {Object.entries(approvalStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="outline" type="submit">
          查看此状态
        </Button>
      </form>
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
