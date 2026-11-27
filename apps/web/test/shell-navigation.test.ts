import { describe, expect, it } from 'bun:test';
import { shellLocation, workspaceHref } from '../src/shell/model/navigation';

const conversationId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const botId = '44444444-4444-4444-8444-444444444444';
const newsEditionId = '55555555-5555-4555-8555-555555555555';
const selection = { botId, conversationId, runId, initialIntent: null };

describe('workspace URL ownership', () => {
  it('preserves the current conversation while retaining resource filters, opaque cursors and fragments', () => {
    const target = new URL(
      workspaceHref('/tasks?state=cancel_pending&cursor=original%2B%2F%3D#events', selection),
      'http://local.test',
    );
    expect(target.pathname).toBe('/tasks');
    expect(target.searchParams.get('state')).toBe('cancel_pending');
    expect(target.searchParams.get('cursor')).toBe('original+/=');
    expect(target.searchParams.get('bot_id')).toBe(botId);
    expect(target.searchParams.get('conversation_id')).toBe(conversationId);
    expect(target.searchParams.get('run_id')).toBe(runId);
    expect(target.hash).toBe('#events');
  });
  it('does not overwrite an explicit different identity or repair a malformed destination', () => {
    const explicit = '/tasks?conversation_id=33333333-3333-4333-8333-333333333333';
    expect(workspaceHref(explicit, selection)).toBe(explicit);
    expect(workspaceHref('/tasks?run_id=bad', selection)).toBe('/tasks?run_id=bad');
    expect(workspaceHref(`/tasks?bot_id=${botId}`, selection)).toBe(`/tasks?bot_id=${botId}`);
  });
  it.each([
    '/conversations',
    '/conversations?intent=document',
    '/login?returnTo=%2Ftasks',
    '/logout',
    'https://external.test/tasks',
    '//external.test/tasks',
    '/api/v1/tasks',
  ])('leaves explicit new/history/auth/non-workspace destinations untouched: %s', (href) => {
    expect(workspaceHref(href, selection)).toBe(href);
  });
  it('restores a conversation without requiring a Run and does not reinterpret its intent', () => {
    const location = shellLocation('/tasks', `conversation_id=${conversationId}&intent=document`);
    expect(location.invalid).toBe(false);
    expect(location.selection).toEqual({
      botId: null,
      conversationId,
      runId: null,
      initialIntent: null,
    });
    expect(location.workspaceOpen).toBe(true);
  });
  it.each([
    'bot_id=invalid',
    `bot_id=${botId}&bot_id=${botId}`,
    `run_id=${runId}`,
    'conversation_id=invalid',
    `conversation_id=${conversationId}&conversation_id=${conversationId}`,
    `conversation_id=${conversationId}&run_id=${runId}&run_id=${runId}`,
    `news_edition_id=${newsEditionId}`,
    `conversation_id=${conversationId}&news_edition_id=invalid`,
    `conversation_id=${conversationId}&news_edition_id=${newsEditionId}&news_edition_id=${newsEditionId}`,
  ])('rejects ambiguous or invalid identity without choosing a partial target: %s', (query) => {
    const location = shellLocation('/conversations', query);
    expect(location.invalid).toBe(true);
    expect(location.selection.botId).toBeNull();
    expect(location.selection.conversationId).toBeNull();
    expect(location.selection.runId).toBeNull();
  });
  it('distinguishes a retained workspace surface from explicit new conversation selection', () => {
    expect(shellLocation('/tasks', 'surface=chat')).toMatchObject({
      explicit: false,
      workspaceOpen: false,
    });
    expect(shellLocation('/tasks', '')).toMatchObject({ explicit: false, workspaceOpen: true });
    expect(shellLocation('/conversations', 'intent=reminder')).toMatchObject({
      explicit: true,
      workspaceOpen: false,
      selection: { botId: null, conversationId: null, runId: null, initialIntent: 'reminder' },
    });
  });
  it('retains a selected Bot whose conversation has not been created', () => {
    const location = shellLocation('/conversations', `bot_id=${botId}&intent=document`);
    expect(location).toMatchObject({
      invalid: false,
      explicit: true,
      selection: { botId, conversationId: null, runId: null, initialIntent: 'document' },
    });
    expect(workspaceHref('/tasks', location.selection)).toBe(
      `/tasks?bot_id=${botId}&intent=document`,
    );
  });
  it('retains the edition reference when opening a workspace page from a discussion', () => {
    const location = shellLocation(
      '/conversations',
      `bot_id=${botId}&conversation_id=${conversationId}&news_edition_id=${newsEditionId}`,
    );
    expect(location.invalid).toBe(false);
    expect(location.selection.newsEditionId).toBe(newsEditionId);
    expect(workspaceHref('/news', location.selection)).toBe(
      `/news?bot_id=${botId}&conversation_id=${conversationId}&news_edition_id=${newsEditionId}`,
    );
    expect(workspaceHref(`/conversations?bot_id=${botId}`, location.selection)).toBe(
      `/conversations?bot_id=${botId}`,
    );
  });
});
