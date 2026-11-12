'use client';

import { createContext } from 'react';
export const WorkspaceNavigationContext = createContext<((href: string) => string) | null>(null);
