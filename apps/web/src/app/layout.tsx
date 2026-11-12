import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '@/shell/view/app-shell';
import { AppTheme } from '@/shared/ui/app-theme';
import { parseThemeMode, THEME_COOKIE } from '@/shared/ui/theme-mode';
import { apiGet } from '@/shared/http/server';
import type { Me } from '@/shared/session/identity';

export const metadata: Metadata = {
  title: 'Along',
  description: 'Along 个人助理：聊想法、理思绪，照顾每天的大小事。',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const identity = await apiGet<Me>('/api/v1/me');
  const displayName = identity.ok ? identity.data.user.display_name : null;
  const mode = parseThemeMode((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="zh-CN"
      className={mode === 'dark' ? 'lumen-ui dark' : 'lumen-ui'}
      data-preset="linen"
    >
      <body>
        <AppTheme initialMode={mode}>
          <a
            className="sr-only fixed left-4 top-4 z-[60] px-4 py-3 focus:not-sr-only"
            href="#main-content"
          >
            跳到主要内容
          </a>
          <Suspense
            fallback={
              <div
                className="flex min-h-dvh items-center justify-center text-sm text-secondary-foreground"
                role="status"
              >
                正在读取工作区…
              </div>
            }
          >
            <AppShell displayName={displayName}>{children}</AppShell>
          </Suspense>
        </AppTheme>
      </body>
    </html>
  );
}
