'use client';

import Link from 'next/link';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { ErrorNotice } from '@/components/page';
import type { ApiResult } from '@/lib/api';
import type { Brief } from '@/lib/types';
import { describeCard } from '@/lib/presentation';
import { ElapsedBasis } from '@/features/reminders/elapsed-basis';

export function BriefSectionsContent({ response }: { response: ApiResult<Brief> }) {
  if (!response.ok)
    return (
      <ErrorNotice message={response.message}>
        <Button
          variant="glass"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href="/" />}
        >
          重新读取简报
        </Button>
      </ErrorNotice>
    );
  const brief = response.data;
  const groups = [
    {
      title: '待你确认',
      description: '审阅完整方案，再决定是否确认。',
      href: '/approvals',
      items: brief.cards.filter((card) => card.kind === 'approval'),
    },
    {
      title: '今日提醒',
      description: '只展示已记录的步骤，不承诺通知必达。',
      href: '/tasks',
      items: brief.cards.filter((card) => card.kind === 'task'),
    },
    {
      title: '其他简报记录',
      description: '保留原始简报内容与类型提示。',
      href: null,
      items: brief.cards.filter((card) => card.kind !== 'approval' && card.kind !== 'task'),
    },
  ].filter((group) => group.title !== '其他简报记录' || group.items.length > 0);
  return (
    <div className="min-w-0 space-y-6 pb-6 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 text-sm leading-6 text-muted-foreground">
          <p>
            {brief.date} · {brief.timezone_id}
          </p>
          <p>
            本次简报：待确认 {brief.summary.pending_count} · 已记录触发 {brief.summary.fired_count}
            。此处不是全量任务账。
          </p>
        </div>
        <Button
          variant="clear"
          color="default"
          className="shrink-0"
          role="link"
          nativeButton={false}
          render={<Link href="/" />}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          刷新简报
        </Button>
      </div>
      {brief.meta.timezone_note && (
        <Alert>
          <Alert.Content>
            <Alert.Title>时间说明</Alert.Title>
            <Alert.Description>{brief.meta.timezone_note}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {brief.meta.brief_state === 'stale' && (
        <Alert color="warning">
          <Alert.Content>
            <Alert.Title>简报可能过期</Alert.Title>
            <Alert.Description>
              保留先前获取的内容；请刷新核对最新记录，此处不代表完整范围。
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {groups.map(({ title, description, href, items }) => (
        <section key={title} aria-label={title}>
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base font-medium">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            </div>
            {href && (
              <Button
                variant="clear"
                role="link"
                nativeButton={false}
                render={<Link href={href} />}
              >
                查看全部
                <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="border-t border-border py-4 text-sm leading-6 text-muted-foreground">
              <p>{title === '待你确认' ? '本次简报没有待确认事项' : '本次简报没有提醒'}</p>
              <p className="mt-1">其他日期、尚未载入或已变化的记录，请进入对应列表核对。</p>
            </div>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {items.map((card) => {
                const view = describeCard(card);
                return (
                  <li
                    key={card.card_id}
                    className="flex min-h-16 min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        {view.href ? (
                          <Link
                            className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:text-primary hover:underline"
                            href={view.href}
                          >
                            {view.title}
                          </Link>
                        ) : (
                          <span className="font-medium">{view.title}</span>
                        )}
                        {view.status && <Badge variant="glass">{view.status}</Badge>}
                      </div>
                      {view.warning && (
                        <p className="text-sm text-muted-foreground">{view.warning}</p>
                      )}
                      {card.kind === 'task' && card.timezone_id && (
                        <p className="text-sm text-muted-foreground">
                          冻结时区：{card.timezone_id}
                        </p>
                      )}
                      {card.kind === 'task' && <ElapsedBasis basis={card.time_basis} />}
                    </div>
                    {view.time && (
                      <p className="w-full text-sm tabular-nums text-muted-foreground sm:w-auto">
                        {view.time}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      <p className="border-t border-border pt-4 text-sm leading-6 text-muted-foreground">
        资料任务与修改结果保存在原会话中。
        <Link
          href="/conversations"
          className="inline-flex min-h-11 items-center gap-1 text-primary underline-offset-4 hover:underline sm:ml-2"
        >
          找回会话与结果
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}
