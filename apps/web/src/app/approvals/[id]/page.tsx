import { apiGet } from '../../../lib/api';
import { describeApproval } from '../../../lib/presentation';
import { ApprovalDetailSchema } from '@along/contracts';
import { MeSchema } from '../../../lib/types';
import ApprovalActions from './ApprovalActions';
import { pageReturnTo } from '../../../lib/account-navigation';
import { conversationHref } from '../../../lib/conversation-run';

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
  const returnTo = pageReturnTo(`/approvals/${encodeURIComponent(id)}`, query);
  const [detailResult, meResult] = await Promise.all([
    apiGet<unknown>(`/api/v1/approvals/${encodeURIComponent(id)}`, returnTo),
    apiGet<unknown>('/api/v1/me', returnTo),
  ]);
  if (!detailResult.ok) {
    return (
      <section>
        <h1>确认</h1>
        <p className="error">{detailResult.message}</p>
        <a href={returnTo}>重试读取原批准（GET）</a>
      </section>
    );
  }
  const detail = ApprovalDetailSchema.parse(detailResult.data);
  const me = meResult.ok ? MeSchema.safeParse(meResult.data) : null;
  const view = describeApproval(detail);
  const actionable = detail.status === 'pending';
  return (
    <section className="conversation-history">
      <h1>{detail.kind === 'cancel_task' ? '取消确认' : '确认提醒'}</h1>
      {!meResult.ok ? (
        <p className="error" role="alert">
          批准详情已获取，但当前动作身份未核验：{meResult.message}。
          <a href={returnTo}>重试读取身份（GET）</a>
        </p>
      ) : null}
      <p className="subtitle">
        状态 {detail.status} ·{' '}
        {actionable
          ? `确认有效期 24 小时 · 剩余约 ${view.remainingLabel}（服务端计算）`
          : '此确认已处理，不可再操作'}
      </p>
      <div className="panel">
        <dl>
          <dt className="muted">你的原话</dt>
          <dd className="echo">{view.originalText}</dd>
          <dt className="muted">归一后的本地时间</dt>
          <dd>
            {view.localTime}（{view.timezone}）
          </dd>
          <dt className="muted">展示模板</dt>
          <dd>{detail.presentation_version}</dd>
        </dl>
        <div className="echo">{view.echo}</div>
      </div>
      <div className="panel">
        <h2>已存决议的真实结果</h2>
        {detail.result.task_id ? (
          <p>
            <a href={`/tasks/${encodeURIComponent(detail.result.task_id)}`}>查看真实提醒结果</a>
            （提醒调度状态不代表资料 Run 状态）
          </p>
        ) : (
          <p>此批准当前没有真实提醒结果引用；不表示已创建或已调度。</p>
        )}
        {detail.result.successor_approval_id ? (
          <p>
            <a
              href={`/approvals/${encodeURIComponent(detail.result.successor_approval_id)}?${new URLSearchParams({ ...(query.conversation_id ? { conversation_id: query.conversation_id } : {}), ...(query.run_id ? { run_id: query.run_id } : {}) })}`}
            >
              查看实际后继提议
            </a>
          </p>
        ) : null}
        {detail.recreated_from ? (
          <p>
            <a href={`/approvals/${encodeURIComponent(detail.recreated_from)}`}>查看前驱提议</a>
          </p>
        ) : null}
        <a href={returnTo}>刷新批准与结果（GET）</a>
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
      {query.conversation_id ? (
        <p>
          <a
            href={
              query.run_id
                ? conversationHref(query.conversation_id, query.run_id)
                : `/conversations?${new URLSearchParams({ conversation_id: query.conversation_id })}`
            }
          >
            查看原会话{query.run_id ? '与原 Run' : ''}
          </a>
        </p>
      ) : null}
    </section>
  );
}
