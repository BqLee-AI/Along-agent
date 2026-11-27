'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import WorkspaceLink from '@/shell/view/workspace-link';
import { ErrorNotice, PageHeading } from '@/shared/ui/page';
import {
  pairWechat,
  pollWechat,
  readNewsCsrf,
  readWechat,
  testWechat,
  unbindWechat,
  type WechatPair,
  type WechatPoll,
  type WechatTestStatus,
} from '@/features/news/model/news-api';

type Pairing = WechatPair & { csrf: string };
type PairStatus = Exclude<WechatPoll['status'], 'bound'>;

const pairLabels: Record<PairStatus, string> = {
  waiting: '请用微信扫描二维码。',
  scanned: '已扫码，请在微信中确认绑定。',
  pin_required: '请输入微信中显示的验证码。',
  expired: '此二维码已过期，请重新获取。',
};
const testLabels: Record<WechatTestStatus, string> = {
  accepted: '微信已受理测试消息，请在微信中查看。',
  failed: '微信未受理测试消息。',
  unknown: '无法确认微信是否受理，请先在微信中查看。',
};
const failureMessage = (failure: unknown) =>
  failure instanceof Error ? failure.message : '操作失败，请重新读取连接状态。';

export function WechatConnectionScreen() {
  const [bindingId, setBindingId] = useState<string | null>();
  const [revision, setRevision] = useState(0);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairStatus, setPairStatus] = useState<PairStatus>('waiting');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void readWechat(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setBindingId(value.binding_id);
      },
      (failure) => {
        if (!controller.signal.aborted) setError(failureMessage(failure));
      },
    );
    return () => controller.abort();
  }, [revision]);

  const applyPoll = useCallback((result: WechatPoll) => {
    if (result.status === 'bound') {
      if (result.binding_id) setBindingId(result.binding_id);
      else {
        setBindingId(undefined);
        setRevision((value) => value + 1);
      }
      setPairing(null);
      setPin('');
      setMessage('微信已绑定。');
    } else {
      setPairStatus(result.status);
    }
  }, []);

  const polling = Boolean(
    pairing && !pollError && (pairStatus === 'waiting' || pairStatus === 'scanned'),
  );
  useEffect(() => {
    if (!pairing || !polling) return;
    const { pair_id, csrf } = pairing;
    const controller = new AbortController();
    let timer = window.setTimeout(tick, 2000);
    async function tick() {
      try {
        const result = await pollWechat(pair_id, csrf, controller.signal);
        if (controller.signal.aborted) return;
        applyPoll(result);
        if (result.status === 'waiting' || result.status === 'scanned') {
          timer = window.setTimeout(tick, 2000);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setPollError(failureMessage(failure));
      }
    }
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [applyPoll, pairing, polling]);

  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failureMessage(failure));
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  function startPairing() {
    void perform(async (signal) => {
      const csrf = await readNewsCsrf(signal);
      const result = await pairWechat(csrf, signal);
      if (signal.aborted) return;
      setPollError('');
      setPin('');
      setPairStatus('waiting');
      setPairing({ ...result, csrf });
    });
  }

  function submitPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pairing) return;
    void perform(async (signal) => {
      const result = await pollWechat(pairing.pair_id, pairing.csrf, signal, pin);
      if (signal.aborted) return;
      setPin('');
      applyPoll(result);
      if (result.status === 'pin_required') setError('验证码未通过验证，请检查后重试。');
    });
  }

  function sendTest() {
    void perform(async (signal) => {
      const { status } = await testWechat(await readNewsCsrf(signal), signal);
      if (!signal.aborted) setMessage(testLabels[status]);
    });
  }

  function unbind() {
    void perform(async (signal) => {
      const result = await unbindWechat(await readNewsCsrf(signal), signal);
      if (signal.aborted) return;
      setBindingId(result.binding_id);
      setConfirmUnbind(false);
      setMessage('微信已解绑。');
    });
  }

  function readStatusAgain() {
    setBindingId(undefined);
    setError('');
    setRevision((value) => value + 1);
  }

  return (
    <div className="w-full min-w-0">
      <PageHeading title="聊天工具" description="管理用于接收每日新闻简报的微信连接。" />
      <section
        aria-labelledby="wechat-heading"
        className="space-y-4 rounded-lg border border-separator p-4 sm:p-5"
      >
        <h2 id="wechat-heading" className="text-base font-semibold">
          微信
        </h2>
        <p role="status" className="text-sm text-secondary-foreground">
          {bindingId === undefined
            ? error
              ? '连接状态未知。'
              : '正在读取连接状态…'
            : bindingId
              ? '已绑定'
              : pairing
                ? pairLabels[pairStatus]
                : '未绑定'}
        </p>
        {pairing && pairStatus !== 'expired' ? (
          <Image
            src={pairing.qr_data_url}
            alt="微信绑定二维码"
            width={220}
            height={220}
            unoptimized
            className="max-w-full rounded-control border-8 border-white bg-white"
          />
        ) : null}
        {pairing && pairStatus === 'pin_required' ? (
          <form onSubmit={submitPin} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              微信验证码
              <input
                name="pin"
                required
                pattern="[0-9]{1,16}"
                maxLength={16}
                autoComplete="one-time-code"
                inputMode="numeric"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                className="min-h-11 rounded-control border border-separator bg-background px-3 focus-visible:outline-2 focus-visible:outline-ring"
              />
            </label>
            <Button type="submit" color="primary" disabled={busy}>
              提交验证码
            </Button>
          </form>
        ) : null}
        {error && <ErrorNotice message={error} />}
        {pollError && (
          <ErrorNotice message={pollError}>
            <Button type="button" variant="glass" color="default" onClick={() => setPollError('')}>
              继续检查扫码状态
            </Button>
          </ErrorNotice>
        )}
        <p role="status" className="text-sm text-secondary-foreground" hidden={!message && !busy}>
          {busy ? '正在处理…' : message}
        </p>
        {bindingId === undefined && error ? (
          <Button type="button" variant="glass" color="default" onClick={readStatusAgain}>
            重新读取
          </Button>
        ) : null}
        {bindingId === null ? (
          <div className="flex flex-wrap gap-2">
            {!pairing || pairStatus === 'expired' ? (
              <Button type="button" color="primary" disabled={busy} onClick={startPairing}>
                {pairing ? '重新获取二维码' : '扫码绑定微信'}
              </Button>
            ) : null}
            {pairing ? (
              <Button
                type="button"
                variant="glass"
                color="default"
                disabled={busy}
                onClick={() => {
                  setPairing(null);
                  setPin('');
                  setPollError('');
                  readStatusAgain();
                }}
              >
                取消扫码
              </Button>
            ) : null}
          </div>
        ) : null}
        {bindingId ? (
          confirmUnbind ? (
            <div className="space-y-2">
              <p className="text-sm">解绑后，尚未取得发送许可的简报将不会发送到这个微信。</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" color="danger" disabled={busy} onClick={unbind}>
                  确认解绑
                </Button>
                <Button
                  type="button"
                  variant="glass"
                  color="default"
                  disabled={busy}
                  onClick={() => setConfirmUnbind(false)}
                >
                  取消解绑
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" color="primary" disabled={busy} onClick={sendTest}>
                发送测试消息
              </Button>
              <Button
                type="button"
                variant="glass"
                color="default"
                disabled={busy}
                onClick={() => setConfirmUnbind(true)}
              >
                解绑微信
              </Button>
            </div>
          )
        ) : null}
      </section>
      <WorkspaceLink
        href="/news"
        className="inline-flex min-h-11 items-center text-sm text-brand-ink underline"
      >
        查看新闻订阅
      </WorkspaceLink>
    </div>
  );
}
