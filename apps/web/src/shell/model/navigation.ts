import { z } from 'zod';
import type { TaskIntent } from '@/features/conversations/model/task';

export interface ConversationLocation {
  conversationId: string | null;
  runId: string | null;
  initialIntent: TaskIntent | null;
}

export const workspaceItems = [
  { href: '/', label: '概览', icon: 'today' },
  { href: '/tasks', label: '提醒', icon: 'reminders' },
  { href: '/memories', label: '记忆', icon: 'memory' },
  { href: '/profile', label: '助理', icon: 'profile' },
] as const;

const protectedWorkspace =
  /^\/(?:tasks|approvals|activity|document-approvals|account|models|memories|materials|profile|journal|skills|connectors|channels|devices|todos|settings)(?:\/|$)/;
export function isWorkspacePath(pathname: string): boolean {
  return pathname === '/' || protectedWorkspace.test(pathname);
}

export function shellLocation(pathname: string, search: string) {
  const query = new URLSearchParams(search);
  const conversation = query.getAll('conversation_id');
  const run = query.getAll('run_id');
  const explicit = conversation.length > 0 || run.length > 0 || pathname === '/conversations';
  const value = z
    .object({ conversationId: z.string().uuid(), runId: z.string().uuid().nullable() })
    .safeParse({ conversationId: conversation[0], runId: run[0] ?? null });
  const invalid =
    (conversation.length > 0 || run.length > 0) &&
    (!value.success || conversation.length !== 1 || run.length > 1);
  const initialIntent: TaskIntent =
    query.get('intent') === 'document'
      ? 'document'
      : query.get('intent') === 'reminder'
        ? 'reminder'
        : 'chat';
  const selection: ConversationLocation =
    value.success && !invalid
      ? { ...value.data, initialIntent: null }
      : { conversationId: null, runId: null, initialIntent };
  return {
    explicit,
    invalid,
    selection,
    identityKey: `${selection.conversationId ?? ''}:${selection.runId ?? ''}:${selection.initialIntent ?? ''}`,
    workspaceOpen: pathname !== '/conversations' && query.get('surface') !== 'chat',
    authPage:
      /^\/(?:login|setup|claim|logout|invite|reset-password|verify-contact|forgot-password)(?:\/|$)/.test(
        pathname,
      ),
  };
}

export function workspaceHref(href: string, selection: ConversationLocation): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const target = new URL(href, 'http://navigation.internal');
  if (!isWorkspacePath(target.pathname)) return href;
  if (
    !target.searchParams.has('conversation_id') &&
    !target.searchParams.has('run_id') &&
    selection.conversationId
  ) {
    target.searchParams.set('conversation_id', selection.conversationId);
    if (selection.runId) target.searchParams.set('run_id', selection.runId);
  }
  return `${target.pathname}${target.search}${target.hash}`;
}
