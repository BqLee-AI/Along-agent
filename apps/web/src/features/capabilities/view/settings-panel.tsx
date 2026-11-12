'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { SettingsNav } from './settings-nav';

export function SettingsPanel({
  pathname,
  onClose,
  children,
}: {
  pathname: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Mount closed, then open, so the enter transition runs; leave the route after the exit transition (duration-200).
  // Backdrop blur is only on while the panel is at rest (see globals.css): animating it is what drops frames.
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setOpen(true);
    const settle = window.setTimeout(() => setSettled(true), 280);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(closeTimer.current);
    };
  }, []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSettled(false);
          window.clearTimeout(closeTimer.current);
          closeTimer.current = window.setTimeout(onClose, 200);
        }
      }}
    >
      <Dialog.Content
        material="panel"
        data-testid="settings-panel"
        initialFocus={() => document.querySelector<HTMLElement>('[data-testid="settings-panel"]')}
        data-settled={settled ? '' : undefined}
        className="h-[calc(100dvh-2rem)] max-w-5xl! flex-col gap-0 overflow-hidden! p-0 outline-none focus-visible:outline-none lg:h-[min(80dvh,680px)] lg:flex-row"
      >
        <aside className="shrink-0 overflow-y-auto border-b border-separator bg-foreground/5 p-3 max-lg:max-h-44 lg:w-52 lg:border-r lg:border-b-0">
          <Dialog.Title className="px-2.5 pt-1 pb-4 text-base font-semibold">设置</Dialog.Title>
          <SettingsNav pathname={pathname} />
        </aside>
        <div
          className="@container/workspace min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-6 pb-10 sm:px-8"
          data-testid="workspace-body"
        >
          {children}
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
