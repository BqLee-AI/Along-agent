'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Card } from '@lorelum/lumen-ui/components/card';
import WorkspaceLink from '@/shell/view/workspace-link';
import {
  changeFeishuBotConnection,
  readFeishuBotStatus,
  type FeishuBotAction,
  type FeishuBotStatus,
} from '../model/feishu-connection';
import { PageHeading } from '@/shared/ui/page';

const button =
  'min-h-11 rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50';

function FeishuBotConnection() {
  const [bot, setBot] = useState<FeishuBotStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (busy) return;
    const abort = new AbortController();
    let next: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await readFeishuBotStatus(abort.signal);
        if (abort.signal.aborted) return;
        setBot(data);
        if (data.state === 'preparing' || data.state === 'waiting') next = setTimeout(load, 2_000);
      } catch {
        if (!abort.signal.aborted) {
          setBot(undefined);
          setError('无法查看机器人连接，请重试。');
        }
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(next);
    };
  }, [busy, revision]);

  async function act(action: FeishuBotAction) {
    setBusy(true);
    setError('');
    try {
      setBot(await changeFeishuBotConnection(action));
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'ZodError' ? cause.message : '操作失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div role="status" className="text-sm empty:absolute">
        {!bot && !error && '正在检查连接…'}
        {bot?.state === 'connected' && `已连接 ${bot.name}`}
        {bot?.state === 'preparing' && '正在生成二维码…'}
        {bot?.state === 'waiting' && '请在飞书扫码并选择机器人。'}
        {bot?.state === 'failed' && '扫码未完成，请重试。'}
        {bot?.state === 'other_session' && '另一个会话正在扫码。'}
        {error && <p>{error}</p>}
      </div>
      {bot?.state === 'waiting' && (
        <div className="space-y-2">
          {/* Locally generated PNG for the current sign-in session; never fetched from a third party. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bot.scan.qr} alt="连接飞书机器人二维码" width={192} height={192} />
          <a
            className="inline-block text-sm underline"
            href={bot.scan.url}
            target="_blank"
            rel="noreferrer"
          >
            在飞书打开确认页
          </a>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {(bot?.state === 'idle' || bot?.state === 'failed') && (
          <button className={button} disabled={busy} onClick={() => void act('scan')}>
            扫码连接
          </button>
        )}
        {bot?.state === 'connected' && (
          <button className={button} disabled={busy} onClick={() => void act('disconnect')}>
            断开机器人
          </button>
        )}
        {bot && bot.state !== 'idle' && bot.state !== 'connected' && (
          <button className={button} disabled={busy} onClick={() => void act('cancel')}>
            {bot.state === 'other_session' ? '取消旧扫码' : '取消扫码'}
          </button>
        )}
        {error && (
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              setError('');
              setRevision((n) => n + 1);
            }}
          >
            重新检查
          </button>
        )}
      </div>
    </div>
  );
}

export function FeishuConnectionScreen({ showConnection }: { showConnection: boolean }) {
  if (showConnection) {
    return (
      <div className="w-full min-w-0">
        <PageHeading title="飞书机器人" />
        <div className="space-y-4">
          <Button
            render={<WorkspaceLink href="/connectors" />}
            nativeButton={false}
            role="link"
            variant="clear"
            size="sm"
          >
            返回连接应用
          </Button>
          <FeishuBotConnection />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      <PageHeading title="连接应用" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),13rem))] gap-3">
        <Card variant="soft" className="flex-row items-center justify-between gap-3 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Image src="/feishu.png" alt="" width={32} height={32} unoptimized />
            <span className="text-sm font-medium">飞书</span>
          </div>
          <Button
            render={<WorkspaceLink href="/connectors?app=feishu" />}
            nativeButton={false}
            role="link"
            variant="glass"
            size="sm"
            aria-label="连接飞书"
          >
            连接
          </Button>
        </Card>
      </div>
    </div>
  );
}
