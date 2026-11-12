'use client';

import { useMemo } from 'react';
import {
  conversationNeedsAction,
  conversationRunEntries,
  otherBlockingRuns,
} from '../model/presentation';
import type { ConversationContextProjection } from '../model/presentation';
import type { ConversationTask } from './use-conversation-task';

export function useConversationPresentation(task: ConversationTask) {
  const { selected, runs, run, effectsUnknown, streaming } = task;
  const entries = useMemo(() => conversationRunEntries(runs, selected), [runs, selected]);
  const blockedRuns = useMemo(() => otherBlockingRuns(runs, selected), [runs, selected]);
  const status = run?.status ?? null;
  const workspace = run?.workspace ?? null;
  const waiting = status === 'suspended_approval' || Boolean(run?.can_resume);
  const context = useMemo<ConversationContextProjection>(
    () => ({ selected, status, workspace, waiting, effectsUnknown, streaming }),
    [selected, status, workspace, waiting, effectsUnknown, streaming],
  );
  return {
    entries,
    blockedRuns,
    context,
    needsAction: conversationNeedsAction(run, effectsUnknown),
    showReminderResult: Object.keys(task.reminderResults).length > 0,
  };
}
