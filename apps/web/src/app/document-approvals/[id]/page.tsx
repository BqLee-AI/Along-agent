import { DocumentApprovalDetailSchema } from '@along/contracts';
import { apiGet } from '@/lib/api';
import { MeSchema } from '@/lib/types';
import { PageHeading, ErrorNotice } from '@/components/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import DocumentApproval from '@/features/approvals/DocumentApproval';

export const dynamic = 'force-dynamic';

export default async function DocumentApprovalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const returnTo = `/document-approvals/${encodeURIComponent(id)}`;
  const [result, identity] = await Promise.all([
    apiGet<unknown>(`/api/v1/document-approvals/${encodeURIComponent(id)}`, returnTo),
    apiGet<unknown>('/api/v1/me', returnTo),
  ]);
  const parsed = result.ok ? DocumentApprovalDetailSchema.safeParse(result.data) : null;
  if (!result.ok || !parsed?.success || parsed.data.approval_id !== id)
    return (
      <section className="space-y-8">
        <PageHeading title="文档批准" />
        <ErrorNotice message={!result.ok ? result.message : '冻结文档正文无法核验，因此不能批准。'}>
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<a href={returnTo} />}
          >
            重新读取原批准全文
          </Button>
          <Button
            variant="clear"
            color="default"
            role="link"
            nativeButton={false}
            render={<a href="/conversations" />}
          >
            返回会话历史
          </Button>
        </ErrorNotice>
      </section>
    );
  const me = identity.ok ? MeSchema.safeParse(identity.data) : null;
  return (
    <DocumentApproval
      key={`${parsed.data.approval_id}:${parsed.data.presentation_hash}:${me?.success ? me.data.user.id : 'unverified'}`}
      detail={parsed.data}
      me={me?.success ? me.data : null}
      identityError={!identity.ok ? identity.message : !me?.success ? '身份响应无法核验。' : null}
    />
  );
}
