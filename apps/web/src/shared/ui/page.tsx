'use client';

import type { ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';
import { Alert } from '@lorelum/lumen-ui/components/alert';

export function PageHeading({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-xs leading-4 font-medium text-muted-foreground">{eyebrow}</p>
        )}
        <h1 className="text-xl leading-7 font-semibold tracking-tight">{title}</h1>
        {description && (
          <div className="mt-0.5 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-dashed border-border px-6 py-10">
      <div className="flex max-w-md flex-col items-start">
        <Inbox className="mb-3 size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        <h3 className="text-sm leading-5 font-medium">{title}</h3>
        {description && (
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
        )}
        {children && <div className="mt-4 flex flex-wrap items-center gap-3">{children}</div>}
      </div>
    </section>
  );
}

export function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <Alert color="danger" role="alert" variant="glass">
      <Alert.Icon>
        <AlertCircle aria-hidden="true" />
      </Alert.Icon>
      <Alert.Content>
        <Alert.Title>这部分暂时无法完成</Alert.Title>
        <Alert.Description className="break-words [overflow-wrap:anywhere]">
          <p>{message}</p>
          {children && <div className="mt-3 flex flex-wrap gap-3">{children}</div>}
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
