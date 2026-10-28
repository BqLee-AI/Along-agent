'use client';

import { useLayoutEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowUpRight,
  CalendarDays,
  CircleCheck,
  Clock3,
  History,
  MessageSquareText,
  Plus,
  UserRound,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { prepareHistoryNavigation } from '@/lib/stream-navigation';

const destinations = [
  { href: '/', label: '今日', icon: CalendarDays },
  { href: '/conversations', label: '对话', icon: MessageSquareText },
  { href: '/approvals', label: '提醒确认', icon: CircleCheck },
  { href: '/tasks', label: '提醒任务', icon: Clock3 },
  { href: '/activity', label: '活动', icon: History },
];

function WorkspaceNavigation({
  pathname,
  displayName,
}: {
  pathname: string;
  displayName: string | null;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar>
      <SidebarHeader className="gap-6 px-4 pb-6 pt-6">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/"
            className="flex min-h-11 items-center gap-3 px-2"
            onClick={() => setOpenMobile(false)}
          >
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-lg bg-primary text-lg font-semibold text-white"
            >
              A
            </span>
            <span className="text-xl font-semibold tracking-tight">
              Along<span className="text-primary">.</span>
            </span>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpenMobile(false)}
            aria-label="关闭导航"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <Button asChild className="w-full justify-start">
          <Link href="/conversations" onClick={() => setOpenMobile(false)}>
            <Plus aria-hidden="true" />
            新任务
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent className="px-4">
        <nav aria-label="主要导航">
          <p className="mb-3 px-3 text-xs font-medium text-muted-foreground">工作台</p>
          <SidebarMenu className="gap-2">
            {destinations.map(({ href, label, icon: Icon }) => {
              const active =
                href === '/'
                  ? pathname === '/'
                  : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    className="min-h-11 px-3 text-sm data-[active=true]:border-l-2 data-[active=true]:border-primary"
                  >
                    <Link
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setOpenMobile(false)}
                    >
                      <Icon className="size-5!" strokeWidth={1.75} aria-hidden="true" />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-4 border-t border-border p-4">
        <Link
          href="/account"
          className="flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-3 text-sm hover:bg-accent"
          aria-current={pathname === '/account' ? 'page' : undefined}
          onClick={() => setOpenMobile(false)}
        >
          <UserRound className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{displayName ?? '账户与登录'}</span>
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
        <p className="px-3 text-xs leading-5 text-muted-foreground">提醒有记录，修改有依据。</p>
      </SidebarFooter>
    </Sidebar>
  );
}

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
  if (authPage)
    return (
      <main id="main-content" tabIndex={-1} className="min-h-dvh px-6 py-8 sm:py-12">
        {children}
      </main>
    );
  const section =
    destinations.find(({ href }) => (href === '/' ? pathname === '/' : pathname.startsWith(href)))
      ?.label ?? (pathname.startsWith('/document-approvals') ? '文档批准' : '账户');
  return (
    <SidebarProvider>
      <WorkspaceNavigation pathname={pathname} displayName={displayName} />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-4 lg:hidden">
          <SidebarTrigger />
          <span className="min-w-0 flex-1 text-sm font-medium">
            Along <span className="mx-2 text-border">/</span> {section}
          </span>
          <Button asChild size="icon" variant="ghost">
            <Link href="/account" aria-label="账户">
              <UserRound aria-hidden="true" />
            </Link>
          </Button>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-6 md:px-6 lg:px-10 lg:py-8"
        >
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
