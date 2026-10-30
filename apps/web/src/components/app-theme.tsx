'use client';

import type { ReactNode } from 'react';
import { LumenProvider } from '@lorelum/lumen-ui/themes';

export function AppTheme({ children }: { children: ReactNode }) {
  return (
    <LumenProvider mode="light" className="min-h-dvh bg-background text-foreground">
      {children}
    </LumenProvider>
  );
}
