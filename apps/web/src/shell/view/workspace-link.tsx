'use client';

import { useContext } from 'react';
import type { ComponentProps } from 'react';
import Link from 'next/link';

import { WorkspaceNavigationContext } from '../viewmodel/workspace-navigation-context';

// Only workspace links adopt the current conversation; explicit new/history and
// authentication destinations keep their own URL and execution semantics.
export default function WorkspaceLink({ href, ...props }: ComponentProps<typeof Link>) {
  const navigate = useContext(WorkspaceNavigationContext);
  return <Link {...props} href={typeof href === 'string' && navigate ? navigate(href) : href} />;
}
