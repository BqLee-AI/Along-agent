'use client';

import { useCallback, useState } from 'react';
import type { ApprovalDetail, DocumentApprovalDetail } from '@along/contracts';

type ApprovalError = { approvalId: string; message: string } | null;

/** The conversation owner validates identity and coordinates confirmation and resume. */
export function useConversationApprovalResults() {
  const [reminderResults, setReminderResults] = useState<Record<string, ApprovalDetail>>({});
  const [reminderError, setReminderError] = useState<ApprovalError>(null);
  const [documentResults, setDocumentResults] = useState<Record<string, DocumentApprovalDetail>>(
    {},
  );
  const [documentError, setDocumentError] = useState<ApprovalError>(null);
  const resetApprovalResults = useCallback(() => {
    setReminderResults({});
    setReminderError(null);
    setDocumentResults({});
    setDocumentError(null);
  }, []);
  return {
    reminderResults,
    setReminderResults,
    reminderError,
    setReminderError,
    documentResults,
    setDocumentResults,
    documentError,
    setDocumentError,
    resetApprovalResults,
  };
}
