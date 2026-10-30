'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { DocumentApprovalDetail } from '@along/contracts';
import { PageHeading, ErrorNotice } from '@/components/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { conversationHref, runStatusLabel as baseRunStatusLabel } from '@/lib/conversation-run';
import { documentEffectLabel } from '@/lib/document-loop';
import type { Me } from '@/lib/types';
import { useDocumentApproval } from './useDocumentApproval';

const decisionLabel = { pending: '等待审阅', approved: '已授权', rejected: '已拒绝' };
const runStatusLabel = {
  ...baseRunStatusLabel,
  suspended_approval: '原运行已挂起；是否可继续以当前资格为准，不代表本批准仍未决。',
};
const textClass =
  'min-w-0 whitespace-pre-wrap font-mono text-base leading-7 [overflow-wrap:anywhere]';

export default function DocumentApproval({
  detail,
  me,
  identityError,
}: {
  detail: DocumentApprovalDetail;
  me: Me | null;
  identityError: string | null;
}) {
  const state = useDocumentApproval(detail, me);
  const errorSummary = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.error) errorSummary.current?.focus();
  }, [state.error]);
  const effect = state.effect.value;
  const disabled =
    !me ||
    state.busy !== null ||
    state.decisionReading ||
    state.blocked ||
    state.uncertain !== null;
  const originalHref = conversationHref(detail.conversation_id, detail.run_id);
  return (
    <section className="min-w-0 space-y-8 [overflow-wrap:anywhere]">
      <Button
        variant="clear"
        color="default"
        role="link"
        nativeButton={false}
        render={<Link href={originalHref} />}
      >
        查看原会话与原运行（只读）
      </Button>
      <PageHeading
        eyebrow="文档批准 · 全页校样"
        title={`审阅对 ${detail.relative_path} 的修改`}
        description="批准只授权本次冻结版本，本页零文件写入、不自动继续运行。请保留原会话标签页，以免中断原执行连接。"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="glass">{decisionLabel[state.decision]}</Badge>
        <span className="text-sm text-muted-foreground">
          决议、文件效果与运行状态分别读取，不视为同一快照。
        </span>
      </div>
      {identityError ? (
        <ErrorNotice message={`全文已获取，但动作身份未核验：${identityError}`}>
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<a href={`/document-approvals/${encodeURIComponent(detail.approval_id)}`} />}
          >
            重新读取身份与全文
          </Button>
        </ErrorNotice>
      ) : null}
      <nav
        aria-label="审阅章节"
        className="flex flex-wrap gap-x-6 gap-y-2 border-y border-border py-3 text-sm text-primary"
      >
        {[
          ['change', '改动对照'],
          ['target', '完整目标'],
          ['frozen', '批准正文'],
          ['evidence', '授权与执行证据'],
        ].map(([id, label]) => (
          <a
            key={id}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
            href={`#${id}`}
          >
            {label}
          </a>
        ))}
      </nav>
      <article className="min-w-0 space-y-8 p-4 sm:p-8">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">目标与冻结版本</h2>
          <dl className="grid min-w-0 gap-4">
            <div>
              <dt className="text-sm text-muted-foreground">相对目标（完整）</dt>
              <dd className="font-mono leading-7">{detail.relative_path}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">工作区标识</dt>
              <dd className="font-mono">{detail.workspace_id}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">完整基线 SHA-256</dt>
              <dd className="font-mono">{detail.base_version}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">完整目标 SHA-256</dt>
              <dd className="font-mono">{detail.new_version}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">展示模板</dt>
              <dd>{detail.presentation_version}</dd>
            </div>
          </dl>
        </section>
        <section id="change" className="scroll-mt-24 space-y-6 border-t border-border pt-8">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">
              <span className="mr-3 text-primary">01</span>改动对照
            </h2>
            <p className="text-sm text-muted-foreground">
              下面是服务端冻结的完整替换前后内容，仅作对照展示，不是可重新执行的补丁。
            </p>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium">替换前 · 移除的完整基线</h3>
            <pre className={`${textClass} p-4`}>{detail.preview.before}</pre>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium">替换后 · 新增的完整预览</h3>
            <pre className={`${textClass} p-4`}>{detail.preview.after}</pre>
          </div>
        </section>
        <section id="target" className="scroll-mt-24 space-y-4 border-t border-border pt-8">
          <h2 className="text-lg font-semibold">
            <span className="mr-3 text-primary">02</span>实际将写入的完整目标
          </h2>
          <pre className={textClass}>{detail.exact_new_content}</pre>
        </section>
        <section id="frozen" className="scroll-mt-24 space-y-4 border-t border-border pt-8">
          <h2 className="text-lg font-semibold">
            <span className="mr-3 text-primary">03</span>本次冻结批准正文
          </h2>
          <p className="text-sm text-muted-foreground">
            保留全部空格和换行。提交只取服务端原始
            preview.body，不从此页面排版、摘要或对照重建内容。
          </p>
          <pre className={textClass}>{detail.preview.body}</pre>
        </section>
        <section id="evidence" className="scroll-mt-24 space-y-6 border-t border-border pt-8">
          <h2 className="text-lg font-semibold">
            <span className="mr-3 text-primary">04</span>授权与执行证据
          </h2>
          <div className="space-y-3" aria-busy={state.decisionReading}>
            <h3 className="font-medium">独立授权决议</h3>
            <p role="status">
              {decisionLabel[state.decision]}
              {state.decision === 'approved' ? ' · 此授权不等于保存或整个运行成功。' : ''}
            </p>
            {state.decisionError ? (
              <ErrorNotice message={state.decisionError}>
                <p>上方仅为先前接收的决议，不代表最新状态读取成功。</p>
              </ErrorNotice>
            ) : null}
            <Button
              variant="glass"
              color="default"
              disabled={state.decisionReading || state.busy !== null}
              onClick={() => void state.refresh('decision')}
            >
              {state.decisionReading ? '正在读取授权…' : '重新读取授权决议'}
            </Button>
          </div>
          <div className="space-y-3 border-t border-border pt-6" aria-busy={state.effect.reading}>
            <h3 className="font-medium">文件效果</h3>
            {!state.effect.current ? (
              <Alert color="warning">
                <Alert.Content>
                  <Alert.Title>最新效果尚未读取</Alert.Title>
                  <Alert.Description>
                    授权事实仍保留；不把旧的尚未执行状态当作最新文件结果。
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            {effect ? (
              <div className="space-y-3">
                <p
                  role="status"
                  className={
                    state.effect.current && effect.status === 'verified'
                      ? 'font-medium text-foreground'
                      : ''
                  }
                >
                  {state.effect.current ? '' : '上次获取的证据（不是最新结果）：'}
                  {documentEffectLabel[effect.status]}
                </p>
                {effect.status === 'unknown' ? (
                  <Alert color="warning">
                    <Alert.Content>
                      <Alert.Title>可能已写入，原动作结果未知</Alert.Title>
                      <Alert.Description>
                        原动作不能安全重做。只读取原运行、原效果或联系本机维护者核对，不重发、覆盖或另开同目标写入。
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
                {effect.status === 'conflict' ? (
                  <Alert color="warning">
                    <Alert.Content>
                      <Alert.Title>原版本写前冲突，此次未写入</Alert.Title>
                      <Alert.Description>
                        旧授权不覆盖新内容；只有真实后继才可重新审阅。本页不提供覆盖写入。
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            ) : null}
            {state.effect.error ? <ErrorNotice message={state.effect.error} /> : null}
            <Button
              variant="glass"
              color="default"
              disabled={state.effect.reading || state.busy !== null}
              onClick={() => void state.refresh('effect')}
            >
              {state.effect.reading ? '正在读取效果…' : '重新读取文件效果'}
            </Button>
          </div>
          <div className="space-y-3 border-t border-border pt-6" aria-busy={state.runReading}>
            <h3 className="font-medium">原运行（独立读取）</h3>
            <p role="status">
              {state.run
                ? runStatusLabel[state.run.status]
                : '原运行状态尚未读取；不会从授权或文件效果推断整次运行成功。'}
            </p>
            {state.run && !state.run.can_resume && state.run.status !== 'cancelled' ? (
              <p className="text-sm text-muted-foreground">
                当前不可继续；具体原因不能仅凭此字段推断。请在原运行读取当前资格，不将已授权误报为尚未批准。
              </p>
            ) : null}
            {state.run?.status === 'cancelled' ? (
              <Alert>
                <Alert.Content>
                  <Alert.Title>原运行已停止</Alert.Title>
                  <Alert.Description>
                    停止不会撤回已发生的文件效果；先前获取的效果仍在上方独立保留。
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            {state.runError ? <ErrorNotice message={state.runError} /> : null}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="glass"
                color="default"
                disabled={state.runReading}
                onClick={() => void state.refresh('run')}
              >
                {state.runReading ? '正在读取原运行…' : '读取原运行状态'}
              </Button>
              <Button
                variant="clear"
                color="default"
                role="link"
                nativeButton={false}
                render={<Link href={originalHref} />}
              >
                查看原运行
              </Button>
            </div>
          </div>
          {detail.replaces_approval_id ? (
            <p>
              <Link
                className="text-primary underline underline-offset-4"
                href={`/document-approvals/${encodeURIComponent(detail.replaces_approval_id)}`}
              >
                查看写前冲突的前驱批准
              </Link>{' '}
              · 前驱不授权本次新内容。
            </p>
          ) : null}
          {effect?.successor_approval_id ? (
            <p>
              <Link
                className="text-primary underline underline-offset-4"
                href={`/document-approvals/${encodeURIComponent(effect.successor_approval_id)}`}
              >
                审阅冲突后的实际后继（需要单独批准）
              </Link>
            </p>
          ) : null}
          <details className="border-t border-border pt-4">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
              完整技术引用
            </summary>
            <dl className="mt-3 space-y-4 font-mono text-sm">
              <div>
                <dt className="font-sans text-muted-foreground">冻结展示校验值</dt>
                <dd>{detail.presentation_hash}</dd>
              </div>
              <div>
                <dt className="font-sans text-muted-foreground">基线读取调用</dt>
                <dd>{detail.base_read_invocation_id}</dd>
              </div>
              <div>
                <dt className="font-sans text-muted-foreground">批准 / 原 Run / 原会话</dt>
                <dd>
                  {detail.approval_id}
                  <br />
                  {detail.run_id}
                  <br />
                  {detail.conversation_id}
                </dd>
              </div>
              <div>
                <dt className="font-sans text-muted-foreground">替换调用（上次获取）</dt>
                <dd>{effect?.apply_invocation_id ?? '尚无读取引用'}</dd>
              </div>
              <div>
                <dt className="font-sans text-muted-foreground">后续全文核对调用（上次获取）</dt>
                <dd>{effect?.read_invocation_id ?? '尚无读取引用'}</dd>
              </div>
            </dl>
          </details>
        </section>
      </article>
      {state.notice ? (
        <Alert>
          <Alert.Content>
            <Alert.Title>
              {state.decision === 'approved' ? '已授权，不代表已保存' : '已拒绝'}
            </Alert.Title>
            <Alert.Description>
              <p role="status">{state.notice}</p>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {state.error ? (
        <div ref={errorSummary} tabIndex={-1}>
          <ErrorNotice message={state.error}>
            <p>保留全文与已接受事实。响应未知时先读取授权，不自动补发决议，不换请求键。</p>
            {state.uncertain && state.decisionChecked && state.decision === 'pending' ? (
              <Button
                variant="glass"
                color="default"
                disabled={state.busy !== null || state.decisionReading}
                onClick={() => void state.decide(state.uncertain!, true)}
              >
                以原请求键显式核对同一决议
              </Button>
            ) : null}
          </ErrorNotice>
        </div>
      ) : null}
      <footer className="space-y-4 border-t border-border pt-6">
        <p className="font-medium">
          只批准上方冻结版本。本页批准零文件写入；实际保存还需回到原运行读取资格并明确继续。
        </p>
        {state.decision === 'pending' ? (
          <div className="flex flex-wrap gap-4">
            <Button disabled={disabled} onClick={() => void state.decide('confirm')}>
              {state.busy === 'confirm' ? '正在批准此版本…' : '批准此版本（仅授权）'}
            </Button>
            <Button
              variant="glass"
              color="default"
              disabled={disabled}
              onClick={() => void state.decide('reject')}
            >
              {state.busy === 'reject' ? '正在拒绝…' : '拒绝本次修改'}
            </Button>
          </div>
        ) : null}
        {!me && state.decision === 'pending' ? (
          <p className="text-sm text-muted-foreground">
            当前身份未核验，批准与拒绝禁用；重新登录后只读取原事实，不补发 POST。
          </p>
        ) : null}
        {state.blocked ? (
          <p className="text-sm text-muted-foreground">
            当前动作无效或不具备权限，请重新读取授权和原运行；不重做旧决议。
          </p>
        ) : null}
        <Button
          variant={state.decision === 'pending' ? 'glass' : 'solid'}
          color={state.decision === 'pending' ? 'default' : 'primary'}
          role="link"
          nativeButton={false}
          render={<Link href={originalHref} />}
        >
          查看原运行（不自动继续）
        </Button>
        <p className="text-sm text-muted-foreground">
          返回链接来自此详情可信的会话与 Run 引用。保留原标签页接收事件；本页不会自动
          resume、关闭原流、创建新消息或新 Run。
        </p>
      </footer>
    </section>
  );
}
