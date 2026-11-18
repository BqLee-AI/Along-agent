import { ApprovalStatusSchema, EnvelopeSchema } from '@along/contracts';
import type { ApprovalDetail } from '@along/contracts';
import { z } from 'zod';
import { ApiReadError } from '@/shared/http/client';
import { api, writeOptions } from '@/shared/http/eden';
import { requireClientSession } from '@/shared/session/navigation';

export const approvalStatusLabels = {
  pending: '待确认',
  consumed: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  superseded: '已被替代',
  all: '全部状态',
} as const;
export type ApprovalFilter = keyof typeof approvalStatusLabels;
export function approvalFilter(value: unknown): ApprovalFilter {
  return typeof value === 'string' && Object.hasOwn(approvalStatusLabels, value)
    ? (value as ApprovalFilter)
    : 'pending';
}

export interface ApprovalListItem {
  approval_id: string;
  title: string;
  status: string;
  expires_at: string;
  created_at: string;
}
export const ApprovalPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            approval_id: z.string().uuid(),
            title: z.string(),
            status: ApprovalStatusSchema,
            expires_at: z.string(),
            created_at: z.string(),
          })
          .strict(),
      )
      .max(50),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type ApprovalPage = z.infer<typeof ApprovalPageSchema>;
export type FoldChoice = 'first' | 'second' | 'none';
export interface RevisionInput {
  raw_text: string;
  confirmed_timezone: string;
  fold_choice: FoldChoice;
}
export type ReminderAction = 'confirm' | 'reject' | 'revise';
export type ReminderRequestBody =
  | { presentation_hash: string; seen_content: string; idempotency_key: string }
  | (RevisionInput & { idempotency_key: string })
  | { idempotency_key: string };
export const ReminderResultSchema = z.union([
  z
    .object({
      approval_id: z.string().uuid(),
      status: z.literal('consumed'),
      task_id: z.string().uuid(),
      duplicate: z.boolean(),
    })
    .strict(),
  z
    .object({
      approval_id: z.string().uuid(),
      status: z.literal('rejected'),
      duplicate: z.boolean(),
    })
    .strict(),
  z
    .object({
      approval_id: z.string().uuid(),
      successor_approval_id: z.string().uuid(),
      duplicate: z.boolean(),
    })
    .strict(),
]);
export function reminderActionBody(
  detail: ApprovalDetail,
  action: ReminderAction,
  key: string,
  revision: RevisionInput,
): ReminderRequestBody {
  if (action === 'confirm')
    return {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: key,
    };
  if (action === 'revise') return { ...revision, idempotency_key: key };
  return { idempotency_key: key };
}
export class ApprovalActionFailure extends ApiReadError {
  constructor(
    status: number,
    code: string | null,
    requestId: string | null,
    message: string,
    readonly details: unknown,
  ) {
    super(status, code, requestId, message);
  }
}
export async function postReminderDecision(
  detail: ApprovalDetail,
  action: ReminderAction,
  body: ReminderRequestBody,
  csrf: string | null,
  signal: AbortSignal,
) {
  const endpoint = api.api.v1.approvals({ id: encodeURIComponent(detail.approval_id) }).actions;
  const options = writeOptions(csrf, signal);
  const resultResponse =
    action === 'confirm' && 'presentation_hash' in body
      ? await endpoint.confirm.post(body, options)
      : action === 'revise' && 'raw_text' in body
        ? await endpoint.revise.post(body, options)
        : action === 'reject'
          ? await endpoint.reject.post({ idempotency_key: body.idempotency_key }, options)
          : null;
  if (!resultResponse) throw new Error('决议输入与操作不匹配。');
  const { response } = resultResponse;
  requireClientSession(response);
  const payload = EnvelopeSchema.parse(
    resultResponse.error ? resultResponse.error.value : resultResponse.data,
  );
  if (!response.ok || payload.code !== 0)
    throw new ApprovalActionFailure(
      response.status,
      payload.error?.code ?? null,
      payload.request_id,
      payload.error?.message ?? '请求失败。',
      payload.error?.details,
    );
  const result = ReminderResultSchema.parse(payload.data);
  if (
    result.approval_id !== detail.approval_id ||
    (action === 'confirm' && !('status' in result && result.status === 'consumed')) ||
    (action === 'reject' && !('status' in result && result.status === 'rejected')) ||
    (action === 'revise' && !('successor_approval_id' in result))
  )
    throw new Error('决议响应无法与本次提议核对，请读取原提议。');
  return result;
}
