import type { ReactNode } from 'react';
import { Card } from '@lorelum/lumen-ui/components/card';
import { PageHeading } from '@/shared/ui/page';
import { Brand } from '@/shared/ui/brand';
import type { AccountView } from '../model/account';

/** `account` is the inline profile page; every other kind is a focused panel without the shell. */
export type AccountFrameKind = AccountView | 'standalone';

export function AccountFrame({
  view,
  title,
  description,
  children,
}: {
  view: AccountFrameKind;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div
      className={
        view === 'account'
          ? 'min-w-0 space-y-7 [overflow-wrap:anywhere]'
          : 'mx-auto w-full min-w-0 max-w-md space-y-7 px-5 py-8 [overflow-wrap:anywhere] sm:py-12'
      }
    >
      {view !== 'account' ? (
        <a
          href="/"
          aria-label="Along 首页"
          className="inline-flex min-h-8 max-lg:min-h-11 items-center rounded-lg text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Brand height={24} />
        </a>
      ) : null}
      <PageHeading title={title} description={description} />
      {view === 'account' ? (
        <div className="min-w-0 space-y-7">{children}</div>
      ) : (
        <Card material="panel" shadow="sm" className="gap-0 px-5 py-6 sm:px-7">
          <div className="min-w-0 space-y-7">{children}</div>
        </Card>
      )}
    </div>
  );
}
