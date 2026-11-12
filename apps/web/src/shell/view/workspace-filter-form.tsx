'use client';

import { useContext } from 'react';
import type { ComponentProps } from 'react';
import Form from 'next/form';
import { WorkspaceNavigationContext } from '../viewmodel/workspace-navigation-context';

// Next's GET form navigation keeps the shell mounted. Hidden identity fields
// survive HTML GET query replacement without turning a filter into an action.
export function WorkspaceFilterForm({
  action,
  children,
  ...props
}: Omit<ComponentProps<typeof Form>, 'action'> & { action: string }) {
  const href = useContext(WorkspaceNavigationContext);
  const destination = new URL(href ? href(action) : action, 'http://navigation.internal');
  return (
    <Form {...props} action={destination.pathname}>
      {Array.from(destination.searchParams, ([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
    </Form>
  );
}
