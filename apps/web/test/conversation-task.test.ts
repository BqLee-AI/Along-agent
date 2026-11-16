import { describe, expect, it } from 'bun:test';
import type { ConversationRunHistoryItem, RunView, WorkspaceSummary } from '@along/contracts';
import {
  conversationSendBlocked,
  compactCommand,
  clarificationReplyReference,
  isNearChatBottom,
  taskAdmission,
  selectResumeRequest,
  taskIntentFromQuery,
  taskSendEligibility,
  shouldSubmitMessage,
} from '../src/features/conversations/model/task';
import { isSameReadingPage } from '../src/features/conversations/model/stream-navigation';

const workspace: WorkspaceSummary = {
  workspace_id: 'managed-copy',
  label: '受管资料',
  readable_paths: ['notes/long source.md'],
  writable_paths: [],
};

const documentDraft = {
  intent: 'document' as const,
  text: '核对资料中的日期，保留原文。',
  busy: false,
  workspaceState: 'ready' as const,
  workspaceId: workspace.workspace_id,
  workspaces: [workspace],
};

describe('explicit conversation task entry', () => {
  it('reserves compact commands and rejects arguments as ordinary messages', () => {
    expect(compactCommand('/compact')).toBe('compact');
    expect(compactCommand('  /compact  ')).toBe('compact');
    expect(compactCommand('/compact extra')).toBe('invalid');
    expect(compactCommand('please /compact')).toBeNull();
    expect(compactCommand('/compactly')).toBeNull();
  });

  it('opts plain Agent into delegation while preserving legacy shortcut admission without fallback', () => {
    expect(taskAdmission('reminder')).toEqual({ execution: 'business' });
    expect(taskAdmission('document')).toEqual({ execution: 'harness' });
    expect(taskAdmission('chat')).toEqual({
      execution: 'harness',
      authorization_revision: 'delegation/1',
    });
    expect(taskIntentFromQuery({ intent: 'reminder' })).toBe('reminder');
    expect(taskIntentFromQuery({ intent: 'document' })).toBe('document');
    expect(taskIntentFromQuery({ intent: 'harness' })).toBe('chat');
    expect(taskIntentFromQuery({ intent: ['document', 'reminder'] })).toBe('chat');
    expect(taskIntentFromQuery({})).toBe('chat');
  });

  it('sends a source reference only for an explicitly selected real clarification', () => {
    const run = {
      run_id: 'source',
      conversation_id: 'conversation',
      execution: 'harness',
      model_selection: { state: 'legacy_unavailable' },
      attempt_id: 'attempt',
      attempt_no: 1,
      waiting: null,
      can_resume: false,
      status: 'done',
      authorization_revision: 'delegation/1',
      goal_result: {
        status: 'blocked',
        outcomes: [{ description: '提醒', status: 'blocked', receipt_refs: [] }],
        clarification: { kind: 'target_selection', question: '哪一个？' },
        answer: '请选择。',
      },
    } as RunView;
    expect(clarificationReplyReference(run, 'chat', true)).toBe('source');
    expect(
      clarificationReplyReference(
        {
          ...run,
          goal_result: {
            ...run.goal_result!,
            clarification: { kind: 'destination', question: '保存到哪里？' },
          },
        },
        'chat',
        true,
      ),
    ).toBe('source');
    expect(clarificationReplyReference(run, 'chat', false)).toBeUndefined();
    expect(
      clarificationReplyReference({ ...run, status: 'running' }, 'chat', true),
    ).toBeUndefined();
    expect(
      clarificationReplyReference({ ...run, authorization_revision: undefined }, 'chat', true),
    ).toBeUndefined();
    expect(clarificationReplyReference(run, 'reminder', true)).toBeUndefined();
  });

  it('never applies an entry intent to a URL carrying any historical identity', () => {
    expect(taskIntentFromQuery({ intent: 'document', conversation_id: 'existing' })).toBeNull();
    expect(taskIntentFromQuery({ intent: 'reminder', run_id: 'existing' })).toBeNull();
    expect(taskIntentFromQuery({ intent: 'document', conversation_id: '' })).toBeNull();
    expect(taskIntentFromQuery({ intent: 'document', conversation_id: ['one', 'two'] })).toBeNull();
  });

  it('requires a successfully read, explicitly selected registration for documents', () => {
    expect(taskSendEligibility(documentDraft).allowed).toBe(true);
    expect(taskSendEligibility({ ...documentDraft, workspaceState: 'loading' }).allowed).toBe(
      false,
    );
    expect(taskSendEligibility({ ...documentDraft, workspaceState: 'error' }).allowed).toBe(false);
    expect(taskSendEligibility({ ...documentDraft, workspaceId: '' }).allowed).toBe(false);
    expect(
      taskSendEligibility({ ...documentDraft, workspaceId: 'not-returned-by-server' }).allowed,
    ).toBe(false);
    expect(taskSendEligibility({ ...documentDraft, workspaces: [] }).allowed).toBe(false);
    // A previous selection cannot authorize a registration that was removed on refresh.
    expect(
      taskSendEligibility({
        ...documentDraft,
        workspaces: [{ ...workspace, workspace_id: 'replacement' }],
      }).allowed,
    ).toBe(false);
  });

  it('permits a read-only registration without inventing write permission', () => {
    expect(workspace.writable_paths).toEqual([]);
    expect(taskSendEligibility(documentDraft).allowed).toBe(true);
  });

  it('allows ordinary chat without waiting for or selecting registered documents', () => {
    expect(
      taskSendEligibility({
        ...documentDraft,
        intent: 'chat',
        workspaceState: 'loading',
        workspaceId: '',
        workspaces: [],
      }).allowed,
    ).toBe(true);
    expect(
      taskSendEligibility({
        ...documentDraft,
        intent: 'chat',
        workspaceState: 'error',
        workspaceId: '',
        workspaces: [],
      }).allowed,
    ).toBe(true);
  });

  it('keeps reminders independent of document registration and requires explicit send eligibility', () => {
    expect(
      taskSendEligibility({
        ...documentDraft,
        intent: 'reminder',
        workspaceState: 'error',
        workspaceId: '',
        workspaces: [],
      }).allowed,
    ).toBe(true);
    expect(taskSendEligibility({ ...documentDraft, intent: null }).allowed).toBe(false);
    expect(taskSendEligibility({ ...documentDraft, text: ' \n\t' }).allowed).toBe(false);
    expect(taskSendEligibility({ ...documentDraft, busy: true }).allowed).toBe(false);
  });
});

