import {
  DocumentApprovalActionResultSchema,
  DocumentApprovalDetailSchema,
  type DocumentApprovalDetail,
  type RunView,
} from '@along/contracts';
import { readEnvelope } from '@/shared/http/client';
import { api, writeOptions } from '@/shared/http/eden';
import { documentConfirmBody } from '@/features/approvals/model/document-loop';

export function inlineDocumentWaiting(run: RunView | null, approvalId: string): boolean {
  return Boolean(
    run?.authorization_revision === 'delegation/1' &&
    run.status === 'suspended_approval' &&
    run.waiting &&
    'approval_kind' in run.waiting &&
    run.waiting.approval_kind === 'document' &&
    run.waiting.approval_id === approvalId,
  );
}

// This read never makes a decision or resumes a run.
export async function readInlineDocument(initial: DocumentApprovalDetail, signal: AbortSignal) {
  const current = DocumentApprovalDetailSchema.parse(
    await readEnvelope(
      await api.api.v1['document-approvals']({ id: encodeURIComponent(initial.approval_id) }).get({
        fetch: { signal },
      }),
    ),
  );
  if (
    current.approval_id !== initial.approval_id ||
    current.conversation_id !== initial.conversation_id ||
    current.run_id !== initial.run_id ||
    current.workspace_id !== initial.workspace_id ||
    current.relative_path !== initial.relative_path ||
    current.base_version !== initial.base_version ||
    current.new_version !== initial.new_version ||
    current.presentation_hash !== initial.presentation_hash ||
    current.preview.body !== initial.preview.body ||
    current.preview.before !== initial.preview.before ||
    current.preview.after !== initial.preview.after ||
    current.exact_new_content !== initial.exact_new_content
  )
    throw new Error('文件目标或冻结预览已变化，未提交授权。');
  return current;
}

// Only invoked by the explicit click; the stable key permits reading a lost response.
export async function confirmInlineDocument({
  initial,
  run,
  csrf,
  signal,
}: {
  initial: DocumentApprovalDetail;
  run: RunView;
  csrf: string | null;
  signal: AbortSignal;
}): Promise<DocumentApprovalDetail> {
  if (
    !inlineDocumentWaiting(run, initial.approval_id) ||
    run.conversation_id !== initial.conversation_id ||
    run.run_id !== initial.run_id
  )
    throw new Error('文档批准不是当前运行的等待点。');
  const current = await readInlineDocument(initial, signal);
  if (current.state === 'approved') return current;
  if (current.state !== 'pending') throw new Error('此文档提议已不可授权，请读取原决议。');
  const result = DocumentApprovalActionResultSchema.parse(
    await readEnvelope(
      await api.api.v1['document-approvals']({
        id: encodeURIComponent(current.approval_id),
      }).actions.confirm.post(
        documentConfirmBody(current, current.approval_id),
        writeOptions(csrf, signal),
      ),
    ),
  );
  if (result.approval_id !== current.approval_id || result.status !== 'approved')
    throw new Error('授权回执无法核验，请读取原批准。');
  return { ...current, state: 'approved' };
}
