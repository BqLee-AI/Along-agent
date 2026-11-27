'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lorelum/lumen-ui/components/button';
import WorkspaceLink from '@/shell/view/workspace-link';
import { EmptyState, ErrorNotice, PageHeading } from '@/shared/ui/page';
import {
  botHref,
  createBotConversation,
  readBots,
  type PersonalBot,
} from '@/features/conversations/model/personal-bot';
import { readEdition, type EditionDetail } from '../model/news-api';
import { EditionStatuses } from './edition-statuses';

const sectionLabels = { topic: '主题新闻', local: '本地新闻' } as const;

export function EditionScreen({ id }: { id: string }) {
  const [edition, setEdition] = useState<EditionDetail>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void readEdition(id, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        if (value.id !== id) {
          setError('简报响应与当前地址不匹配。');
          return;
        }
        setEdition(value);
      },
      (failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : '无法读取本期简报。');
      },
    );
    return () => controller.abort();
  }, [id, revision]);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4 [overflow-wrap:anywhere]">
      <WorkspaceLink
        href="/news"
        className="inline-flex min-h-11 items-center text-sm text-brand-ink underline"
      >
        返回新闻订阅
      </WorkspaceLink>
      <PageHeading title={edition ? `${edition.local_date} 新闻简报` : '新闻简报'} />
      {error ? (
        <ErrorNotice message={error}>
          <Button
            type="button"
            variant="glass"
            color="default"
            onClick={() => {
              setError('');
              setRevision((value) => value + 1);
            }}
          >
            重新读取简报
          </Button>
        </ErrorNotice>
      ) : null}
      {!edition && !error ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取简报…
        </p>
      ) : null}
      {edition ? (
        <>
          <EditionStatuses edition={edition} />
          {edition.items.length === 0 ? (
            <EmptyState
              title="本期没有新闻要点"
              description={
                edition.coverage === 'complete'
                  ? '本次采集没有找到符合条件的新闻。'
                  : '可用的来源未提供可展示的新闻。'
              }
            />
          ) : null}
          {(['topic', 'local'] as const).map((section) => {
            const items = edition.items.filter((item) => item.section === section);
            return items.length ? (
              <section
                key={section}
                aria-labelledby={`news-section-${section}`}
                className="space-y-2"
              >
                <h2 id={`news-section-${section}`} className="text-base font-semibold">
                  {sectionLabels[section]}
                </h2>
                <ul className="divide-y divide-separator rounded-lg border border-separator px-4">
                  {items.map((item, index) => (
                    <li key={`${section}-${index}`} className="space-y-2 py-4">
                      <p className="whitespace-pre-wrap text-sm leading-6">{item.summary}</p>
                      <ul aria-label="原文来源" className="flex flex-wrap gap-x-3">
                        {item.sources.map((source) => (
                          <li key={source.url}>
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex min-h-8 items-center text-sm text-brand-ink underline focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              {source.name}
                              <span className="sr-only">（在新标签页打开）</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null;
          })}
          {choosing ? (
            <DiscussionForm editionId={edition.id} onCancel={() => setChoosing(false)} />
          ) : (
            <Button type="button" color="primary" onClick={() => setChoosing(true)}>
              和 Bot 讨论
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}

function DiscussionForm({ editionId, onCancel }: { editionId: string; onCancel: () => void }) {
  const router = useRouter();
  const [bots, setBots] = useState<PersonalBot[]>();
  const [botId, setBotId] = useState('');
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const pending = useRef(new Map<string, string>());
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void readBots(null, controller.signal).then(
      ({ items }) => {
        if (!controller.signal.aborted) setBots(items);
      },
      (failure) => {
        if (!controller.signal.aborted)
          setReadError(failure instanceof Error ? failure.message : '无法读取 Bot 列表。');
      },
    );
    return () => controller.abort();
  }, [revision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!botId || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const key = pending.current.get(botId) ?? crypto.randomUUID();
    pending.current.set(botId, key);
    setCreating(true);
    setError('');
    try {
      const id = await createBotConversation(botId, key, controller.signal);
      if (controller.signal.aborted) return;
      router.push(`${botHref(botId, id)}&news_edition_id=${encodeURIComponent(editionId)}`);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : '无法创建对话。');
        setCreating(false);
        request.current = null;
      }
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-3 rounded-lg border border-separator p-4"
      aria-labelledby="discussion-heading"
    >
      <h2 id="discussion-heading" className="text-base font-semibold">
        选择 Bot 讨论本期简报
      </h2>
      <p className="text-sm text-muted-foreground">
        会先创建空对话。由你发送首条消息后，Bot 才会读取本期简报。
      </p>
      {!bots && !readError ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取 Bot 列表…
        </p>
      ) : null}
      {readError ? (
        <ErrorNotice message={readError}>
          <Button
            type="button"
            variant="glass"
            color="default"
            onClick={() => {
              setReadError('');
              setRevision((value) => value + 1);
            }}
          >
            重新读取 Bot 列表
          </Button>
        </ErrorNotice>
      ) : null}
      {bots?.length === 0 ? (
        <p className="text-sm">
          目前没有 Bot。
          <WorkspaceLink className="text-brand-ink underline" href="/conversations">
            前往 Bot 列表创建
          </WorkspaceLink>
        </p>
      ) : null}
      {bots?.length ? (
        <div className="grid gap-1">
          <label htmlFor="discussion-bot" className="text-sm font-medium">
            已有 Bot
          </label>
          <select
            id="discussion-bot"
            required
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            disabled={creating}
            className="min-h-11 rounded-control border border-separator bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="">请选择</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.config.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" color="primary" disabled={!botId || creating}>
          {creating ? '正在创建对话…' : '创建讨论对话'}
        </Button>
        <Button
          type="button"
          variant="glass"
          color="default"
          disabled={creating}
          onClick={onCancel}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
