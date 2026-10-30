'use client';

import { Fragment, useLayoutEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarDays,
  CheckCheck,
  ChevronDown,
  Clock3,
  History,
  LogIn,
  MessageSquareText,
  UserRound,
} from 'lucide-react';
import { Dropdown } from '@lorelum/lumen-ui/components/dropdown';
import { Button } from '@lorelum/lumen-ui/components/button';
import { prepareHistoryNavigation } from '@/lib/stream-navigation';

const matters = [
  { href: '/', label: '今日安排', description: '看看今天的提醒和待确认事项', icon: CalendarDays },
  { href: '/tasks', label: '我的提醒', description: '查看提醒与执行结果', icon: Clock3 },
  {
    href: '/approvals',
    label: '待我确认',
    description: '审阅提醒方案，再决定是否执行',
    icon: CheckCheck,
  },
  { href: '/activity', label: '活动记录', description: '需要时核对已记录的步骤', icon: History },
];

const menuClass = 'min-w-60 max-w-[calc(100vw-2rem)]';
const itemClass = 'min-h-11 gap-3 py-2.5';

export function AppShell({
  children,
  displayName,
}: {
  children: ReactNode;
  displayName: string | null;
}) {
  useLayoutEffect(prepareHistoryNavigation, []);
  const pathname = usePathname() ?? '/';
  const authPage = ['/login', '/setup', '/claim', '/logout'].includes(pathname);
  const conversationPage = pathname === '/conversations';
  const mattersActive = ['/tasks', '/approvals', '/activity', '/document-approvals'].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (authPage)
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-dvh items-center justify-center px-6 py-12 sm:py-16"
      >
        {children}
      </main>
    );
  return (
    <div
      className={
        conversationPage ? 'flex h-dvh min-w-0 flex-col overflow-hidden' : 'min-h-dvh min-w-0'
      }
    >
      <header className="sticky top-0 z-30 h-16 shrink-0 bg-background">
        <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-8">
          <Link
            href="/"
            aria-label="Along 首页"
            className="inline-flex min-h-11 shrink-0 items-center text-xl font-semibold tracking-tight"
          >
            Along<span className="text-primary">.</span>
          </Link>
          <nav aria-label="主要导航" className="flex items-center gap-1 sm:gap-2">
            <Button
              role="link"
              nativeButton={false}
              render={<Link href="/conversations" />}
              aria-current={conversationPage ? 'page' : undefined}
              variant={conversationPage || pathname === '/' ? 'flat' : 'clear'}
              color={conversationPage || pathname === '/' ? 'primary' : 'default'}
            >
              <MessageSquareText aria-hidden="true" className="hidden size-4 sm:block" />
              助理
            </Button>
            <Dropdown modal={false}>
              <Dropdown.Trigger
                render={
                  <Button
                    variant={mattersActive ? 'flat' : 'clear'}
                    color={mattersActive ? 'primary' : 'default'}
                  />
                }
              >
                事项
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </Dropdown.Trigger>
              <Dropdown.Content align="center" sideOffset={12} className={menuClass}>
                <Dropdown.Group>
                  <Dropdown.Label>日常安排</Dropdown.Label>
                  {matters.map(({ href, label, description, icon: Icon }, index) => (
                    <Fragment key={href}>
                      {index === 3 && <Dropdown.Separator />}
                      <Dropdown.Item
                        render={<Link href={href} />}
                        className={itemClass}
                        label={label}
                        aria-current={
                          pathname === href || (href !== '/' && pathname.startsWith(`${href}/`))
                            ? 'page'
                            : undefined
                        }
                      >
                        <Icon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                          strokeWidth={1.75}
                        />
                        <span>
                          <span className="block font-medium">{label}</span>
                          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                            {description}
                          </span>
                        </span>
                      </Dropdown.Item>
                    </Fragment>
                  ))}
                </Dropdown.Group>
              </Dropdown.Content>
            </Dropdown>
          </nav>
          <Dropdown modal={false}>
            <Dropdown.Trigger
              render={<Button variant="clear" color="default" size="icon" className="shrink-0" />}
              aria-label={displayName ? `${displayName}，账户菜单` : '账户菜单'}
            >
              <UserRound aria-hidden="true" className="size-4" />
            </Dropdown.Trigger>
            <Dropdown.Content align="end" sideOffset={12} className={menuClass}>
              <Dropdown.Group>
                <Dropdown.Label className="max-w-64 break-words">
                  {displayName ?? '欢迎使用 Along'}
                </Dropdown.Label>
                <Dropdown.Separator />
                <Dropdown.Item render={<Link href="/account" />} className={itemClass}>
                  <UserRound aria-hidden="true" className="size-4" />
                  账户设置
                </Dropdown.Item>
                {!displayName && (
                  <Dropdown.Item render={<Link href="/login" />} className={itemClass}>
                    <LogIn aria-hidden="true" className="size-4" />
                    登录
                  </Dropdown.Item>
                )}
              </Dropdown.Group>
            </Dropdown.Content>
          </Dropdown>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className={
          conversationPage
            ? 'flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden'
            : 'mx-auto w-full min-w-0 max-w-[1200px] px-5 py-8 sm:px-8 lg:py-12'
        }
      >
        {children}
      </main>
    </div>
  );
}
