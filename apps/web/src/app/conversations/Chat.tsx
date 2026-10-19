'use client';

import { useRef, useState } from 'react';

interface ThreadEvent {
  protocol_version: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  request_id: string;
}

interface Bubble {
  role: 'user' | 'assistant';
  text: string;
}

interface Me {
  csrf_token: string;
  confirmed_timezone: string | null;
}

export default function Chat() {
  const [input, setInput] = useState('');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conversationRef = useRef<string | null>(null);
  const csrfRef = useRef<string | null>(null);
  const timezoneRef = useRef<string | null>(null);
  const deltaOpenRef = useRef(false);

  async function loadMe(): Promise<Me | null> {
    if (csrfRef.current) {
      return {
        csrf_token: csrfRef.current,
        confirmed_timezone: timezoneRef.current,
      };
    }
    const response = await fetch('/api/v1/me', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data: Me };
    csrfRef.current = payload.data.csrf_token;
    timezoneRef.current = payload.data.confirmed_timezone;
    return payload.data;
  }

  function applyEvent(event: ThreadEvent): void {
    if (event.type === 'thread.started') {
      const id = event.payload.conversation_id;
      if (typeof id === 'string') conversationRef.current = id;
      return;
    }
    if (event.type === 'message.delta') {
      const delta = event.payload.delta;
      if (typeof delta !== 'string') return;
      setBubbles((current) => {
        const last = current[current.length - 1];
        if (deltaOpenRef.current && last?.role === 'assistant') {
          return [...current.slice(0, -1), { role: 'assistant', text: last.text + delta }];
        }
        deltaOpenRef.current = true;
        return [...current, { role: 'assistant', text: delta }];
      });
      return;
    }
    if (event.type === 'approval_required') {
      const id = event.payload.approval_id;
      if (typeof id === 'string') setApprovalId(id);
      return;
    }
    if (event.type === 'thread.failed') {
      const detail = event.payload.error;
      if (detail && typeof detail === 'object' && 'message' in detail) {
        setError(String((detail as { message: unknown }).message));
      } else {
        setError('本轮处理失败。');
      }
      return;
    }
    if (event.type === 'thread.cancelled') {
      setError('连接已断开，本轮已停止。');
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError(null);
    setApprovalId(null);
    deltaOpenRef.current = false;
    setBubbles((current) => [...current, { role: 'user', text }]);
    setInput('');
    try {
      const me = await loadMe();
      if (!me) {
        setError('请先登录。');
        return;
      }
      const response = await fetch('/api/v1/conversations/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-csrf-token': me.csrf_token,
        },
        body: JSON.stringify({
          raw_text: text,
          conversation_id: conversationRef.current ?? undefined,
          confirmed_timezone: me.confirmed_timezone,
          idempotency_key: crypto.randomUUID(),
        }),
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `请求失败（${response.status}）`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              applyEvent(JSON.parse(line.slice(6)) as ThreadEvent);
            } catch {
              setError('收到无法解析的事件。');
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>对话</h1>
      <p className="subtitle">说清楚日期、时间和时区。确认前不会创建提醒，也不会排期。</p>
      <div className="chat-log">
        {bubbles.map((bubble, index) => (
          <div className={`bubble ${bubble.role}`} key={`${bubble.role}-${index}`}>
            {bubble.text}
          </div>
        ))}
      </div>
      {approvalId ? (
        <p>
          已生成待确认提议：<a href={`/approvals/${approvalId}`}>去确认</a>
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={3}
          value={input}
          placeholder="例如：明天 9:20 提醒我喝水（Asia/Shanghai）"
          onChange={(event) => setInput(event.target.value)}
        />
        <div className="actions">
          <button type="submit" disabled={busy || input.trim() === ''}>
            {busy ? '处理中…' : '发送'}
          </button>
        </div>
      </form>
    </section>
  );
}
