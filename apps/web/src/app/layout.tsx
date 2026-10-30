import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { AppTheme } from '@/components/app-theme';
import { apiGet } from '@/lib/api';
import type { Me } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Along',
  description: 'Along 个人助理：聊想法、理思绪，照顾每天的大小事。',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const identity = await apiGet<Me>('/api/v1/me');
  const displayName = identity.ok ? identity.data.user.display_name : null;
  return (
    <html lang="zh-CN" className="lumen-ui" data-preset="linen">
      <body>
        <AppTheme>
          <a
            className="sr-only fixed left-4 top-4 z-[60] px-4 py-3 focus:not-sr-only"
            href="#main-content"
          >
            跳到主要内容
          </a>
          <AppShell displayName={displayName}>{children}</AppShell>
        </AppTheme>
      </body>
    </html>
  );
}
