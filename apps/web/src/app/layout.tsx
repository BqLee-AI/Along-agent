import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { apiGet } from '@/lib/api';
import type { Me } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Along',
  description: '云端个人助理：简报、确认、提醒与活动账。',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const identity = await apiGet<Me>('/api/v1/me');
  const displayName = identity.ok ? identity.data.user.display_name : null;
  return (
    <html lang="zh-CN">
      <body>
        <a
          className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-card px-4 py-3 text-primary shadow-lg focus:not-sr-only"
          href="#main-content"
        >
          跳到主要内容
        </a>
        <AppShell displayName={displayName}>{children}</AppShell>
      </body>
    </html>
  );
}
