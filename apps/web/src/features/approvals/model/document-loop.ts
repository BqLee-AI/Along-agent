import { DocumentApprovalConfirmBodySchema } from '@along/contracts';
import type { DocumentApprovalDetail, DocumentApprovalEffect } from '@along/contracts';

export function documentConfirmBody(detail: DocumentApprovalDetail, key: string) {
  return DocumentApprovalConfirmBodySchema.parse({
    presentation_hash: detail.presentation_hash,
    seen_content: detail.preview.body,
    idempotency_key: key,
  });
}

export function approvalHref(approvalId: string, cardId?: string): string {
  const document = cardId === `document-approval:${approvalId}`;
  return `/${document ? 'document-approvals' : 'approvals'}/${encodeURIComponent(approvalId)}`;
}

export function selectedWorkspace(execution: 'business' | 'harness', workspaceId: string) {
  return execution === 'harness' && workspaceId ? { workspace_id: workspaceId } : {};
}

export const documentEffectLabel: Record<DocumentApprovalEffect['status'], string> = {
  not_started: '尚未执行文件替换；批准只授权，不代表已保存。',
  reserved: '文件替换调用已预约，尚无已接受的写入结果。',
  unknown: '文件效果未知；可能已写入，不会自动重做。',
  failed: '文件替换未完成；没有成功保存的证据。',
  conflict: '写入前版本冲突，原替换未写入；后继提议需要新的批准。',
  applied: '已接受文件替换结果，尚无后续全文读取验证。',
  verified: '文件替换已接受，并已通过后续全文读取验证。',
};

export interface DocumentEffectRead {
  value: DocumentApprovalEffect | null;
  reading: boolean;
  error: string | null;
  current: boolean;
}
export type DocumentEffectReadAction =
  | { type: 'start' }
  | { type: 'invalidate' }
  | { type: 'success'; value: DocumentApprovalEffect }
  | { type: 'failure'; message: string };

// A decision receipt does not contain a new effect. Keep historical evidence
// separately, but never present it as the latest result after a failed read.
export function documentEffectReadReducer(
  state: DocumentEffectRead,
  action: DocumentEffectReadAction,
): DocumentEffectRead {
  switch (action.type) {
    case 'start':
      return { ...state, reading: true };
    case 'invalidate':
      return { ...state, current: false };
    case 'success':
      return { value: action.value, reading: false, error: null, current: true };
    case 'failure':
      return { ...state, reading: false, current: false, error: action.message };
  }
}
