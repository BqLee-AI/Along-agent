import WorkspaceLink from '@/shell/view/workspace-link';
import { PageHeading, ErrorNotice } from '@/shared/ui/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { readReminderApproval } from '../model/approvals.server';
import ReminderApproval from './ReminderApproval';
import type { PageQuery } from '@/shared/session/navigation';

export default async function ReminderApprovalScreen({
  id,
  query,
}: {
  id: string;
  query: PageQuery;
}) {
  const data = await readReminderApproval(id, query);
  if (!data.detail)
    return (
      <section className="min-w-0 space-y-6">
        <PageHeading
          eyebrow="提醒审阅"
          title="暂时无法核验这条提议"
          description="原内容与决议需要从服务端重新读取。读取失败不会创建、取消或修改提醒。"
        />
        <ErrorNotice message={data.error ?? '冻结确认内容无法核验，未开放任何决议操作。'}>
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<WorkspaceLink href={data.returnTo} />}
          >
            重新读取原提议
          </Button>
          <Button
            variant="clear"
            color="default"
            role="link"
            nativeButton={false}
            render={<WorkspaceLink href="/approvals" />}
          >
            返回提醒确认
          </Button>
        </ErrorNotice>
      </section>
    );
  return (
    <ReminderApproval
      key={`${data.detail.approval_id}:${data.detail.presentation_hash}:${data.me?.user.id ?? 'unverified'}`}
      initial={data.detail}
      me={data.me}
      identityError={data.identityError}
    />
  );
}
