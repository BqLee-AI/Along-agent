'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import * as auth from '@along/contracts';
import AccountActionForm from './AccountActionForm';
import { takeFragmentToken } from './account-actions';
import { MeSchema } from '../../lib/types';

export type AccountLinkProps = { purpose: 'invitation' | 'reset' | 'contact' };
export default function AccountLink({ purpose }: AccountLinkProps) {
  const captured = useRef(false);
  const generation = useRef(0);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [message, setMessage] = useState('正在安全读取链接…');
  useLayoutEffect(() => {
    function capture() {
      const currentGeneration = ++generation.current;
      const secret = takeFragmentToken(window.location, window.history);
      setToken(secret);
      setReady(false);
      setCsrf(null);
      setMessage('正在安全读取链接…');
      if (!secret) {
        setMessage('链接无效或已从地址栏移除。请从邮件重新打开有效链接。');
        return;
      }
      if (purpose === 'reset') {
        setReady(true);
        return;
      }
      // GET only. Opening/previewing a link never consumes it.
      void (async () => {
        try {
          const response = await fetch('/api/v1/me', { cache: 'no-store' });
          const payload = auth.EnvelopeSchema.safeParse(await response.json().catch(() => null));
          if (generation.current !== currentGeneration) return;
          const actor =
            response.ok && payload.success && payload.data.code === 0
              ? MeSchema.safeParse(payload.data.data)
              : null;
          if (purpose === 'invitation') {
            if (response.status === 401) {
              setReady(true);
              return;
            }
            setMessage(
              actor?.success
                ? '接受邀请前必须明确退出当前账户；邀请不会自动切换账户或登录。退出后请重新打开邮件链接。'
                : '无法核验当前会话，请重新打开链接；未消费邀请。',
            );
          } else if (actor?.success && actor.data.csrf_token !== null) {
            setCsrf(actor.data.csrf_token);
            setReady(true);
          } else
            setMessage(
              response.status === 401
                ? '请先登录发起验证的本人账户，再重新打开邮件链接。'
                : '无法核验本人签名会话，未提交验证。',
            );
        } catch {
          if (generation.current === currentGeneration)
            setMessage('会话读取中断，请重新打开邮件链接。未自动提交。');
        }
      })();
    }
    function onHashChange() {
      if (new URLSearchParams(window.location.hash.slice(1)).has('token')) capture();
    }
    if (!captured.current) {
      captured.current = true;
      capture();
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [purpose]);
  const title =
    purpose === 'invitation' ? '接受邀请' : purpose === 'reset' ? '重置密码' : '验证联系邮箱';
  return (
    <section className="mx-auto max-w-[480px] space-y-6 py-8 [overflow-wrap:anywhere]">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">
        打开页面不会提交。链接凭据仅在此页内存中，刷新后需重新打开邮件。
      </p>
      {!ready || !token ? (
        <p role="status">{message}</p>
      ) : purpose === 'invitation' ? (
        <AccountActionForm
          key={token}
          path="invitations/accept"
          title="确认创建账户"
          values={{ token }}
          inputSchema={auth.authInvitationAcceptSchema}
          resultSchema={auth.authInvitationAcceptedSchema}
          fields={[
            { name: 'login_name', label: '用户名', autoComplete: 'username' },
            { name: 'display_name', label: '展示名', autoComplete: 'name' },
            {
              name: 'password',
              label: '设置密码（8–128 位）',
              type: 'password',
              autoComplete: 'new-password',
            },
          ]}
          success="账户已创建。邀请不会自动登录，请明确前往登录。"
        />
      ) : purpose === 'reset' ? (
        <AccountActionForm
          key={token}
          path="password/reset"
          title="确认重置密码"
          values={{ token }}
          inputSchema={auth.authPasswordResetSchema}
          resultSchema={auth.authPasswordResetResultSchema}
          fields={[
            {
              name: 'new_password',
              label: '新密码（8–128 位）',
              type: 'password',
              autoComplete: 'new-password',
            },
          ]}
          success="密码已更新，原会话已撤销。请正式登录。"
        />
      ) : (
        <AccountActionForm
          key={token}
          path="contact/verify"
          title="确认验证本人邮箱"
          values={{ token }}
          inputSchema={auth.authContactVerifySchema}
          resultSchema={auth.authContactVerifiedSchema}
          csrfToken={csrf}
          fields={[]}
          success="联系邮箱已验证。未建立新的会话。"
        />
      )}
      <nav className="flex flex-wrap gap-6">
        <a className="inline-flex min-h-11 items-center text-primary underline" href="/account">
          账户
        </a>
        <a
          className="inline-flex min-h-11 items-center text-primary underline"
          href="/login?returnTo=%2Faccount"
        >
          正式登录
        </a>
        <a className="inline-flex min-h-11 items-center text-primary underline" href="/logout">
          退出当前账户
        </a>
      </nav>
    </section>
  );
}
