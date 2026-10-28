import type { ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

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
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <p className="mb-2 text-sm font-medium text-primary">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold leading-[34px] lg:text-[28px] lg:leading-10">
          {title}
        </h1>
        {description && (
          <div className="mt-3 text-sm leading-[22px] text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
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
    <div className="rounded-xl border border-dashed border-border bg-card px-6 py-10">
      <Inbox className="mb-4 size-6 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <h3>{title}</h3>
      {description && (
        <p className="mt-2 max-w-xl text-sm leading-[22px] text-muted-foreground">{description}</p>
      )}
      {children && <div className="mt-4 flex flex-wrap gap-3">{children}</div>}
    </div>
  );
}

export function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <Alert variant="destructive" className="bg-card">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>这部分暂时无法完成</AlertTitle>
      <AlertDescription className="break-words [overflow-wrap:anywhere]">
        <p>{message}</p>
        {children && <div className="mt-3 flex flex-wrap gap-3 text-foreground">{children}</div>}
      </AlertDescription>
    </Alert>
  );
}
