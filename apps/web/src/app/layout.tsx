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
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <header className="site-header">
          <Link className="brand" href="/">
            Along
          </Link>
          <nav aria-label="主要导航">
            <Link href="/">今日</Link>
            <Link href="/conversations">对话</Link>
            <Link href="/approvals">确认</Link>
            <Link href="/tasks">任务</Link>
            <Link href="/activity">活动</Link>
            <Link href="/account">账户</Link>
          </nav>
        </header>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
