import WorkspaceLink from '@/shell/view/workspace-link';
import { PageHeading, ErrorNotice } from '@/shared/ui/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { readDocumentApproval } from '../model/approvals.server';
import DocumentApproval from './DocumentApproval';
import type { PageQuery } from '@/shared/session/navigation';

export default async function DocumentApprovalScreen({
  id,
  query,
}: {
  id: string;
  query: PageQuery;
}) {
  const data = await readDocumentApproval(id, query);
  if (!data.detail)
    return (
      <section className="min-w-0 space-y-6">
        <PageHeading
          eyebrow="文档审阅"
          title="暂时无法核验冻结全文"
          description="本页没有提交决议或写入文件。重新读取原批准后，再审阅完整内容。"
        />
        <ErrorNotice message={data.error ?? '冻结文档正文无法核验，因此不能批准。'}>
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<WorkspaceLink href={data.returnTo} />}
          >
            重新读取原批准全文
          </Button>
          <Button
            variant="clear"
            color="default"
            role="link"
            nativeButton={false}
            render={<WorkspaceLink href="/conversations" />}
          >
            返回会话历史
          </Button>
        </ErrorNotice>
      </section>
    );
  return (
    <DocumentApproval
      key={`${data.detail.approval_id}:${data.detail.presentation_hash}:${data.me?.user.id ?? 'unverified'}`}
      detail={data.detail}
      me={data.me}
      identityError={data.identityError}
    />
  );
}
