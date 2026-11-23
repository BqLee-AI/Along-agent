'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell,
  Brain,
  CalendarDays,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  UserRound,
} from 'lucide-react';
import { AppShell as LumenAppShell } from '@lorelum/lumen-ui/pro/app-shell';
import ConversationPane from '@/features/conversations/view/conversation-pane';
import type { OfficeSession } from '@/features/conversations/model/office-materials';
import { isSettingsPath } from '@/features/capabilities/model/capabilities';
import { ModelCatalogProvider } from '@/features/model-settings/viewmodel/model-catalog-context';
import { SettingsPanel } from '@/features/capabilities/view/settings-panel';
import { ErrorNotice } from '@/shared/ui/page';
import { headerIconClass } from '@/shared/ui/header-icon';
import { ThemeToggle } from '@/shared/ui/theme-toggle';
import { workspaceItems } from '../model/navigation';
import { useWorkspaceShell } from '../viewmodel/use-workspace-shell';
import WorkspaceLink from './workspace-link';
import { WorkspaceNavigationContext } from '../viewmodel/workspace-navigation-context';

const icons = { today: CalendarDays, reminders: Bell, memory: Brain, profile: UserRound };

export function AppShell({
  children,
  displayName,
  officeViewer,
  officeSession,
}: {
  children: ReactNode;
  displayName: string | null;
  officeViewer: OfficeSession | undefined;
  officeSession: OfficeSession | undefined;
}) {
  const { pathname, location: rawLocation, selection, href, switchSurface } = useWorkspaceShell();
  const router = useRouter();
  const [settingsPending, setSettingsPending] = useState(false);
  const settingsRoute = isSettingsPath(pathname);
  const settingsOpen = settingsRoute || settingsPending;
  useEffect(() => {
    if (settingsRoute) setSettingsPending(false);
  }, [settingsRoute]);
  const location = settingsOpen ? { ...rawLocation, workspaceOpen: false } : rawLocation;
  if (location.authPage)
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-dvh min-w-0 items-center justify-center px-4 py-10 sm:px-6"
      >
        {children}
      </main>
    );
  const active =
    pathname === '/' || /^\/(approvals|activity|document-approvals)(\/|$)/.test(pathname)
      ? '/'
      : /^\/tasks(?:\/|$)/.test(pathname)
        ? '/tasks'
        : /^\/memories(?:\/|$)/.test(pathname)
          ? '/memories'
          : /^\/(profile|journal)(\/|$)/.test(pathname)
            ? '/profile'
            : null;
  const settingsLink = (
    <WorkspaceLink
      href="/account"
      onClick={() => setSettingsPending(true)}
      aria-label="设置"
      title="设置"
      className={headerIconClass}
    >
      <Settings className="size-4" aria-hidden="true" />
    </WorkspaceLink>
  );
  return (
    <WorkspaceNavigationContext value={href}>
      <ModelCatalogProvider>
        <LumenAppShell
          className="flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-background"
          data-testid="workspace-shell"
        >
          <LumenAppShell.Main
            id="main-content"
            tabIndex={-1}
            scroll="panels"
            className="flex w-full min-h-0 min-w-0 flex-1 flex-row"
          >
            <div
              className={`${location.workspaceOpen ? 'hidden lg:flex' : 'flex w-full'} min-h-0 min-w-0 flex-col lg:flex-1`}
              data-testid="persistent-chat-pane"
            >
              <div className={location.invalid ? 'hidden' : 'flex min-h-0 w-full min-w-0 flex-1'}>
                <ConversationPane
                  key={officeViewer?.ownerId ?? 'unsigned'}
                  {...selection}
                  {...(officeSession ? { officeSession } : {})}
                  officeHistoryCsrf={officeViewer?.csrfToken ?? null}
                  sidebar={!location.workspaceOpen}
                  headerActions={
                    location.workspaceOpen ? null : (
                      <>
                        <ThemeToggle />
                        {settingsLink}
                        <button
                          type="button"
                          id="workspace-toggle"
                          data-testid="workspace-toggle"
                          className={headerIconClass}
                          aria-controls="assistant-workspace"
                          aria-expanded={false}
                          aria-label="展开工作区"
                          title="展开工作区"
                          onClick={() => switchSurface(true)}
                        >
                          <PanelRightOpen className="size-4" aria-hidden="true" />
                        </button>
                      </>
                    )
                  }
                />
              </div>
              {location.invalid ? (
                <section className="mx-auto w-full max-w-xl space-y-5 p-6">
                  <h1 className="text-2xl leading-8 font-semibold">会话地址无法读取</h1>
                  <ErrorNotice message="会话或运行地址无效，未读取或执行该地址中的操作。" />
                  <Link
                    className="inline-flex min-h-11 items-center text-brand-ink underline"
                    href="/conversations"
                  >
                    打开新对话
                  </Link>
                </section>
              ) : null}
            </div>
            <section
              id="assistant-workspace"
              aria-label="助理工作区"
              className={`${location.workspaceOpen ? 'flex w-full lg:w-1/2 lg:border-l' : 'hidden lg:flex lg:w-0'} min-h-0 min-w-0 flex-col overflow-hidden border-separator bg-background lg:shrink-0 lg:transition-[width] lg:duration-300 lg:ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none`}
              data-testid="assistant-workspace"
              inert={!location.workspaceOpen}
            >
              <div className="flex min-h-0 w-full flex-1 flex-col lg:w-[50vw]">
                <header className="flex h-12 shrink-0 items-stretch justify-between gap-2 border-b border-separator bg-background px-3 sm:px-4">
                  <nav aria-label="工作区导航" className="flex min-w-0 items-stretch gap-1">
                    {workspaceItems.map((item) => (
                      <WorkspaceLink
                        key={item.href}
                        href={item.href}
                        aria-current={active === item.href ? 'page' : undefined}
                        className={`relative -mb-px inline-flex min-h-11 min-w-11 items-center justify-center border-b-2 px-2.5 text-[13px] leading-5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring lg:min-h-0 ${active === item.href ? 'border-brand-ink font-medium text-brand-ink' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                      >
                        <span>{item.label}</span>
                      </WorkspaceLink>
                    ))}
                  </nav>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <ThemeToggle />
                    <WorkspaceLink
                      href="/account"
                      onClick={() => setSettingsPending(true)}
                      aria-label="设置"
                      title="设置"
                      className={`${headerIconClass} ${isSettingsPath(pathname) ? 'bg-muted text-foreground' : ''}`}
                    >
                      <Settings className="size-4" aria-hidden="true" />
                    </WorkspaceLink>
                    <button
                      type="button"
                      aria-label="收起工作区"
                      className={headerIconClass}
                      onClick={() => switchSurface(false)}
                    >
                      <PanelRightClose className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </header>
                <div
                  className="@container/workspace min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background px-4 pt-6 pb-12 sm:px-6 lg:px-8"
                  data-testid="workspace-body"
                >
                  {settingsOpen ? null : children}
                </div>
              </div>
            </section>
          </LumenAppShell.Main>
          <nav
            aria-label="移动端主要导航"
            className="grid shrink-0 grid-cols-5 border-t border-separator bg-background px-1 pb-[env(safe-area-inset-bottom)] lg:hidden"
          >
            <button
              type="button"
              aria-current={!location.workspaceOpen ? 'page' : undefined}
              className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-2 focus-visible:outline-ring ${!location.workspaceOpen ? 'font-medium text-brand-ink' : 'text-secondary-foreground'}`}
              onClick={() => switchSurface(false)}
            >
              <MessageSquareText className="size-5" aria-hidden="true" />
              聊天
            </button>
            {workspaceItems.map((item) => {
              const Icon = icons[item.icon];
              return (
                <WorkspaceLink
                  key={item.href}
                  href={item.href}
                  aria-current={location.workspaceOpen && active === item.href ? 'page' : undefined}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-2 focus-visible:outline-ring ${location.workspaceOpen && active === item.href ? 'font-medium text-brand-ink' : 'text-secondary-foreground'}`}
                >
                  <Icon className="size-5" aria-hidden="true" />
                  {item.label}
                </WorkspaceLink>
              );
            })}
          </nav>
          {settingsOpen ? (
            <SettingsPanel
              pathname={pathname}
              onClose={() => {
                setSettingsPending(false);
                router.push(href('/conversations'));
              }}
            >
              {settingsRoute ? children : null}
            </SettingsPanel>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {displayName ? '账户信息已加载' : '账户状态以账户页为准'}
          </span>
        </LumenAppShell>
      </ModelCatalogProvider>
    </WorkspaceNavigationContext>
  );
}
