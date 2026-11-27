import { z } from 'zod';
import type { TaskIntent } from '@/features/conversations/model/task';

export interface ConversationLocation {
  botId: string | null;
  conversationId: string | null;
  runId: string | null;
  initialIntent: TaskIntent | null;
  newsEditionId?: string;
}

export const workspaceItems = [
  { href: '/', label: '概览', icon: 'today' },
  { href: '/tasks', label: '提醒', icon: 'reminders' },
  { href: '/memories', label: '记忆', icon: 'memory' },
  { href: '/profile', label: '助理', icon: 'profile' },
] as const;

const protectedWorkspace =
  /^\/(?:tasks|approvals|activity|document-approvals|account|models|memories|materials|profile|journal|skills|connectors|channels|devices|todos|settings|news)(?:\/|$)/;
export function isWorkspacePath(pathname: string): boolean {
  return pathname === '/' || protectedWorkspace.test(pathname);
}

const uuid = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const routeIdentity = z.object({
  botId: uuid.nullable(),
  conversationId: uuid.nullable(),
  runId: uuid.nullable(),
});

export function shellLocation(pathname: string, search: string) {
  const query = new URLSearchParams(search);
  const conversation = query.getAll('conversation_id');
  const run = query.getAll('run_id');
  const bot = query.getAll('bot_id');
  const news = query.getAll('news_edition_id');
  const explicit =
    bot.length > 0 ||
    conversation.length > 0 ||
    run.length > 0 ||
    news.length > 0 ||
    pathname === '/conversations';
  const value = routeIdentity.safeParse({
    botId: bot[0] ?? null,
    conversationId: conversation[0] ?? null,
    runId: run[0] ?? null,
  });
  const newsEditionId = uuid.safeParse(news[0]);
  const invalid =
    !value.success ||
    bot.length > 1 ||
    conversation.length > 1 ||
    run.length > 1 ||
    news.length > 1 ||
    (news.length > 0 && (!newsEditionId.success || conversation.length === 0)) ||
    (run.length > 0 && conversation.length === 0);
  const initialIntent: TaskIntent =
    query.get('intent') === 'document'
      ? 'document'
      : query.get('intent') === 'reminder'
        ? 'reminder'
        : 'chat';
  const selection: ConversationLocation =
    value.success && !invalid
      ? {
          ...value.data,
          initialIntent: value.data.conversationId ? null : initialIntent,
          ...(newsEditionId.success ? { newsEditionId: newsEditionId.data } : {}),
        }
      : { botId: null, conversationId: null, runId: null, initialIntent };
  return {
    explicit,
    invalid,
    selection,
    identityKey: `${selection.botId ?? ''}:${selection.conversationId ?? ''}:${selection.runId ?? ''}:${selection.initialIntent ?? ''}:${selection.newsEditionId ?? ''}`,
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
    !target.searchParams.has('bot_id') &&
    !target.searchParams.has('conversation_id') &&
    !target.searchParams.has('run_id') &&
    !target.searchParams.has('news_edition_id')
  ) {
    if (selection.botId) target.searchParams.set('bot_id', selection.botId);
    if (selection.conversationId)
      target.searchParams.set('conversation_id', selection.conversationId);
    if (selection.runId) target.searchParams.set('run_id', selection.runId);
    if (selection.newsEditionId)
      target.searchParams.set('news_edition_id', selection.newsEditionId);
    if (
      selection.initialIntent &&
      selection.initialIntent !== 'chat' &&
      !target.searchParams.has('intent')
    )
      target.searchParams.set('intent', selection.initialIntent);
  }
  return `${target.pathname}${target.search}${target.hash}`;
}
