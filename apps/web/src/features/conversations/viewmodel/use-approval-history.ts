'use client';

import { useCallback, useEffect } from 'react';
import { ApprovalDetailSchema, DocumentApprovalDetailSchema } from '@along/contracts';
import type { ApprovalDetail, DocumentApprovalDetail } from '@along/contracts';
import { TaskDetailSchema } from '@/features/reminders/model/types';
import type { TaskDetail } from '@/features/reminders/model/types';
import { readEnvelope } from '@/shared/http/client';
import type { HistoryApprovalReference } from '../model/conversation-run';
import { inlineReminderWaiting } from '@/features/approvals/model/inline-reminder';
import { inlineDocumentWaiting } from '@/features/approvals/model/inline-document';
import type { ConversationTask } from './use-conversation-task';
import { useHistoryPage } from '@/shared/http/use-page';

type ApprovalHistoryDetail =
  | { kind: 'task'; detail: ApprovalDetail }
  | { kind: 'document'; detail: DocumentApprovalDetail };

export function useTaskHistoryResult(taskId: string) {
  const loader = useCallback(
    async (_cursor: string | null, signal: AbortSignal) => {
      const detail = TaskDetailSchema.parse(
        await readEnvelope(
          await fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store', signal }),
        ),
      );
      if (detail.task_id !== taskId) throw new Error('提醒结果引用不匹配；未确认结果。');
      return { items: [detail], nextCursor: null };
    },
    [taskId],
  );
  const { state, read } = useHistoryPage<TaskDetail>(`task:${taskId}`, loader);
  return { state, read, task: state.items[0] };
}

export interface ApprovalHistoryOptions {
  reference: HistoryApprovalReference;
  conversationId: string;
  runId: string;
  onUnknownEffect?: (approvalId: string, unknown: boolean) => void;
  task?: ConversationTask;
}

export function useApprovalHistory({
  reference,
  conversationId,
  runId,
  onUnknownEffect,
  task,
}: ApprovalHistoryOptions) {
  const { kind, approvalId } = reference;
  const path = `/${kind === 'document' ? 'document-approvals' : 'approvals'}/${encodeURIComponent(approvalId)}`;
  const query = new URLSearchParams({ conversation_id: conversationId, run_id: runId });
  const loader = useCallback(
    async (_cursor: string | null, signal: AbortSignal) => {
      const data = await readEnvelope(await fetch(`/api/v1${path}`, { cache: 'no-store', signal }));
      const item: ApprovalHistoryDetail =
        kind === 'document'
          ? { kind: 'document', detail: DocumentApprovalDetailSchema.parse(data) }
          : { kind: 'task', detail: ApprovalDetailSchema.parse(data) };
      if (item.detail.approval_id !== approvalId) throw new Error('批准引用不匹配；未确认结果。');
      if (
        item.kind === 'document' &&
        (item.detail.conversation_id !== conversationId || item.detail.run_id !== runId)
      )
        throw new Error('文档批准与原运行不匹配，未接纳此结果。');
      return { items: [item], nextCursor: null };
    },
    [path, kind, approvalId, conversationId, runId],
  );
  const { state, read } = useHistoryPage<ApprovalHistoryDetail>(`${kind}:${approvalId}`, loader);
  const loaded = state.items[0];
  const confirmed = task?.reminderResults[approvalId];
  const confirmedDocument = task?.documentResults[approvalId];
  const item =
    loaded?.kind === 'task' && confirmed
      ? { kind: 'task' as const, detail: confirmed }
      : loaded?.kind === 'document' && confirmedDocument
        ? {
            kind: 'document' as const,
            detail: { ...loaded.detail, state: confirmedDocument.state },
          }
        : loaded;
  const currentReminder = Boolean(
    task &&
    task.selected?.conversationId === conversationId &&
    task.selected.runId === runId &&
    inlineReminderWaiting(task.run, approvalId),
  );
  const currentDocument = Boolean(
    task &&
    task.selected?.conversationId === conversationId &&
    task.selected.runId === runId &&
    inlineDocumentWaiting(task.run, approvalId),
  );
  const documentError =
    task?.documentError?.approvalId === approvalId ? task.documentError.message : null;
  const confirmationError =
    task?.reminderError?.approvalId === approvalId ? task.reminderError.message : null;
  useEffect(() => {
    if (item?.kind === 'document')
      onUnknownEffect?.(approvalId, item.detail.effect.status === 'unknown');
  }, [item, approvalId, onUnknownEffect]);
  return {
    kind,
    approvalId,
    path,
    query,
    state,
    read,
    item,
    currentReminder,
    currentDocument,
    confirmationError,
    documentError,
  };
}
