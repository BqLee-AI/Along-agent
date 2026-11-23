'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConversationRunHistoryItem } from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import { z } from 'zod';
import Link from '@/shell/view/workspace-link';
import { revokeOfficeAttachment } from '../model/office-materials';
import { officeDownloadHref, type OfficeRunResults } from '../model/office-results';

const uuid = z.string().uuid();

type OfficeInput = NonNullable<ConversationRunHistoryItem['office_materials']>['inputs'][number];

export function OfficeRunInputs({
  conversationId,
  inputs,
  csrfToken,
  refresh,
  projectionStale,
}: {
  conversationId: string;
  inputs: readonly OfficeInput[];
  csrfToken: string | null;
  refresh: () => void;
  projectionStale: boolean;
}) {
  if (inputs.length === 0) return null;
  return (
    <section aria-label="资料来源" className="space-y-2 [overflow-wrap:anywhere]">
      <h3 className="font-medium">资料来源</h3>
      <ul className="space-y-2">
        {inputs.map((input) => (
          <OfficeRunInput
            key={input.attachment_id}
            input={input}
            conversationId={conversationId}
            csrfToken={csrfToken}
            refresh={refresh}
            projectionStale={projectionStale}
          />
        ))}
      </ul>
    </section>
  );
}

function OfficeRunInput({
  input,
  conversationId,
  csrfToken,
  refresh,
  projectionStale,
}: {
  input: OfficeInput;
  conversationId: string;
  csrfToken: string | null;
  refresh: () => void;
  projectionStale: boolean;
}) {
  const [state, setState] = useState<'idle' | 'revoking' | 'confirmed' | 'unconfirmed'>('idle');
  const inFlight = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [conversationId, csrfToken],
  );

  async function revoke() {
    if (
      !csrfToken ||
      inFlight.current ||
      !window.confirm(
        '撤销后不能再读取此原件及其派生文件；已下载的文件和已交付的消息不会被收回。确定撤销？',
      )
    )
      return;
    const request = new AbortController();
    inFlight.current = request;
    setState('revoking');
    try {
      await revokeOfficeAttachment({
        id: input.attachment_id,
        conversationId,
        csrfToken,
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      setState('confirmed');
      refresh();
    } catch {
      if (!request.signal.aborted) {
        setState('unconfirmed');
        refresh();
      }
    } finally {
      if (inFlight.current === request) inFlight.current = null;
    }
  }

  const revoked = state === 'confirmed' || input.status === 'revoked';
  return (
    <li>
      <p>
        {input.role === 'notes' ? '纪要' : '任务表'} · {input.filename} ·{' '}
        {input.format === 'markdown' ? 'Markdown' : input.format.toUpperCase()} ·{' '}
        {revoked
          ? '已撤销'
          : projectionStale
            ? '状态未确认'
            : input.status === 'expired'
              ? '已过期'
              : '可用'}
      </p>
      {state === 'unconfirmed' && !revoked ? (
        <p role="status">撤销结果未确认，可重新核对或重试。</p>
      ) : null}
      {csrfToken && !revoked && !projectionStale ? (
        <Button
          type="button"
          variant="glass"
          color="default"
          className="min-h-11"
          disabled={state === 'revoking'}
          onClick={() => void revoke()}
        >
          {state === 'revoking' ? '正在撤销…' : `撤销 ${input.filename}`}
        </Button>
      ) : null}
    </li>
  );
}

export function OfficeRunResultsPanel({
  conversationId,
  results,
  retryRead,
  projectionStale = false,
}: {
  conversationId: string;
  results: OfficeRunResults;
  retryRead: () => void;
  projectionStale?: boolean;
}) {
  const { files, reminder } = results;
  return (
    <section
      aria-label="资料交付与提醒"
      className="min-w-0 space-y-4 border-t border-separator pt-3 [overflow-wrap:anywhere]"
    >
      <div className="space-y-2">
        <h3 className="font-medium">文件交付</h3>
        {files.length ? (
          <ul className="space-y-2">
            {files.map((artifact) => {
              const href = projectionStale ? null : officeDownloadHref(conversationId, artifact);
              return (
                <li key={artifact.id}>
                  <p>
                    {artifact.filename} · {artifact.format === 'markdown' ? 'Markdown' : 'CSV'}
                  </p>
                  {href ? (
                    <a
                      className="inline-flex min-h-11 items-center text-brand-ink underline"
                      href={href}
                      download
                    >
                      下载 {artifact.filename}
                    </a>
                  ) : (
                    <p className="text-secondary-foreground">
                      {projectionStale
                        ? '已记录交付，当前可用性未能确认。'
                        : artifact.status === 'expired'
                          ? '文件已交付，现已过期。'
                          : artifact.status === 'revoked'
                            ? '文件已交付，现已撤销。'
                            : '文件已交付，尚无可核验的下载入口。'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>{projectionStale ? '未能读取文件状态。' : '此次读取未见已核验的交付文件。'}</p>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="font-medium">站内提醒</h3>
        {reminder.state === 'created' ? (
          <>
            <p>
              提醒已创建。
              {projectionStale ? '当前状态未能读取。' : `当前状态：${reminder.currentStatus}。`}
            </p>
            {uuid.safeParse(reminder.taskId).success ? (
              <Link
                className="inline-flex min-h-11 items-center text-brand-ink underline"
                href={`/tasks/${reminder.taskId}`}
              >
                查看提醒记录
              </Link>
            ) : null}
          </>
        ) : (
          <p>{projectionStale ? '未能读取提醒状态。' : '提醒状态未确认。'}</p>
        )}
      </div>
      {projectionStale || reminder.state === 'unconfirmed' ? (
        <Button
          type="button"
          variant="glass"
          color="default"
          className="min-h-11"
          onClick={retryRead}
        >
          重新读取资料结果
        </Button>
      ) : null}
    </section>
  );
}
