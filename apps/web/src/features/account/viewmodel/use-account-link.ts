'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { takeFragmentToken } from '../model/account-actions';
import { readLinkSession } from '../model/account-link';
import type { AccountLinkPurpose } from '../model/account-link';

/**
 * Captures a fragment token into memory only, clears it from the address bar on entry and on
 * every later token hash change, and performs GET reads only; consumption is an explicit submit.
 */
export function useAccountLink(purpose: AccountLinkPurpose) {
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
      void (async () => {
        try {
          const session = await readLinkSession();
          if (generation.current !== currentGeneration) return;
          if (purpose === 'invitation') {
            if (session.status === 401) {
              setReady(true);
              return;
            }
            setMessage(
              session.actor
                ? '接受邀请前必须明确退出当前账户；邀请不会自动切换账户或登录。退出后请重新打开邮件链接。'
                : '无法核验当前会话，请重新打开链接；未消费邀请。',
            );
          } else if (session.actor && session.actor.csrf_token !== null) {
            setCsrf(session.actor.csrf_token);
            setReady(true);
          } else
            setMessage(
              session.status === 401
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

  return { token, ready, csrf, message };
}