const historicalRun: ConversationRunHistoryItem = {
  run_id: 'run-one',
  conversation_id: 'same-conversation',
  execution: 'harness',
  model_selection: { state: 'legacy_unavailable' },
  status: 'done',
  created_at: '2026-10-29T01:00:00.000000Z',
  ended_at: '2026-10-29T01:00:01.000000Z',
  original: {
    state: 'available',
    source: 'input_message',
    message: {
      message_id: 'original-one',
      content: 'same words',
      created_at: '2026-10-29T01:00:00.000000Z',
    },
  },
};

const restoredConversation = {
  busy: false,
  reading: false,
  readError: null,
  ready: true,
  selected: false,
  run: null,
  runs: [historicalRun],
  sendUncertain: false,
  effectsUnknown: false,
};

describe('conversation continuation safety', () => {
  it('allows a new turn only after the full readable conversation is restored', () => {
    expect(conversationSendBlocked(restoredConversation)).toBe(false);
    for (const pending of [
      { busy: true },
      { reading: true },
      { ready: false },
      { readError: 'event page failed' },
      { selected: true, run: null },
      { sendUncertain: true },
      { effectsUnknown: true },
    ]) {
      expect(conversationSendBlocked({ ...restoredConversation, ...pending })).toBe(true);
    }
  });

  it('cannot bypass an older paused, suspended or running Run by selecting a completed Run', () => {
    for (const status of ['running', 'suspended_approval', 'paused'] as const) {
      expect(
        conversationSendBlocked({
          ...restoredConversation,
          runs: [{ ...historicalRun, run_id: 'older', status }, historicalRun],
        }),
      ).toBe(true);
      expect(
        conversationSendBlocked({
          ...restoredConversation,
          selected: true,
          run: { status } as RunView,
        }),
      ).toBe(true);
    }
  });

  it('allows terminal failures and cancellations without treating them as active generation', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      expect(
        conversationSendBlocked({
          ...restoredConversation,
          selected: true,
          run: { status } as RunView,
          runs: [{ ...historicalRun, status }],
        }),
      ).toBe(false);
    }
  });
});

