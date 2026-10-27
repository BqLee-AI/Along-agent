'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { requireClientSession } from '../../../lib/account-navigation';

export default function CancelAction({
  taskId,
  csrfToken,
  state,
}: {
  taskId: string;
  csrfToken: string | null;
  state: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminal = ['fired', 'missed', 'cancelled', 'cancel_pending'].includes(state);

  async function cancel(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/actions/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      });
      requireClientSession(response);
      const payload = (await response.json()) as {
        data?: { state?: string; duplicate?: boolean };
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? `取消失败（${response.status}）`);
        return;
      }
      setMessage(
        payload.data?.state === 'cancelled' ? '已取消。' : '取消请求已提交，等待调度器回执。',
      );
      router.refresh();
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="actions">
        <button className="secondary" disabled={terminal || busy} onClick={() => void cancel()}>
          取消这条提醒
        </button>
      </div>
      {message ? <p className="muted">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
