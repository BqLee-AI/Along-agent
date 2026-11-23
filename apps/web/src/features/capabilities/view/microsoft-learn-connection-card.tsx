import { useCallback, useEffect, useRef, useState } from 'react';
import {
  changeMicrosoftLearnConnection,
  readMicrosoftLearnStatus,
  type MicrosoftLearnAction,
  type MicrosoftLearnStatus,
} from '../model/microsoft-learn-connection';

type Operation = 'status' | MicrosoftLearnAction;
type View =
  | { kind: 'pending'; operation: Operation }
  | { kind: 'ready'; state: MicrosoftLearnStatus['state'] }
  | { kind: 'error'; operation: Operation };

const statusText = {
  idle: '尚未启用公开搜索。',
  connected: '已启用公开搜索。',
  status: '正在检查连接状态…',
  connect: '正在启用公开搜索…',
  disconnect: '正在断开连接…',
};
const buttonText: Record<Operation, string> = {
  status: '重新检查',
  connect: '连接 Microsoft Learn',
  disconnect: '断开 Microsoft Learn',
};

export function MicrosoftLearnConnectionCard() {
  const [view, setView] = useState<View>({ kind: 'pending', operation: 'status' });
  const request = useRef<AbortController | null>(null);

  const run = useCallback(async (operation: Operation) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    try {
      const result =
        operation === 'status'
          ? await readMicrosoftLearnStatus(signal)
          : await changeMicrosoftLearnConnection(operation, signal);
      if (!signal.aborted) setView({ kind: 'ready', state: result.state });
    } catch {
      if (!signal.aborted) setView({ kind: 'error', operation });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, []);

  useEffect(() => {
    void run('status');
    return () => request.current?.abort();
  }, [run]);

  const operation =
    view.kind === 'ready'
      ? view.state === 'connected'
        ? 'disconnect'
        : 'connect'
      : view.kind === 'error'
        ? 'status'
        : view.operation;
  const pending = view.kind === 'pending';
  const message =
    view.kind === 'error'
      ? view.operation === 'status'
        ? '无法查看连接状态，请重新检查。'
        : '无法确认操作是否成功，请重新检查连接状态。'
      : statusText[view.kind === 'ready' ? view.state : view.operation];

  return (
    <section
      className="mt-4 max-w-xl space-y-4 rounded-2xl bg-muted p-6"
      aria-labelledby="microsoft-learn-heading"
    >
      <h2 id="microsoft-learn-heading" className="text-lg font-semibold">
        Microsoft Learn
      </h2>
      <p className="text-sm text-muted-foreground">
        搜索公开的 Microsoft 和 Azure 文档，无需个人密钥。搜索时 Along 只向 Microsoft Learn
        发送公开资料的查询词；返回的是摘录和来源链接，不是全文。
      </p>
      <p className="text-sm text-muted-foreground">
        连接仅在 Along 中启用此功能，不会登录 Microsoft
        或检查服务是否可用。启用后，请在新的对话请求中搜索公开资料；已有请求不会获得权限。
      </p>
      <p role="status" className="text-sm">
        {message}
      </p>
      {(!pending || operation !== 'status') && (
        <button
          type="button"
          className="min-h-11 rounded-lg bg-foreground px-4 text-sm font-medium text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          disabled={pending}
          onClick={() => {
            if (request.current) return;
            setView({ kind: 'pending', operation });
            void run(operation);
          }}
        >
          {buttonText[operation]}
        </button>
      )}
    </section>
  );
}
