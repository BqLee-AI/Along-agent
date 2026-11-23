'use client';

import { useEffect, useState } from 'react';
import {
  changeFeishuBotConnection,
  readFeishuBotStatus,
  type FeishuBotAction,
  type FeishuBotStatus,
} from '../model/feishu-connection';
import { PageHeading } from '@/shared/ui/page';
import { MicrosoftLearnConnectionCard } from './microsoft-learn-connection-card';

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
      <h3 className="font-semibold">飞书机器人</h3>
      <p className="text-sm text-muted-foreground">
        优先连接已有机器人，没有机器人时可在飞书新建。无需填写密钥；Along
        只验证机器人身份，不收发消息。
      </p>
      <div role="status" className="text-sm">
        {!bot && !error && '正在检查飞书机器人连接…'}
        {bot?.state === 'idle' && '尚未连接机器人。'}
        {bot?.state === 'connected' && `机器人已连接：${bot.name}`}
        {bot?.state === 'preparing' && '正在生成飞书扫码链接…'}
        {bot?.state === 'waiting' &&
          '请在飞书选择已有应用；没有可用的机器人时再新建。Along 会自动检查结果。'}
        {bot?.state === 'failed' && '扫码未完成、已过期或机器人未启用，可以重新扫码。'}
        {bot?.state === 'other_session' && '另一个登录会话正在扫码。可取消旧扫码后在这里重新连接。'}
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
            扫码连接飞书机器人
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

export function FeishuConnectionScreen() {
  return (
    <div className="w-full min-w-0">
      <PageHeading title="连接器" description="管理飞书机器人和 Microsoft Learn 公开资料搜索。" />
      <section
        className="max-w-xl space-y-4 rounded-2xl bg-muted p-6"
        aria-labelledby="feishu-heading"
      >
        <h2 id="feishu-heading" className="text-lg font-semibold">
          飞书
        </h2>
        <FeishuBotConnection />
        <p className="text-sm text-muted-foreground">
          连接机器人不会授予文档权限。仅可读取部署配置允许、机器人有权访问的飞书
          Docx，且须在新对话请求中指定单个直链。不搜索或修改文档。
        </p>
      </section>
      <MicrosoftLearnConnectionCard />
    </div>
  );
}
