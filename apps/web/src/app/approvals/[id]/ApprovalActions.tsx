'use client';

import { useEffect, useRef, useState } from 'react';
import { EnvelopeSchema, type Envelope, type RunView } from '@along/contracts';
import { AmbiguousTimeDetailsSchema } from '@along/stream-protocol';
import { z } from 'zod';
import { conversationHref, readRun, runStatusLabel } from '../../../lib/conversation-run';
import type { Me } from '../../../lib/types';
import { requireClientSession } from '../../../lib/account-navigation';

interface Props {
  approvalId: string;
  presentationHash: string;
  echoText: string;
  kind: 'create_task' | 'cancel_task';
  originalText: string;
  timezone: string;
  me: Me | null;
  actionable: boolean;
  conversationId: string | null;
  runId: string | null;
}

type FoldChoice = 'first' | 'second' | 'none';

interface RevisionBody {
  raw_text: string;
  confirmed_timezone: string;
  fold_choice: FoldChoice;
  idempotency_key: string;
}

type AmbiguousTime = z.infer<typeof AmbiguousTimeDetailsSchema>;

const ConfirmResultSchema = z
  .object({
    approval_id: z.string().uuid(),
    status: z.literal('consumed'),
    task_id: z.string().uuid(),
    duplicate: z.boolean(),
  })
  .strict();
const RejectResultSchema = z
  .object({
    approval_id: z.string().uuid(),
    status: z.literal('rejected'),
    duplicate: z.boolean(),
  })
  .strict();
const ReviseResultSchema = z
  .object({
    approval_id: z.string().uuid(),
    successor_approval_id: z.string().uuid(),
    duplicate: z.boolean(),
  })
  .strict();
const ErrorReferencesSchema = z.object({
  successor_approval_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
});

function readAmbiguity(details: unknown): AmbiguousTime | null {
  const parsed = AmbiguousTimeDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}

