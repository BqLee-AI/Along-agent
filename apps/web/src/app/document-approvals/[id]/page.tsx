import { DocumentApprovalDetailSchema } from '@along/contracts';
import { apiGet } from '../../../lib/api';
import { MeSchema } from '../../../lib/types';
import { conversationHref } from '../../../lib/conversation-run';
import { documentEffectLabel } from '../../../lib/document-loop';
import DocumentActions from './DocumentActions';
import { pageReturnTo, type PageQuery } from '../../../lib/account-navigation';

export const dynamic = 'force-dynamic';
const exactTextStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

export default async function DocumentApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageQuery>;
}) {
  const { id } = await params;
  const returnTo = pageReturnTo(
    `/document-approvals/${encodeURIComponent(id)}`,
    await searchParams,
  );
  const [detailResult, meResult] = await Promise.all([
    apiGet<unknown>(`/api/v1/document-approvals/${encodeURIComponent(id)}`, returnTo),
    apiGet<unknown>('/api/v1/me', returnTo),
  ]);
  if (!detailResult.ok)
    return (
      <section>
        <h1>文档批准</h1>
        <p className="error" role="alert">
          {detailResult.message}
        </p>
      </section>
    );
  if (!meResult.ok)
    return (
      <section>
        <h1>文档批准</h1>
        <p className="error" role="alert">
          {meResult.message}
        </p>
      </section>
    );
  const detail = DocumentApprovalDetailSchema.parse(detailResult.data);
  const me = meResult.ok ? MeSchema.safeParse(meResult.data) : null;
  return (
    <section>
      <h1>批准文档精确替换</h1>
      <p className="subtitle">
        批准状态：{detail.state}。确认只授权，不写入文件；实际文件结果以下方执行证据为准。
      </p>
      <div className="panel">
        <dl>
          <dt>工作区</dt>
          <dd>{detail.workspace_id}</dd>
          <dt>相对目标</dt>
          <dd>{detail.relative_path}</dd>
          <dt>原 Run</dt>
          <dd>{detail.run_id}</dd>
          <dt>基线版本（SHA-256）</dt>
          <dd style={exactTextStyle}>{detail.base_version}</dd>
          <dt>目标版本（SHA-256）</dt>
          <dd style={exactTextStyle}>{detail.new_version}</dd>
          <dt>冻结展示模板</dt>
          <dd>{detail.presentation_version}</dd>
        </dl>
        <p>以下是服务端冻结的完整内容，保留空格与换行，不以模型摘要代替。</p>
        <h2>替换前（完整基线）</h2>
        <pre className="echo" style={exactTextStyle}>
          {detail.preview.before}
        </pre>
        <h2>替换后（完整预览）</h2>
        <pre className="echo" style={exactTextStyle}>
          {detail.preview.after}
        </pre>
        <h2>实际将写入的完整目标</h2>
        <pre className="echo" style={exactTextStyle}>
          {detail.exact_new_content}
        </pre>
        <h2>冻结批准正文</h2>
        <pre className="echo" style={exactTextStyle}>
          {detail.preview.body}
        </pre>
      </div>
      <div className="panel" aria-label="文件执行证据">
        <h2>授权与执行结果</h2>
        <p role="status">{documentEffectLabel[detail.effect.status]}</p>
        {detail.effect.apply_invocation_id ? (
          <p style={exactTextStyle}>替换调用：{detail.effect.apply_invocation_id}</p>
        ) : null}
        {detail.effect.read_invocation_id ? (
          <p style={exactTextStyle}>验证读取：{detail.effect.read_invocation_id}</p>
        ) : null}
        {detail.replaces_approval_id ? (
          <p>
            本提议替代写前冲突的前驱批准：
            <a href={`/document-approvals/${encodeURIComponent(detail.replaces_approval_id)}`}>
              查看前驱结果
            </a>
            ；旧批准不授权本次新内容。
          </p>
        ) : null}
        {detail.effect.successor_approval_id ? (
          <p>
            <a
              href={`/document-approvals/${encodeURIComponent(detail.effect.successor_approval_id)}`}
            >
              查看冲突后的新提议
            </a>
            （需要单独批准）
          </p>
        ) : null}
      </div>
      <DocumentActions key={detail.approval_id} detail={detail} me={me?.success ? me.data : null} />
      <p>
        <a href={conversationHref(detail.conversation_id, detail.run_id)}>查看原会话与原 Run</a>
      </p>
      <p className="muted">
        保留原会话标签页可继续接收事件。本页不会发送新消息、自动继续或创建新
        Run；停止不会撤销已发生的文件效果。
      </p>
    </section>
  );
}
