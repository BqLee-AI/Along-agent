import { ApprovalDetailSchema } from '@along/contracts';
import type { ApprovalDetail, RunView } from '@along/contracts';
import { readEnvelope } from '@/shared/http/client';
import { api } from '@/shared/http/eden';
import { postReminderDecision, reminderActionBody } from '@/features/approvals/model/approval';

export function inlineReminderWaiting(run: RunView | null, approvalId?: string): boolean {
  return Boolean(
    run &&
    run.status === 'suspended_approval' &&
    run.waiting &&
    !('approval_kind' in run.waiting) &&
    (approvalId === undefined || run.waiting.approval_id === approvalId),
  );
}

export async function readInlineReminder(initial: ApprovalDetail, signal: AbortSignal) {
  const next = ApprovalDetailSchema.parse(
    await readEnvelope(
      await api.api.v1
        .approvals({ id: encodeURIComponent(initial.approval_id) })
        .get({ fetch: { signal } }),
    ),
  );
  if (
    next.approval_id !== initial.approval_id ||
    next.kind !== initial.kind ||
    next.presentation_hash !== initial.presentation_hash ||
    next.echo_text !== initial.echo_text
  )
    throw new Error('提议或冻结版本不匹配，未提交确认。');
  return next;
}

// Called only from the current user's confirmation click, never a read/effect.
export async function confirmInlineReminder({
  initial,
  run,
  csrf,
  signal,
}: {
  initial: ApprovalDetail;
  run: RunView;
  csrf: string | null;
  signal: AbortSignal;
}): Promise<ApprovalDetail> {
  if (!inlineReminderWaiting(run, initial.approval_id) || !run.waiting)
    throw new Error('这条提醒不是当前运行的等待点。');

  // An unknown response must be read before any same-key retry. Consumed means
  // approval already succeeded, not permission to confirm another proposal.
  const current = await readInlineReminder(initial, signal);
  if (current.status === 'consumed') return current;
  if (current.status !== 'pending') throw new Error('此提议已不可确认，请读取原决议。');
  // One approval confirmation has a stable UUID key across disconnect/reload,
  // without a second browser-side ledger.
  const body = reminderActionBody(current, 'confirm', current.approval_id, {
    raw_text: '',
    confirmed_timezone: current.snapshot.timezone_id,
    fold_choice: 'none',
  });
  const result = await postReminderDecision(current, 'confirm', body, csrf, signal);
  if (!('status' in result && result.status === 'consumed' && 'task_id' in result))
    throw new Error('确认回执无法核验，请读取原提议。');
  return { ...current, status: 'consumed', result: { ...current.result, task_id: result.task_id } };
}