export default function ApprovalActions({
  approvalId,
  presentationHash,
  echoText,
  kind,
  originalText,
  timezone,
  me,
  actionable,
  conversationId,
  runId,
}: Props) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rawText, setRawText] = useState(originalText);
  const [confirmedTimezone, setConfirmedTimezone] = useState(timezone);
  const [foldChoice, setFoldChoice] = useState<FoldChoice>('none');
  const [ambiguity, setAmbiguity] = useState<AmbiguousTime | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [related, setRelated] = useState<{ href: string; label: string } | null>(null);
  const [navigating, setNavigating] = useState(false);
  const revisionRef = useRef<RevisionBody | null>(null);
  const [decisionRecorded, setDecisionRecorded] = useState(false);
  const [originalRun, setOriginalRun] = useState<RunView | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [readingRun, setReadingRun] = useState(false);
  const csrfToken = me?.csrf_token;
  const canAct = actionable && me !== null && !blocked && !decisionRecorded;

  async function refreshOriginal(): Promise<RunView | null> {
    if (!conversationId || !runId) return null;
    setReadingRun(true);
    setRunError(null);
    try {
      const view = await readRun(conversationId, runId);
      setOriginalRun(view);
      return view;
    } catch (failure) {
      setRunError(failure instanceof Error ? failure.message : '无法读取原运行。');
      return null;
    } finally {
      setReadingRun(false);
    }
  }

  useEffect(() => {
    void refreshOriginal();
    // URL references identify the original Run, never an approval successor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, runId]);

  function showFailure(payload: Envelope, status: number): void {
    const failure = payload.error;
    setError(failure?.message ?? `请求失败（${status}）`);
    if (
      failure?.code === 'APPROVAL_SUPERSEDED' ||
      failure?.code === 'APPROVAL_EXPIRED' ||
      failure?.code === 'STATE_CONFLICT'
    ) {
      setBlocked(true);
    }
    const parsed = ErrorReferencesSchema.safeParse(failure?.details);
    if (parsed.success) {
      const reference = parsed.data;
      if (reference.successor_approval_id) {
        setRelated({
          href: `/approvals/${encodeURIComponent(reference.successor_approval_id)}`,
          label: '查看替代后的提议',
        });
      } else if (reference.task_id) {
        setRelated({
          href: `/tasks/${encodeURIComponent(reference.task_id)}`,
          label: '查看已创建的提醒（改期请先取消再新建）',
        });
      }
    }
  }

  async function call(action: 'confirm' | 'reject'): Promise<void> {
    if (busyRef.current || !canAct || editing) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let leaving = false;
    const body =
      action === 'confirm'
        ? {
            presentation_hash: presentationHash,
            seen_content: echoText,
            idempotency_key: crypto.randomUUID(),
          }
        : { idempotency_key: crypto.randomUUID() };
    try {
      const response = await fetch(`/api/v1/approvals/${approvalId}/actions/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: JSON.stringify(body),
      });
      requireClientSession(response);
      const payload = EnvelopeSchema.parse(await response.json());
      if (!response.ok || payload.code !== 0) {
        showFailure(payload, response.status);
        return;
      }
      setDecisionRecorded(true);
      const result = (action === 'confirm' ? ConfirmResultSchema : RejectResultSchema).parse(
        payload.data,
      );
      if (result.approval_id !== approvalId)
        throw new Error('批准操作返回了不同的提议。请读取原运行状态。');
      if (conversationId && runId) {
        const view = await refreshOriginal();
        if (result.status === 'consumed') {
          setRelated({
            href: `/tasks/${encodeURIComponent(result.task_id)}`,
            label: '查看已创建的提醒',
          });
        }
        // Approval success is not resume success. Stay with the original Run;
        // the user explicitly continues its persisted checkpoint in the thread.
        if (!view || view.execution === 'harness') return;
      }
      leaving = true;
      setNavigating(true);
      if (result.status === 'consumed') {
        window.location.assign(`/tasks/${encodeURIComponent(result.task_id)}`);
        return;
      }
      window.location.assign('/approvals');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '网络异常，请读取原运行状态。');
    } finally {
      if (!leaving) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function changeInput(field: 'text' | 'timezone', value: string): void {
    if (busyRef.current || value === (field === 'text' ? rawText : confirmedTimezone)) return;
    if (field === 'text') setRawText(value);
    else setConfirmedTimezone(value);
    revisionRef.current = null;
    setFoldChoice('none');
    setAmbiguity(null);
    setError(null);
  }

  function chooseFold(choice: 'first' | 'second'): void {
    if (busyRef.current || choice === foldChoice) return;
    revisionRef.current = null;
    setFoldChoice(choice);
    setError(null);
  }

  async function revise(): Promise<void> {
    if (busyRef.current || !canAct || !editing || kind !== 'create_task') return;
    busyRef.current = true;
    setBusy(true);
    setSubmitted(true);
    setError(null);
    let leaving = false;
    try {
      // Keep this exact body/key until an actual input or fold change, including
      // when the server committed but the response never reached this page.
      const body = (revisionRef.current ??= {
        raw_text: rawText,
        confirmed_timezone: confirmedTimezone,
        fold_choice: foldChoice,
        idempotency_key: crypto.randomUUID(),
      });
      const response = await fetch(`/api/v1/approvals/${approvalId}/actions/revise`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: JSON.stringify(body),
      });
      requireClientSession(response);
      const payload = EnvelopeSchema.parse(await response.json());
      if (!response.ok || payload.code !== 0) {
        showFailure(payload, response.status);
        setAmbiguity(
          payload.error?.code === 'AMBIGUOUS_LOCAL_TIME'
            ? readAmbiguity(payload.error.details)
            : null,
        );
        return;
      }
      const result = ReviseResultSchema.parse(payload.data);
      if (result.approval_id !== approvalId) {
        setError('修改结果暂时无法读取。请保持输入不变并重试，使用同一请求查询结果。');
        return;
      }
      setDecisionRecorded(true);
      if (conversationId && runId) {
        const view = await refreshOriginal();
        setEditing(false);
        setRelated({
          href: `/approvals/${encodeURIComponent(result.successor_approval_id)}`,
          label: '查看修改后的提议（不会自动继续或确认）',
        });
        if (!view || view.execution === 'harness') return;
      }
      leaving = true;
      setNavigating(true);
      window.location.assign(`/approvals/${encodeURIComponent(result.successor_approval_id)}`);
    } catch {
      setError(
        '未收到修改结果，不能判断服务端是否已完成。输入和请求键已保留，请保持此页、输入不变后重试；未持久接收的请求不保证已到达。',
      );
    } finally {
      if (!leaving) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div aria-busy={busy}>
      <p className="notice">
        提醒保存在云端；到点在调度器成功运行时尝试通知。设备关机、休眠或进程未运行时可能错过，不保证准时响。
      </p>
      {me === null && actionable ? (
        <p className="error">无法获取操作凭证，请重新登录后重试。</p>
      ) : null}
      {editing ? (
        <form
          className="panel"
          aria-labelledby="revision-title"
          aria-describedby="revision-help"
          onSubmit={(event) => {
            event.preventDefault();
            void revise();
          }}
        >
          <h2 id="revision-title">修改这条提议</h2>
          <p id="revision-help" className="muted">
            请完整重述日期、时间和提醒内容，并明确确认时区。修改不会创建提醒；成功后需阅读新提议，再点击新的确认按钮。
          </p>
          <p>
            <label htmlFor="revision-text">完整原话（必填）</label>
            <textarea
              id="revision-text"
              value={rawText}
              rows={4}
              required
              maxLength={20000}
              disabled={busy || blocked}
              aria-describedby={error ? 'approval-action-error' : 'revision-help'}
              onChange={(event) => changeInput('text', event.target.value)}
            />
          </p>
          <p>
            <label htmlFor="revision-timezone">确认时区（必填，规范 ID）</label>
            <input
              id="revision-timezone"
              value={confirmedTimezone}
              required
              maxLength={100}
              disabled={busy || blocked}
              aria-describedby="revision-timezone-help"
              onChange={(event) => changeInput('timezone', event.target.value)}
            />
          </p>
          <p id="revision-timezone-help" className="muted">
            已预填原提议时区，请确认或更改，例如 Asia/Shanghai。不会自动使用账户默认时区。
          </p>
          {ambiguity ? (
            <fieldset disabled={busy || blocked} aria-describedby="revision-fold-help">
              <legend>这个本地时间出现两次，请明确选择</legend>
              <p id="revision-fold-help">
                服务端返回：{ambiguity.wall_time}（{ambiguity.timezone_id}），规则集{' '}
                {ambiguity.ruleset_id}。选择后请重新提交修改。
              </p>
              <div className="actions">
                {ambiguity.candidates.map((candidate) => (
                  <button
                    key={candidate.fold_choice}
                    type="button"
                    className="secondary"
                    aria-pressed={foldChoice === candidate.fold_choice}
                    onClick={() => chooseFold(candidate.fold_choice)}
                  >
                    {candidate.fold_choice === 'first' ? '第一次（first）' : '第二次（second）'}
                    {' · offset_seconds='}
                    {candidate.offset_seconds}
                    {' · UTC='}
                    {candidate.fire_at_utc}
                    {foldChoice === candidate.fold_choice ? ' · 已选择' : ''}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="actions">
            <button
              type="submit"
              disabled={
                !canAct ||
                busy ||
                rawText.length === 0 ||
                confirmedTimezone.length === 0 ||
                (ambiguity !== null && foldChoice === 'none')
              }
            >
              {navigating ? '正在读取新提议…' : busy ? '正在提交修改…' : '提交修改，重新查看提议'}
            </button>
            {!submitted ? (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setRawText(originalText);
                  setConfirmedTimezone(timezone);
                  setFoldChoice('none');
                  setAmbiguity(null);
                  setError(null);
                  revisionRef.current = null;
                }}
              >
                取消修改
              </button>
            ) : null}
          </div>
          {submitted && !navigating ? (
            <p className="muted">
              修改期间不能确认旧提议。未变输入重试会复用请求键；更改原话、时区或选择会使用新键。此页关闭后不保留未决请求。
            </p>
          ) : null}
        </form>
      ) : (
        <div className="actions">
          <button disabled={!canAct || busy} onClick={() => void call('confirm')}>
            {busy ? '处理中…' : '确认'}
          </button>
          <button
            className="secondary"
            disabled={!canAct || busy}
            onClick={() => void call('reject')}
          >
            拒绝
          </button>
          {actionable && kind === 'create_task' ? (
            <button
              type="button"
              className="secondary"
              disabled={!canAct || busy}
              onClick={() => {
                setEditing(true);
                setError(null);
              }}
            >
              修改这条提议
            </button>
          ) : null}
        </div>
      )}
      {conversationId && runId ? (
        <div className="panel" aria-label="原批准所属运行" aria-busy={readingRun}>
          <p role="status">
            {originalRun ? runStatusLabel[originalRun.status] : '原运行状态尚未读取。'}
          </p>
          {decisionRecorded ? <p>批准操作已收到结果，不要重复确认来恢复继续请求。</p> : null}
          {originalRun?.execution === 'harness' &&
          !originalRun.can_resume &&
          originalRun.status === 'running' ? (
            <p>决议可能早于等待点保存。请读取状态；等待实际挂起后再显式继续。</p>
          ) : null}
          {originalRun?.status === 'suspended_approval' && !originalRun.can_resume ? (
            <p>原批准仍未决，暂不能继续。</p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || readingRun}
              onClick={() => void refreshOriginal()}
            >
              读取原运行状态
            </button>
            <a href={conversationHref(conversationId, runId)}>
              {originalRun?.can_resume ? '返回并继续原运行' : '返回原运行（只读，不自动执行）'}
            </a>
          </div>
          <p className="muted">
            只继续此链接中的 conversation / Run
            和服务端等待点；拒绝或修改不会自动选择后继提议。返回对话后需点击“继续原运行”。
          </p>
          {runError ? (
            <p className="error" role="alert">
              {runError}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p id="approval-action-error" className="error" role="alert">
          {error}
        </p>
      ) : null}
      {related ? (
        <p>
          <a href={related.href}>{related.label}</a>
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {navigating
          ? editing
            ? '正在打开最新详情，请阅读冻结回显；只有再次点击新确认按钮才会创建提醒。'
            : '操作已完成，正在打开最新页面。'
          : busy
            ? '正在处理，请勿重复提交。'
            : ''}
      </p>
    </div>
  );
}
