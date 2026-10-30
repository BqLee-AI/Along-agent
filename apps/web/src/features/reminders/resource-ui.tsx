'use client';

import Link from 'next/link';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { loginHref } from '@/lib/account-navigation';
import { failureExplanation, taskStateLabel, type ResourceFailure } from './data';
import type { ReactNode } from 'react';

export function ResourceError({
  error,
  returnTo,
  children,
}: {
  error: ResourceFailure;
  returnTo: string;
  children?: ReactNode;
}) {
  return (
    <Alert color="danger" role="alert" className="[overflow-wrap:anywhere]">
      <Alert.Content>
        <Alert.Title>此区域未能读取</Alert.Title>
        <Alert.Description className="space-y-3">
          <p>{failureExplanation(error)}</p>
          <details className="text-sm">
            <summary className="cursor-pointer py-2">诊断信息</summary>
            <dl className="space-y-1 font-mono">
              <dt>HTTP</dt>
              <dd>{error.status || '连接未建立'}</dd>
              {error.code ? (
                <>
                  <dt>领域代码</dt>
                  <dd>{error.code}</dd>
                </>
              ) : null}
              {error.requestId ? (
                <>
                  <dt>request_id</dt>
                  <dd>{error.requestId}</dd>
                </>
              ) : null}
            </dl>
          </details>
          {error.status === 401 ? (
            <Button
              variant="glass"
              color="default"
              role="link"
              nativeButton={false}
              render={<Link href={loginHref(returnTo)} />}
            >
              重新登录
            </Button>
          ) : (
            children
          )}
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

export function TaskState({ state }: { state: string }) {
  return <Badge variant="glass">{taskStateLabel(state)}</Badge>;
}

export function PageControls({
  count,
  nextCursor,
  busy,
  load,
  noun,
}: {
  count: number;
  nextCursor: string | null;
  busy: boolean;
  load: () => Promise<void>;
  noun: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
      <p className="text-sm text-muted-foreground" role="status">
        已加载 {count} 条{noun} ·{' '}
        {nextCursor === null ? '本次读取范围已到末页' : '仍有后续页未读取'}
      </p>
      {nextCursor !== null ? (
        <Button variant="glass" color="default" disabled={busy} onClick={() => void load()}>
          {busy ? '正在读取…' : `继续读取${noun}`}
        </Button>
      ) : null}
    </div>
  );
}
