'use client';

import { useState } from 'react';

interface Props {
  approvalId: string;
  presentationHash: string;
  echoText: string;
  csrfToken: string | null;
  actionable: boolean;
}

export default function ApprovalActions({
  approvalId,
  presentationHash,
  echoText,
  csrfToken,
  actionable,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(action: 'confirm' | 'reject'): Promise<void> {
    setBusy(true);
    setError(null);
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
      const payload = (await response.json()) as {
        data?: { task_id?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? `请求失败（${response.status}）`);
        return;
      }
      if (action === 'confirm' && payload.data?.task_id) {
        window.location.assign(`/tasks/${payload.data.task_id}`);
        return;
      }
      window.location.assign('/approvals');
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="notice">
        提醒保存在云端；到点在调度器成功运行时尝试通知。设备关机、休眠或进程未运行时可能错过，不保证准时响。
      </p>
      <div className="actions">
        <button disabled={!actionable || busy} onClick={() => void call('confirm')}>
          确认
        </button>
        <button
          className="secondary"
          disabled={!actionable || busy}
          onClick={() => void call('reject')}
        >
          拒绝
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
