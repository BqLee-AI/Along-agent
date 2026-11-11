'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { prepareHistoryNavigation } from '@/features/conversations/model/stream-navigation';
import { isSettingsPath } from '@/features/capabilities/model/capabilities';
import { shellLocation, workspaceHref } from '../model/navigation';

export function useWorkspaceShell() {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams().toString();
  const router = useRouter();
  const location = shellLocation(pathname, search);
  const [current, setCurrent] = useState({
    key: location.identityKey,
    selection: location.selection,
  });
  if (location.explicit && !location.invalid && location.identityKey !== current.key) {
    setCurrent({ key: location.identityKey, selection: location.selection });
  }
  const selection = location.explicit && !location.invalid ? location.selection : current.selection;
  const firstFocus = useRef(true);
  const afterSettings = useRef(false);
  useLayoutEffect(prepareHistoryNavigation, []);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    // The settings dialog manages its own focus; refocusing the shell behind it (or right after it closes) draws stray focus rings.
    const settings = isSettingsPath(pathname);
    const skip = settings || afterSettings.current;
    afterSettings.current = settings;
    if (skip || location.authPage) return;
    const target = location.workspaceOpen
      ? document.querySelector<HTMLElement>('[data-testid="workspace-body"] h1')
      : document.getElementById('workspace-toggle');
    if (target) {
      if (location.workspaceOpen) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }, [pathname, location.workspaceOpen, location.authPage]);
  const href = (target: string) => workspaceHref(target, selection);
  const switchSurface = (open: boolean) => {
    const query = new URLSearchParams(search);
    if (open) query.delete('surface');
    else query.set('surface', 'chat');
    const target = pathname === '/conversations' ? '/' : pathname;
    router.push(workspaceHref(`${target}${query.size ? `?${query}` : ''}`, selection), {
      scroll: false,
    });
  };
  return { pathname, location, selection, href, switchSurface };
}
