'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DocumentApprovalActionResultSchema, type DocumentApprovalDetail } from '@along/contracts';
import { documentConfirmBody } from '../../../lib/document-loop';
import { readEnvelope } from '../../../lib/conversation-run';
import type { Me } from '../../../lib/types';

export default function DocumentActions({
  detail,
  me,
}: {
  detail: DocumentApprovalDetail;
  me: Me | null;
}) {
  const router = useRouter();
  const keys = useRef<Partial<Record<'confirm' | 'reject', string>>>({});
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function decide(action: 'confirm' | 'reject') {
    if (inFlight.current || decided || detail.state !== 'pending' || !me) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const storageKey = `document-decision:${detail.approval_id}:${action}:${detail.presentation_hash}`;
    try {
      const key = keys.current[action] ?? sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      keys.current[action] = key;
      sessionStorage.setItem(storageKey, key);
      const body =
        action === 'confirm' ? documentConfirmBody(detail, key) : { idempotency_key: key };
      const response = await fetch(
        `/api/v1/document-approvals/${encodeURIComponent(detail.approval_id)}/actions/${action}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(me.csrf_token !== null ? { 'x-csrf-token': me.csrf_token } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      const decision = DocumentApprovalActionResultSchema.parse(await readEnvelope(response));
      if (decision.approval_id !== detail.approval_id)
        throw new Error('决议目标与当前批准不一致。');
      setDecided(true);
      setResult(
        decision.status === 'approved'
          ? '已授权，尚不代表已保存。请回原会话读取状态，在允许继续时显式继续原 Run。'
          : '已拒绝。请回原会话查看原 Run 的状态。',
      );
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : '决议响应未知；读取状态后可用原请求重试，不会执行文件写入。',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div aria-busy={busy}>
      {me === null ? <p className="error">请先登录，无法确认当前会话身份。</p> : null}
      {detail.state === 'pending' && !decided ? (
        <div className="actions">
          <button type="button" disabled={busy || !me} onClick={() => void decide('confirm')}>
            {busy ? '处理中…' : '批准精确内容（仅授权）'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !me}
            onClick={() => void decide('reject')}
          >
            拒绝
          </button>
        </div>
      ) : null}
      {result && detail.effect.status === 'not_started' ? <p role="status">{result}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="secondary" disabled={busy} onClick={() => router.refresh()}>
        读取批准和文件结果
      </button>
    </div>
  );
}
