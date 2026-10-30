'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { ApprovalDetail } from '@along/contracts';
import { PageHeading, ErrorNotice } from '@/components/page';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Textarea } from '@lorelum/lumen-ui/components/textarea';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Radio } from '@lorelum/lumen-ui/components/radio';
import type { Me } from '@/lib/types';
import { describeApproval } from '@/lib/presentation';
import { approvalStatusLabels } from './model';
import { useReminderApproval } from './useReminderApproval';

export default function ReminderApproval({
  initial,
  me,
  identityError,
}: {
  initial: ApprovalDetail;
  me: Me | null;
  identityError: string | null;
}) {
  const state = useReminderApproval(initial, me);
  const { detail } = state;
  const view = describeApproval(detail);
  const editTitle = useRef<HTMLHeadingElement | null>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);
  const errorSummary = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.editing) editTitle.current?.focus();
    else if (wasEditing.current) editTrigger.current?.focus();
    wasEditing.current = state.editing;
  }, [state.editing]);
  useEffect(() => {
    if (state.error) errorSummary.current?.focus();
  }, [state.error]);
  const taskId = state.related?.task_id ?? detail.result.task_id;
  const successor = state.related?.successor_approval_id ?? detail.result.successor_approval_id;
  const disabled = !state.canAct || state.busy !== null || state.reading;
  return (
    <section className="min-w-0 space-y-8 [overflow-wrap:anywhere]">
      <Button
        variant="clear"
        color="default"
        role="link"
        nativeButton={false}
        render={<Link href="/approvals" />}
      >
        返回提醒确认
      </Button>
      <PageHeading
        eyebrow={detail.kind === 'cancel_task' ? '取消提醒提议' : '创建提醒提议'}
        title={detail.kind === 'cancel_task' ? '审阅取消提醒' : '审阅提醒内容'}
        description="核对下面的服务端冻结内容。这里不会自动继续任何运行；修改会生成需要重新确认的新提议。"
      />
      <div className="flex flex-wrap items-center gap-3" role="status">
        <Badge variant="glass">{approvalStatusLabels[detail.status]}</Badge>
        <span className="text-sm text-muted-foreground">
          有效期至 {detail.expires_at}
          {detail.status === 'pending'
            ? ` · 剩余约 ${view.remainingLabel}（服务端计算）`
            : ' · 此提议不可再操作'}
        </span>
      </div>
      {identityError ? (
        <ErrorNotice message={`冻结内容已获取，但动作身份未核验：${identityError}`}>
          <Button
            variant="glass"
            color="default"
            role="link"
            nativeButton={false}
            render={<a href={`/approvals/${encodeURIComponent(detail.approval_id)}`} />}
          >
            重新读取身份与详情
          </Button>
        </ErrorNotice>
      ) : null}
      <article className="min-w-0 space-y-8 p-4 sm:p-8">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">你的原话</h2>
          <p className="whitespace-pre-wrap leading-7">
            {detail.original_text ?? '此旧提议未保留原话。'}
          </p>
        </section>
        <dl className="grid gap-4 border-y border-border py-6 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">冻结本地时间</dt>
            <dd className="mt-1 text-base">{view.localTime}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">已确认时区</dt>
            <dd className="mt-1">{view.timezone}</dd>
          </div>
        </dl>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">本次完整冻结确认正文</h2>
          <pre className="whitespace-pre-wrap font-mono text-base leading-7">{view.echo}</pre>
        </section>
        <details className="border-t border-border pt-4">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            版本与技术引用
          </summary>
          <dl className="mt-3 grid gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">展示模板</dt>
              <dd>{detail.presentation_version}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">展示校验值</dt>
              <dd className="font-mono">{detail.presentation_hash}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">提议标识</dt>
              <dd className="font-mono">{detail.approval_id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">服务端冻结偏移与重复时刻</dt>
              <dd>
                offset_seconds={detail.snapshot.offset_seconds} · fold={detail.snapshot.fold}
              </dd>
            </div>
          </dl>
        </details>
      </article>
      <Alert>
        <Alert.Content>
          <Alert.Title>提醒的通知边界</Alert.Title>
          <Alert.Description>
            提醒保存在云端，到点在调度器成功运行时尝试通知。设备关机、休眠或进程未运行时可能错过，不保证准时响。取消决议也不代表已送通知可以撤回。
          </Alert.Description>
        </Alert.Content>
      </Alert>
      {state.editing ? (
        <form
          className="space-y-6 p-4 sm:p-8"
          aria-labelledby="revision-title"
          onSubmit={(event) => {
            event.preventDefault();
            void state.decide('revise');
          }}
        >
          <div className="space-y-2">
            <h2 id="revision-title" ref={editTitle} tabIndex={-1} className="text-lg font-semibold">
              修改这条提醒提议
            </h2>
            <p id="revision-help" className="text-sm text-muted-foreground">
              原冻结方案始终保留在上方。完整重述日期、年份、时间和内容，并明确确认时区。提交修改不会创建提醒。
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="revision-text">完整原话（必填）</Label>
            <Textarea
              id="revision-text"
              value={state.rawText}
              required
              maxLength={20000}
              rows={6}
              disabled={state.busy !== null || state.uncertain || state.blocked}
              aria-describedby={
                state.error ? 'approval-action-error revision-help' : 'revision-help'
              }
              onChange={(event) => state.changeInput('text', event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="revision-timezone">确认时区（必填，规范 ID）</Label>
            <Input
              id="revision-timezone"
              value={state.timezone}
              required
              maxLength={100}
              disabled={state.busy !== null || state.uncertain || state.blocked}
              aria-describedby="revision-timezone-help"
              onChange={(event) => state.changeInput('timezone', event.target.value)}
            />
            <p id="revision-timezone-help" className="text-sm text-muted-foreground">
              预填原提议时区，例如 Asia/Shanghai；不会用浏览器或账户时区替换。
            </p>
          </div>
          {state.ambiguity ? (
            <fieldset
              className="space-y-3 p-4"
              disabled={state.busy !== null || state.uncertain || state.blocked}
            >
              <legend id="revision-fold-label" className="font-medium">
                此本地时间出现两次，请明确选择
              </legend>
              <p className="text-sm text-muted-foreground">
                {state.ambiguity.wall_time} · {state.ambiguity.timezone_id} ·{' '}
                {state.ambiguity.ruleset_id}。选择后仍需明确提交修改。
              </p>
              <Radio.Group
                name="fold"
                value={state.fold}
                disabled={state.busy !== null || state.uncertain || state.blocked}
                aria-labelledby="revision-fold-label"
                onValueChange={(value) => {
                  if (value === 'first' || value === 'second') state.changeInput('fold', value);
                }}
              >
                {state.ambiguity.candidates.map((candidate) => (
                  <Label
                    key={candidate.fold_choice}
                    className="flex min-h-11 cursor-pointer items-start gap-3 p-3"
                  >
                    <Radio className="mt-1 shrink-0" value={candidate.fold_choice} />
                    <span>
                      {candidate.fold_choice === 'first' ? '第一次' : '第二次'} · offset_seconds=
                      {candidate.offset_seconds} · UTC={candidate.fire_at_utc}
                    </span>
                  </Label>
                ))}
              </Radio.Group>
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-4">
            <Button
              type="submit"
              disabled={
                disabled ||
                !state.rawText ||
                !state.timezone ||
                Boolean(state.ambiguity && state.fold === 'none')
              }
            >
              {state.busy === 'revise' ? '正在提交修改…' : '提交修改并审阅后继'}
            </Button>
            <Button
              type="button"
              variant="glass"
              color="default"
              disabled={state.busy !== null || state.uncertain}
              onClick={() => state.toggleEditing(false)}
            >
              取消修改
            </Button>
          </div>
        </form>
      ) : detail.status === 'pending' && !state.notice ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            只确认上方冻结版本。确认创建与确认取消是不同决议，不会自动批准后继。
          </p>
          <div className="flex flex-wrap gap-4">
            <Button disabled={disabled} onClick={() => void state.decide('confirm')}>
              {state.busy === 'confirm'
                ? '正在确认…'
                : detail.kind === 'cancel_task'
                  ? '确认取消这条提醒'
                  : '确认创建这条提醒'}
            </Button>
            <Button
              variant="glass"
              color="default"
              disabled={disabled}
              onClick={() => void state.decide('reject')}
            >
              {state.busy === 'reject' ? '正在拒绝…' : '拒绝这条提议'}
            </Button>
            {detail.kind === 'create_task' ? (
              <Button
                ref={editTrigger}
                variant="clear"
                color="default"
                disabled={disabled}
                onClick={() => state.toggleEditing(true)}
              >
                修改提议
              </Button>
            ) : null}
          </div>
          {!me ? (
            <p className="text-sm text-muted-foreground">
              当前身份未核验，不能提交决议。重新读取身份不会补发原操作。
            </p>
          ) : null}
        </div>
      ) : null}
      {state.error ? (
        <div id="approval-action-error" ref={errorSummary} tabIndex={-1}>
          <ErrorNotice message={state.error}>
            {state.uncertain ? (
              <div className="space-y-3">
                <p>
                  响应未能核验，服务端可能已接受。先读取原提议，不换键、不改输入、不重复创建；关闭本页后仅重新读取事实。
                </p>
                {state.readAfterFailure && state.retryAction && detail.status === 'pending' ? (
                  <Button
                    variant="glass"
                    color="default"
                    disabled={state.busy !== null || state.reading}
                    onClick={() => void state.decide(state.retryAction!, true)}
                  >
                    使用原请求键显式核对同一操作
                  </Button>
                ) : null}
              </div>
            ) : (
              <p>原冻结正文保留。过期、替代或版本不一致时请读取真实结果，不重做旧操作。</p>
            )}
          </ErrorNotice>
        </div>
      ) : null}
      {state.notice ? (
        <Alert>
          <Alert.Content>
            <Alert.Title>已接收决议</Alert.Title>
            <Alert.Description>
              <p role="status">{state.notice}</p>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {state.successorReading || state.successorDetail || state.successorError ? (
        <section className="space-y-4 p-4 sm:p-8" aria-busy={state.successorReading}>
          <h2 className="text-lg font-semibold">修改后的真实后继提议</h2>
          <p className="text-sm text-muted-foreground">
            原提议已被替代，新提议仍需单独审阅确认。这里读取后继不会自动批准。
          </p>
          {state.successorReading ? <p role="status">正在读取实际后继冻结内容…</p> : null}
          {state.successorDetail ? (
            <>
              <Badge variant="glass">{approvalStatusLabels[state.successorDetail.status]}</Badge>
              <p>
                {state.successorDetail.fire_at_local} · {state.successorDetail.snapshot.timezone_id}
              </p>
              <pre className="whitespace-pre-wrap font-mono text-base leading-7">
                {state.successorDetail.echo_text}
              </pre>
              <Button
                role="link"
                nativeButton={false}
                render={
                  <Link
                    href={`/approvals/${encodeURIComponent(state.successorDetail.approval_id)}`}
                  />
                }
              >
                打开后继详情并审阅
              </Button>
            </>
          ) : null}
          {state.successorError ? (
            <ErrorNotice message={state.successorError}>
              <p>修改结果已接受；这里只重读后继，不再次提交修改。</p>
              {successor ? (
                <Button
                  variant="glass"
                  color="default"
                  disabled={state.successorReading}
                  onClick={() => void state.readSuccessor(successor)}
                >
                  重新读取后继提议
                </Button>
              ) : null}
            </ErrorNotice>
          ) : null}
        </section>
      ) : null}
      <section className="space-y-4 border-t border-border pt-6" aria-busy={state.reading}>
        <h2 className="text-lg font-semibold">真实结果与关联</h2>
        {taskId ? (
          <p>
            <Link
              className="text-primary underline underline-offset-4"
              href={`/tasks/${encodeURIComponent(taskId)}`}
            >
              查看真实提醒任务与状态
            </Link>
          </p>
        ) : (
          <p className="text-muted-foreground">尚无真实提醒结果引用，不表示已创建或已调度。</p>
        )}
        {successor ? (
          <p>
            <Link
              className="text-primary underline underline-offset-4"
              href={`/approvals/${encodeURIComponent(successor)}`}
            >
              审阅实际后继提议（需要新的确认）
            </Link>
          </p>
        ) : null}
        {detail.recreated_from ? (
          <p>
            <Link
              className="text-primary underline underline-offset-4"
              href={`/approvals/${encodeURIComponent(detail.recreated_from)}`}
            >
              查看前驱提议
            </Link>
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          此提醒详情没有可核验的原会话引用，因此不从地址参数猜测原运行。
        </p>
        {state.readError ? <ErrorNotice message={state.readError} /> : null}
        <Button
          variant="glass"
          color="default"
          disabled={state.reading || state.busy !== null}
          onClick={() => void state.refresh()}
        >
          {state.reading ? '正在读取原提议…' : '读取原提议与真实结果'}
        </Button>
      </section>
    </section>
  );
}
