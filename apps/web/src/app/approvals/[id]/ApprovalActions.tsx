'use client';

import { useRef, useState } from 'react';

interface Props {
  approvalId: string;
  presentationHash: string;
  echoText: string;
  kind: 'create_task' | 'cancel_task';
  originalText: string;
  timezone: string;
  csrfToken: string | null;
  actionable: boolean;
}

type FoldChoice = 'first' | 'second' | 'none';

interface RevisionBody {
  raw_text: string;
  confirmed_timezone: string;
  fold_choice: FoldChoice;
  idempotency_key: string;
}

interface AmbiguousTime {
  wall_time: string;
  timezone_id: string;
  ruleset_id: string;
  candidates: {
    fold_choice: 'first' | 'second';
    offset_seconds: number;
    fire_at_utc: string;
  }[];
}

interface ActionEnvelope {
  code: number;
  data?: {
    approval_id?: string;
    successor_approval_id?: string;
    duplicate?: boolean;
    task_id?: string;
  } | null;
  error?: { code?: string; message?: string; details?: unknown } | null;
}

function readAmbiguity(details: unknown): AmbiguousTime | null {
  if (!details || typeof details !== 'object') return null;
  const value = details as Partial<AmbiguousTime>;
  if (
    typeof value.wall_time !== 'string' ||
    typeof value.timezone_id !== 'string' ||
    typeof value.ruleset_id !== 'string' ||
    !Array.isArray(value.candidates) ||
    value.candidates.length !== 2 ||
    !value.candidates.every(
      (candidate, index) =>
        candidate &&
        candidate.fold_choice === (index === 0 ? 'first' : 'second') &&
        typeof candidate.offset_seconds === 'number' &&
        Number.isFinite(candidate.offset_seconds) &&
        typeof candidate.fire_at_utc === 'string',
    )
  ) {
    return null;
  }
  return value as AmbiguousTime;
}

export default function ApprovalActions({
  approvalId,
  presentationHash,
  echoText,
  kind,
  originalText,
  timezone,
  csrfToken,
  actionable,
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
  const canAct = actionable && Boolean(csrfToken) && !blocked;

  function showFailure(payload: ActionEnvelope, status: number): void {
    const failure = payload.error;
    setError(failure?.message ?? `请求失败（${status}）`);
    if (
      failure?.code === 'APPROVAL_SUPERSEDED' ||
      failure?.code === 'APPROVAL_EXPIRED' ||
      failure?.code === 'STATE_CONFLICT'
    ) {
      setBlocked(true);
    }
    const details = failure?.details;
    if (details && typeof details === 'object') {
      const reference = details as { successor_approval_id?: unknown; task_id?: unknown };
      if (typeof reference.successor_approval_id === 'string') {
        setRelated({
          href: `/approvals/${encodeURIComponent(reference.successor_approval_id)}`,
          label: '查看替代后的提议',
        });
      } else if (typeof reference.task_id === 'string') {
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
      const payload = (await response.json()) as ActionEnvelope;
      if (!response.ok || payload.code !== 0) {
        showFailure(payload, response.status);
        return;
      }
      leaving = true;
      setNavigating(true);
      if (action === 'confirm' && payload.data?.task_id) {
        window.location.assign(`/tasks/${encodeURIComponent(payload.data.task_id)}`);
        return;
      }
      window.location.assign('/approvals');
    } catch {
      setError('网络异常，请重试。');
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
      const payload = (await response.json()) as ActionEnvelope;
      if (!response.ok || payload.code !== 0) {
        showFailure(payload, response.status);
        setAmbiguity(
          payload.error?.code === 'AMBIGUOUS_LOCAL_TIME'
            ? readAmbiguity(payload.error.details)
            : null,
        );
        return;
      }
      const result = payload.data;
      if (
        result?.approval_id !== approvalId ||
        typeof result.successor_approval_id !== 'string' ||
        typeof result.duplicate !== 'boolean'
      ) {
        setError('修改结果暂时无法读取。请保持输入不变并重试，使用同一请求查询结果。');
        return;
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
      {!csrfToken && actionable ? (
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
