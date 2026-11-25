'use client';

import { useMemo } from 'react';
import {
  conversationNeedsAction,
  conversationRunEntries,
  otherBlockingRuns,
} from '../model/presentation';
import type { ConversationTask } from './use-conversation-task';

export function useConversationPresentation(task: ConversationTask) {
  const { selected, runs, run, effectsUnknown } = task;
  const entries = useMemo(
    () =>
      conversationRunEntries(runs, selected).filter(
        ({ runId }) =>
          task.transcript.get(runId)?.approvals.length ||
          (runId === selected?.runId && run?.waiting),
      ),
    [runs, selected, task.transcript, run?.waiting],
  );
  const blockedRuns = useMemo(() => otherBlockingRuns(runs, selected), [runs, selected]);
  return {
    entries,
    blockedRuns,
    needsAction: conversationNeedsAction(run, effectsUnknown),
    showReminderResult: Object.keys(task.reminderResults).length > 0,
  };
}
