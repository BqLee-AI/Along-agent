'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import WorkspaceLink from '@/shell/view/workspace-link';
import { EmptyState, ErrorNotice, PageHeading } from '@/shared/ui/page';
import {
  parseNewsTopics,
  readEditions,
  readNewsCsrf,
  readSubscription,
  readWechat,
  writeSubscription,
  type Edition,
  type Subscription,
} from '../model/news-api';
import { EditionStatuses } from './edition-statuses';

const inputClass =
  'min-h-11 w-full rounded-control border border-separator bg-background px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-ring';
const linkClass =
  'inline-flex min-h-11 items-center text-brand-ink underline focus-visible:outline-2 focus-visible:outline-ring';

export function NewsScreen() {
  const [settings, setSettings] = useState<{
    subscription: Subscription;
    bindingId: string | null;
  }>();
  const [settingsError, setSettingsError] = useState('');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [editions, setEditions] = useState<Edition[]>();
  const [editionsError, setEditionsError] = useState('');
  const [editionsRevision, setEditionsRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([readSubscription(controller.signal), readWechat(controller.signal)]).then(
      ([subscription, binding]) => {
        if (!controller.signal.aborted)
          setSettings({ subscription, bindingId: binding.binding_id });
      },
      (failure) => {
        if (!controller.signal.aborted)
          setSettingsError(failure instanceof Error ? failure.message : '无法读取订阅设置。');
      },
    );
    return () => controller.abort();
  }, [settingsRevision]);

  useEffect(() => {
    const controller = new AbortController();
    void readEditions(controller.signal).then(
      ({ items }) => {
        if (!controller.signal.aborted) setEditions(items);
      },
      (failure) => {
        if (!controller.signal.aborted)
          setEditionsError(failure instanceof Error ? failure.message : '无法读取历史简报。');
      },
    );
    return () => controller.abort();
  }, [editionsRevision]);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 [overflow-wrap:anywhere]">
      <PageHeading
        title="新闻订阅"
        description="按关注主题和地区生成每日简报，并发送到你绑定的微信。"
      />
      <section
        aria-labelledby="news-preferences"
        className="space-y-4 rounded-lg border border-separator p-4 sm:p-5"
      >
        <h2 id="news-preferences" className="text-base font-semibold">
          订阅设置
        </h2>
        {settings ? (
          <SubscriptionForm initial={settings.subscription} currentBinding={settings.bindingId} />
        ) : null}
        {settingsError ? (
          <ErrorNotice message={settingsError}>
            <Button
              type="button"
              variant="glass"
              color="default"
              onClick={() => {
                setSettingsError('');
                setSettingsRevision((value) => value + 1);
              }}
            >
              重新读取设置
            </Button>
          </ErrorNotice>
        ) : null}
        {!settings && !settingsError ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取订阅设置…
          </p>
        ) : null}
      </section>
      <section aria-labelledby="news-history" className="space-y-3">
        <h2 id="news-history" className="text-base font-semibold">
          历史简报
        </h2>
        {editionsError ? (
          <ErrorNotice message={editionsError}>
            <Button
              type="button"
              variant="glass"
              color="default"
              onClick={() => {
                setEditionsError('');
                setEditionsRevision((value) => value + 1);
              }}
            >
              重新读取历史
            </Button>
          </ErrorNotice>
        ) : null}
        {!editions && !editionsError ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取历史简报…
          </p>
        ) : null}
        {editions?.length === 0 ? (
          <EmptyState title="还没有简报" description="生成后的简报会在这里按日期列出。" />
        ) : null}
        {editions?.length ? (
          <ul className="divide-y divide-separator rounded-lg border border-separator px-4">
            {editions.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-x-4 py-1"
              >
                <WorkspaceLink href={`/news/editions/${item.id}`} className={linkClass}>
                  <time dateTime={item.local_date}>{item.local_date}</time>
                  <span className="sr-only">新闻简报</span>
                </WorkspaceLink>
                <EditionStatuses edition={item} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function SubscriptionForm({
  initial,
  currentBinding,
}: {
  initial: Subscription;
  currentBinding: string | null;
}) {
  const [topicsText, setTopicsText] = useState(initial.topics.join('\n'));
  const [region, setRegion] = useState(initial.region ?? '');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [bindingId, setBindingId] = useState(initial.binding_id ?? '');
  const [timezone, setTimezone] = useState(initial.timezone_id);
  const [topicsError, setTopicsError] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | null>(null);
  const topicsInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    setError('');
    setSaved(false);
    setTopicsError('');
    const topics = parseNewsTopics(topicsText);
    if (!topics.success) {
      setTopicsError('最多填写 12 个主题，每个不超过 80 个字符。');
      topicsInput.current?.focus();
      return;
    }
    const target = bindingId && bindingId === currentBinding ? bindingId : null;
    const localRegion = region.trim() || null;
    if (enabled && (!timezone || !target || (!topics.data.length && !localRegion))) {
      setError('启用订阅需要账户时区、接收微信，以及至少一个关注主题或地区。');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setSaving(true);
    try {
      const csrf = await readNewsCsrf(signal);
      const result = await writeSubscription(
        { topics: topics.data, region: localRegion, enabled, binding_id: target },
        csrf,
        signal,
      );
      if (signal.aborted) return;
      setTopicsText(result.topics.join('\n'));
      setRegion(result.region ?? '');
      setBindingId(result.binding_id ?? '');
      setEnabled(result.enabled);
      setTimezone(result.timezone_id);
      setSaved(true);
    } catch (failure) {
      if (!signal.aborted)
        setError(failure instanceof Error ? failure.message : '无法保存订阅设置。');
    } finally {
      request.current = null;
      if (!signal.aborted) setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} onChange={() => setSaved(false)}>
      <fieldset disabled={saving} className="space-y-4">
        <div className="grid gap-1">
          <label htmlFor="news-topics" className="text-sm font-medium">
            关注主题
          </label>
          <textarea
            ref={topicsInput}
            id="news-topics"
            rows={3}
            value={topicsText}
            onChange={(event) => setTopicsText(event.target.value)}
            aria-invalid={Boolean(topicsError)}
            aria-describedby={
              topicsError ? 'news-topics-help news-topics-error' : 'news-topics-help'
            }
            className={inputClass}
          />
          <p id="news-topics-help" className="text-sm text-muted-foreground">
            用换行或逗号分隔，最多 12 个。
          </p>
          {topicsError ? (
            <p id="news-topics-error" role="alert" className="text-sm">
              {topicsError}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1">
          <label htmlFor="news-region" className="text-sm font-medium">
            新闻地区（可选）
          </label>
          <input
            id="news-region"
            maxLength={80}
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            className={inputClass}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="news-binding" className="text-sm font-medium">
            接收微信
          </label>
          <select
            id="news-binding"
            value={bindingId === currentBinding ? bindingId : ''}
            onChange={(event) => setBindingId(event.target.value)}
            className={inputClass}
          >
            <option value="">不选择</option>
            {currentBinding ? <option value={currentBinding}>本人已绑定的微信</option> : null}
          </select>
          <WorkspaceLink href="/channels" className={`${linkClass} text-sm`}>
            管理微信绑定
          </WorkspaceLink>
        </div>
        <dl className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium">每日触发</dt>
            <dd>08:00（账户当地时间）</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium">账户时区</dt>
            <dd>{timezone ?? '未设置'}</dd>
          </div>
        </dl>
        {!timezone ? (
          <WorkspaceLink href="/account" className={`${linkClass} text-sm`}>
            设置账户时区
          </WorkspaceLink>
        ) : null}
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4 focus-visible:outline-2 focus-visible:outline-ring"
          />
          启用每日订阅
        </label>
        {error ? <ErrorNotice message={error} /> : null}
        <Button type="submit" color="primary" disabled={saving}>
          {saving ? '正在保存…' : '保存订阅'}
        </Button>
        <p role="status" className="text-sm text-secondary-foreground" hidden={!saved}>
          {saved ? '订阅设置已保存。' : ''}
        </p>
      </fieldset>
    </form>
  );
}
