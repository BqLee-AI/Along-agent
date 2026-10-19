import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Along',
  description: '云端个人助理：简报、确认、提醒与活动账。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="site-header">
          <Link className="brand" href="/">
            Along
          </Link>
          <nav>
            <Link href="/">今日</Link>
            <Link href="/conversations">对话</Link>
            <Link href="/approvals">确认</Link>
            <Link href="/tasks">任务</Link>
            <Link href="/activity">活动</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
