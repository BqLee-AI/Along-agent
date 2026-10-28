import { describe, expect, it } from 'bun:test';
import type { WorkspaceSummary } from '@along/contracts';
import {
  taskExecution,
  taskIntentFromQuery,
  taskSendEligibility,
} from '../src/features/conversations/task-model';
import { isSameReadingPage } from '../src/lib/stream-navigation';

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
  it('maps user intent to the existing execution contract without fallback', () => {
    expect(taskExecution('reminder')).toBe('business');
    expect(taskExecution('document')).toBe('harness');
    expect(taskIntentFromQuery({ intent: 'reminder' })).toBe('reminder');
    expect(taskIntentFromQuery({ intent: 'document' })).toBe('document');
    expect(taskIntentFromQuery({ intent: 'harness' })).toBeNull();
    expect(taskIntentFromQuery({ intent: ['document', 'reminder'] })).toBeNull();
    expect(taskIntentFromQuery({})).toBeNull();
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
