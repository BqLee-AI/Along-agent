import { apiGet } from '../../../lib/api';
import { describeApproval } from '../../../lib/presentation';
import { ApprovalDetailSchema, MeSchema } from '../../../lib/types';
import ApprovalActions from './ApprovalActions';

export const dynamic = 'force-dynamic';

export default async function ApprovalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ conversation_id?: string; run_id?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const [detailResult, meResult] = await Promise.all([
    apiGet<unknown>(`/api/v1/approvals/${id}`),
    apiGet<unknown>('/api/v1/me'),
  ]);
  if (!detailResult.ok) {
    return (
      <section>
        <h1>确认</h1>
        <p className="error">{detailResult.message}</p>
      </section>
    );
  }
  const detail = ApprovalDetailSchema.parse(detailResult.data);
  const me = meResult.ok ? MeSchema.safeParse(meResult.data) : null;
  const view = describeApproval(detail);
  const actionable = detail.status === 'pending';
  return (
    <section>
      <h1>{detail.kind === 'cancel_task' ? '取消确认' : '确认提醒'}</h1>
      <p className="subtitle">
        状态 {detail.status} ·{' '}
        {actionable
          ? `确认有效期 24 小时 · 剩余约 ${view.remainingLabel}（服务端计算）`
          : '此确认已处理，不可再操作'}
      </p>
      <div className="panel">
        <dl>
          <dt className="muted">你的原话</dt>
          <dd>{view.originalText}</dd>
          <dt className="muted">归一后的本地时间</dt>
          <dd>
            {view.localTime}（{view.timezone}）
          </dd>
          <dt className="muted">展示模板</dt>
          <dd>{detail.presentation_version}</dd>
        </dl>
        <div className="echo">{view.echo}</div>
      </div>
      <ApprovalActions
        key={detail.approval_id}
        approvalId={detail.approval_id}
        presentationHash={detail.presentation_hash}
        echoText={detail.echo_text}
        kind={detail.kind}
        originalText={detail.original_text ?? ''}
        timezone={detail.snapshot.timezone_id}
        me={me?.success ? me.data : null}
        actionable={actionable}
        conversationId={query.conversation_id ?? null}
        runId={query.run_id ?? null}
      />
    </section>
  );
}
