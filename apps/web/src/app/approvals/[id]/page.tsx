import { ApprovalDetailSchema } from '@along/contracts';
import { apiGet } from '@/lib/api';
import { MeSchema } from '@/lib/types';
import { PageHeading, ErrorNotice } from '@/components/page';
import { Button } from '@/components/ui/button';
import ReminderApproval from '@/features/approvals/ReminderApproval';

export const dynamic = 'force-dynamic';

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const returnTo = `/approvals/${encodeURIComponent(id)}`;
  const [result, identity] = await Promise.all([
    apiGet<unknown>(`/api/v1/approvals/${encodeURIComponent(id)}`, returnTo),
    apiGet<unknown>('/api/v1/me', returnTo),
  ]);
  const parsed = result.ok ? ApprovalDetailSchema.safeParse(result.data) : null;
  if (!result.ok || !parsed?.success || parsed.data.approval_id !== id)
    return (
      <section className="space-y-8">
        <PageHeading title="提醒确认" />
        <ErrorNotice
          message={!result.ok ? result.message : '冻结确认内容无法核验，未开放任何决议操作。'}
        >
          <Button asChild variant="outline">
            <a href={returnTo}>重新读取原提议</a>
          </Button>
          <Button asChild variant="ghost">
            <a href="/approvals">返回提醒确认</a>
          </Button>
        </ErrorNotice>
      </section>
    );
  const me = identity.ok ? MeSchema.safeParse(identity.data) : null;
  return (
    <ReminderApproval
      key={`${parsed.data.approval_id}:${parsed.data.presentation_hash}:${me?.success ? me.data.user.id : 'unverified'}`}
      initial={parsed.data}
      me={me?.success ? me.data : null}
      identityError={!identity.ok ? identity.message : !me?.success ? '身份响应无法核验。' : null}
    />
  );
}