describe('active stream reading navigation', () => {
  it('allows anchors in either direction but treats a different run, resource or origin as departure', () => {
    const run = 'https://along.example/conversations?conversation_id=one&run_id=two';
    expect(isSameReadingPage(`${run}#latest-reply`, run)).toBe(true);
    expect(isSameReadingPage(run, `${run}#latest-reply`)).toBe(true);
    expect(isSameReadingPage(`${run}#run-results`, `${run}#latest-reply`)).toBe(true);
    expect(isSameReadingPage(run.replace('run_id=two', 'run_id=three'), run)).toBe(false);
    expect(isSameReadingPage('https://along.example/tasks', run)).toBe(false);
    expect(isSameReadingPage(run.replace('along.example', 'other.example'), run)).toBe(false);
  });
});

describe('chat input and scroll policy', () => {
  it('submits Enter without stealing newlines or IME confirmation', () => {
    const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
    expect(shouldSubmitMessage(enter)).toBe(true);
    expect(shouldSubmitMessage({ ...enter, shiftKey: true })).toBe(false);
    expect(shouldSubmitMessage({ ...enter, isComposing: true })).toBe(false);
    expect(shouldSubmitMessage({ ...enter, keyCode: 229 })).toBe(false);
    expect(shouldSubmitMessage({ ...enter, key: 'a' })).toBe(false);
  });

  it('only follows a reader who is already close to the latest message', () => {
    expect(isNearChatBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 })).toBe(true);
    expect(isNearChatBottom({ scrollHeight: 2000, scrollTop: 1350, clientHeight: 600 })).toBe(true);
    expect(isNearChatBottom({ scrollHeight: 2000, scrollTop: 1000, clientHeight: 600 })).toBe(
      false,
    );
    expect(isNearChatBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 600 })).toBe(true);
  });
});

describe('explicit resume identity', () => {
  it('reuses the same request for an eligible waiting point and refuses an ineligible server-owned Run', () => {
    const waiting = {
      checkpoint_id: '33333333-3333-4333-8333-333333333333',
      invocation_id: '44444444-4444-4444-8444-444444444444',
      approval_id: '55555555-5555-4555-8555-555555555555',
    };
    const previous = {
      checkpoint_id: waiting.checkpoint_id,
      idempotency_key: '66666666-6666-4666-8666-666666666666',
    };
    const run = {
      execution_lifecycle: 'server-owned' as const,
      can_resume: true,
      waiting,
      status: 'suspended_approval' as const,
    };
    expect(selectResumeRequest(run, previous)).toEqual(previous);
    expect(selectResumeRequest({ ...run, can_resume: false }, previous)).toBeNull();
    const next = selectResumeRequest(
      { ...run, waiting: { ...waiting, checkpoint_id: '77777777-7777-4777-8777-777777777777' } },
      previous,
    );
    expect(next?.checkpoint_id).not.toBe(previous.checkpoint_id);
    expect(next?.idempotency_key).not.toBe(previous.idempotency_key);
  });
});
